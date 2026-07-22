// z2m/biometal_enviro.mjs
//
// Zigbee2MQTT external converter for the Biometal C6-ENVIRO sensor:
// ESP32-C6 Super Mini + BME680 + Waveshare Solar Power Manager, running as a
// deep-sleeping Zigbee END DEVICE (default cycle: 3 s).
//
// ─────────────────────────────────────────────────────────────────────────
//  ARCHITECTURE (inherited from the proven c6-radiometer standard-cluster
//  pivot — see that repo's converter header for the full war story)
//
//  UP (device → HA): telemetry rides STANDARD clusters only:
//    EP1  msTemperatureMeasurement / msRelativeHumidity /
//         msPressureMeasurement / genPowerCfg  → temperature, humidity,
//         pressure, battery %, battery voltage
//    EP2  genAnalogInput presentValue → gas_resistance (Ω)
//    EP3  genAnalogInput presentValue → vbat_mv (precise battery mV)
//    EP4  genAnalogInput presentValue → status_flags (+ per-bit binaries)
//    EP5  genAnalogInput presentValue → wake_count (increments every cycle —
//         proof of life at the 3 s cadence even when the air is static)
//
//  WHY: the Z2M addon environment cannot decode INCOMING custom-cluster
//  frames (endpoint→registry lookup loses the attached cluster; msg.cluster
//  arrives undefined; no fz converter matches — proven live 2026-07-11).
//
//  DOWN (HA → device): config writes ride the custom cluster 0xFC00
//  (biometalEnviro): report_interval_s (0x0010), gas_enabled (0x0011).
//  The device picks writes up on its next parent poll (it polls every wake
//  cycle), persists them to NVS, and applies them from the next cycle.
//
//  SLEEPY DEVICE NOTES:
//  * Pair with the flasher's guidance: open permit-join, power the board; the
//    device stays awake 5 minutes after the first join so the interview can
//    complete. To wake a sleeping device for re-configuration press BOOT
//    briefly (it stays awake another 5 minutes).
//  * Availability: Z2M treats the device as passive (battery); it must check
//    in at least every 25 h — at a 3 s..1 h report interval it always does.
// ─────────────────────────────────────────────────────────────────────────
//
//  IMPORTANT: this file is assembled PROGRAMMATICALLY from the byte-contract.
//  Endpoints, attribute IDs/types, units, ranges and the device identity come
//  from contract.generated.mjs (codegen output of contract/contract.json) via
//  the pure helpers in ./lib/defs.mjs — the converter cannot drift from the
//  firmware. To change the wire format, edit contract/contract.json, rerun
//  codegen, and this follows.
//
//  Install: drop this file plus ./lib/ into Zigbee2MQTT's
//  `external_converters/` folder, set `advanced.enable_external_js: true`
//  (Z2M >= 2.11.0) and `homeassistant: true`, restart Z2M and pair (or
//  re-interview) the device.

import {Zcl} from "zigbee-herdsman";
import {
  deviceAddCustomCluster,
  identify,
  temperature,
  humidity,
  pressure,
  battery,
  numeric,
  binary,
} from "zigbee-herdsman-converters/lib/modernExtend";
import * as exposes from "zigbee-herdsman-converters/lib/exposes";

import CONTRACT from "./lib/contract.generated.mjs";
import {
  CLUSTER_NAME,
  COMMAND_OPTIONS,
  buildCustomClusterDef,
  buildAnalogChannels,
  buildDownDescriptors,
  buildStatusFlagsDescriptor,
  buildDeviceIdentity,
} from "./lib/defs.mjs";

const e = exposes.presets;
const ea = exposes.access;

// Custom cluster definition — registered so DOWN writes frame correctly.
const customClusterDef = buildCustomClusterDef(Zcl.DataType);

// Pure contract-derived descriptors.
const analogChannels = buildAnalogChannels();
const downDescriptors = buildDownDescriptors();
const statusFlags = buildStatusFlagsDescriptor();
const identity = buildDeviceIdentity();

// ---------------------------------------------------------------------------
//  UP: Analog Input telemetry — one ModernExtend for all channels.
//  status_flags additionally fans out into one read-only binary per contract
//  status bit (sensor_error, heater_unstable, battery_low, ...).
// ---------------------------------------------------------------------------
function buildAnalogTelemetryExtend(channels, flags) {
  const byEp = Object.fromEntries(channels.map((c) => [c.ep, c]));

  const exposesList = [];
  for (const c of channels) {
    if (c.attr === flags.attribute) {
      exposesList.push(
        e
          .numeric(flags.name, ea.STATE)
          .withDescription(flags.description)
          .withValueMin(flags.valueMin)
          .withValueMax(flags.valueMax)
          .withCategory("diagnostic"),
      );
      for (const b of flags.bits) {
        exposesList.push(
          e
            .binary(b.name, ea.STATE, "ON", "OFF")
            .withDescription(b.desc)
            .withCategory("diagnostic"),
        );
      }
    } else {
      let ex = e.numeric(c.name, ea.STATE).withDescription(c.description);
      if (c.unit) ex = ex.withUnit(c.unit);
      if (c.attr === "wakeCount" || c.attr === "vbatMv") {
        ex = ex.withCategory("diagnostic");
      }
      exposesList.push(ex);
    }
  }

  const fromZigbee = [
    {
      cluster: "genAnalogInput",
      type: ["attributeReport", "readResponse"],
      convert: (model, msg /* , publish, options, meta */) => {
        const c = byEp[msg.endpoint.ID];
        if (!c) return;
        if (msg.data == null || !("presentValue" in msg.data)) return;
        const v = Number(msg.data.presentValue);
        if (!Number.isFinite(v)) return;

        if (c.attr === flags.attribute) {
          const value = Math.round(v);
          const payload = {[flags.name]: value};
          for (const b of flags.bits) {
            payload[b.name] = (value & (1 << b.bit)) !== 0 ? "ON" : "OFF";
          }
          return payload;
        }
        return {[c.name]: c.integer ? Math.round(v) : v};
      },
    },
  ];

  // Manual refresh: `zigbee2mqtt/<device>/get {"gas_resistance": ""}`.
  // Note: reaches a sleepy device on its next wake/poll.
  const byName = Object.fromEntries(channels.map((c) => [c.name, c]));
  const toZigbee = [
    {
      key: channels.map((c) => c.name),
      convertGet: async (entity, key, meta) => {
        const c = byName[key];
        if (!c) return;
        const device = entity.getDevice ? entity.getDevice() : meta.device;
        const ep = device.getEndpoint(c.ep);
        if (!ep) throw new Error(`endpoint ${c.ep} not found for '${key}'`);
        await ep.read("genAnalogInput", ["presentValue"]);
      },
    },
  ];

  // Coordinator-side reporting config (standard cluster — resolves fine in the
  // addon). The firmware also self-configures reporting device-side, so this
  // is belt-and-braces; it runs during the interview while the device is in
  // its 5-minute stay-awake window.
  const configure = [
    async (device, coordinatorEndpoint) => {
      for (const c of channels) {
        const ep = device.getEndpoint(c.ep);
        if (!ep) continue;
        await ep.bind("genAnalogInput", coordinatorEndpoint);
        await ep.configureReporting("genAnalogInput", [
          {
            attribute: "presentValue",
            minimumReportInterval: 0,       // sleepy device: report on wake
            maximumReportInterval: 3600,
            reportableChange: 0,            // analog: 0 = report every change
          },
        ]);
      }
    },
  ];

  return {
    exposes: exposesList,
    fromZigbee,
    toZigbee,
    configure,
    isModernExtend: true,
  };
}

const analogTelemetryExtend = buildAnalogTelemetryExtend(analogChannels, statusFlags);

// ---------------------------------------------------------------------------
//  DOWN: writable config on the custom cluster (STATE_SET — a read-back would
//  walk the broken incoming path; Z2M keeps the last written value as state).
// ---------------------------------------------------------------------------
function downToExtend(d) {
  if (d.kind === "binary") {
    return binary({
      name: d.name,
      cluster: d.cluster,
      attribute: d.attribute,
      valueOn: ["ON", 1],
      valueOff: ["OFF", 0],
      access: d.access, // 'STATE_SET'
      description: d.description,
      zigbeeCommandOptions: {}, // plain ZCL frames
      entityCategory: "config",
    });
  }
  const args = {
    name: d.name,
    cluster: d.cluster,
    attribute: d.attribute,
    access: d.access, // 'STATE_SET'
    description: d.description,
    zigbeeCommandOptions: {},
    entityCategory: "config",
  };
  if (d.unit !== undefined && d.unit !== null) args.unit = d.unit;
  if (d.valueMin !== undefined) args.valueMin = d.valueMin;
  if (d.valueMax !== undefined) args.valueMax = d.valueMax;
  return numeric(args);
}

// ---------------------------------------------------------------------------
//  Assemble the definition.
// ---------------------------------------------------------------------------
const definition = {
  zigbeeModel: identity.zigbeeModel, // Basic.modelId reported by firmware
  model: identity.model, // "C6-ENVIRO"
  vendor: identity.vendor, // "Biometal"
  description: identity.description,
  extend: [
    // Register the custom cluster (DOWN writes need its attribute defs).
    deviceAddCustomCluster(CLUSTER_NAME, customClusterDef),

    // Standard EP1 sensors — zero custom glue:
    // firmware reports °C×100 / %×100 / hPa / 0.5 %-units, matching the
    // modernExtend scales (100 / 100 / 10-to-kPa / divide-by-2).
    //
    // REPORTING OVERRIDES (found live 2026-07-23): the modernExtend defaults
    // are built for mains devices — temperature min 10 s / change 1 °C,
    // pressure change 5 kPa, battery min 1 HOUR. A deep-sleeping 3 s reporter
    // is awake ~2.5 s per cycle: a min-interval above 0 or a coarse delta
    // silently freezes the entity at its interview-time value (battery sat at
    // a stale 100 % for half an hour). min=0 / tiny delta => the changed value
    // leaves within the flush window of the same wake.
    identify(),
    temperature({reporting: {min: 0, max: 3600, change: 1}}),   // 0.01 °C
    humidity({reporting: {min: 0, max: 3600, change: 10}}),     // 0.1 %
    pressure({reporting: {min: 0, max: 3600, change: 1}}),      // 1 hPa
    battery({
      voltage: true,
      percentageReporting: true,
      percentageReportingConfig: {min: 0, max: 3600, change: 1}, // 0.5 %
    }),

    // UP: gas resistance, precise vbat, status bits, wake counter (AI EPs).
    analogTelemetryExtend,

    // DOWN: report_interval_s + gas_enabled.
    ...downDescriptors.map(downToExtend),
  ],
  meta: {multiEndpoint: false},
};

// Named exports for tests/debugging.
export const manufacturerCode = COMMAND_OPTIONS.manufacturerCode;
export {CONTRACT, analogTelemetryExtend, analogChannels};

export default definition;
