// Zigbee2MQTT external converter for the Biometal C6-ENVIRO solar sensor.
//
// The device is a deep-sleeping Zigbee END DEVICE. Its interview surface stays
// at EP1..EP5. All wire traffic uses standard ZCL clusters:
//   EP1: T/RH/P/battery telemetry + Analog Output report interval + On/Off gas
//   EP2..5: Analog Input gas resistance / precise vbat / status / wake counter
//
// v0.1.11 retires the custom 0xFC00 control plane: ESP-Zigbee compat responds
// NOT_AUTHORIZED to custom READ_WRITE attributes. `report_interval_s` now writes
// genAnalogOutput.presentValue; `gas_enabled` uses genOnOff on/off commands.
import {
  identify,
  temperature,
  humidity,
  pressure,
  battery,
} from "zigbee-herdsman-converters/lib/modernExtend";
import * as exposes from "zigbee-herdsman-converters/lib/exposes";

import CONTRACT from "./lib/contract.generated.mjs";
import {
  buildAnalogChannels,
  buildStandardControls,
  buildStatusFlagsDescriptor,
  buildDeviceIdentity,
} from "./lib/defs.mjs";

const e = exposes.presets;
const ea = exposes.access;
const analogChannels = buildAnalogChannels();
const standardControls = buildStandardControls();
const statusFlags = buildStatusFlagsDescriptor();
const identity = buildDeviceIdentity();

function getEndpoint(entity, meta, epId, key) {
  const device = entity.getDevice ? entity.getDevice() : meta.device;
  const ep = device?.getEndpoint?.(epId);
  if (!ep) throw new Error(`endpoint ${epId} not found for '${key}'`);
  return ep;
}

function buildAnalogTelemetryExtend(channels, flags) {
  const byEp = Object.fromEntries(channels.map((c) => [c.ep, c]));
  const exposesList = [];
  for (const c of channels) {
    if (c.attr === flags.attribute) {
      exposesList.push(
        e.numeric(flags.name, ea.STATE)
          .withDescription(flags.description)
          .withValueMin(flags.valueMin)
          .withValueMax(flags.valueMax)
          .withCategory("diagnostic"),
      );
      for (const b of flags.bits) {
        exposesList.push(
          e.binary(b.name, ea.STATE, "ON", "OFF")
            .withDescription(b.desc)
            .withCategory("diagnostic"),
        );
      }
    } else {
      let ex = e.numeric(c.name, ea.STATE).withDescription(c.description);
      if (c.unit) ex = ex.withUnit(c.unit);
      if (c.attr === "wakeCount" || c.attr === "vbatMv") ex = ex.withCategory("diagnostic");
      exposesList.push(ex);
    }
  }

  const fromZigbee = [{
    cluster: "genAnalogInput",
    type: ["attributeReport", "readResponse"],
    convert: (model, msg) => {
      const c = byEp[msg.endpoint.ID];
      if (!c || msg.data == null || !("presentValue" in msg.data)) return;
      const value = Number(msg.data.presentValue);
      if (!Number.isFinite(value)) return;
      if (c.attr === flags.attribute) {
        const bits = Math.round(value);
        const payload = {[flags.name]: bits};
        for (const b of flags.bits) payload[b.name] = (bits & (1 << b.bit)) !== 0 ? "ON" : "OFF";
        return payload;
      }
      return {[c.name]: c.integer ? Math.round(value) : value};
    },
  }];

  const byName = Object.fromEntries(channels.map((c) => [c.name, c]));
  const toZigbee = [{
    key: channels.map((c) => c.name),
    convertGet: async (entity, key, meta) => {
      const c = byName[key];
      if (!c) return;
      await getEndpoint(entity, meta, c.ep, key).read("genAnalogInput", ["presentValue"]);
    },
  }];

  const configure = [async (device, coordinatorEndpoint) => {
    for (const c of channels) {
      const ep = device.getEndpoint(c.ep);
      if (!ep) continue;
      await ep.bind("genAnalogInput", coordinatorEndpoint);
      await ep.configureReporting("genAnalogInput", [{
        attribute: "presentValue",
        minimumReportInterval: 0,
        maximumReportInterval: 3600,
        reportableChange: 0,
      }]);
    }
  }];

  return {exposes: exposesList, fromZigbee, toZigbee, configure, isModernExtend: true};
}

function normalizeOnOff(value, key) {
  if (value === true || value === 1 || value === "1" || value === "ON" || value === "on") return true;
  if (value === false || value === 0 || value === "0" || value === "OFF" || value === "off") return false;
  throw new Error(`'${key}': expected ON or OFF`);
}

function boundedNumber(value, control) {
  // Z2M's UI can hand a numeric expose either as a scalar or as {value: N}.
  // Normalize both forms before validation so the radio path stays identical.
  const candidate = value !== null && typeof value === "object" && "value" in value
    ? value.value
    : value;
  let number = Number(candidate);
  if (!Number.isFinite(number)) throw new Error(`'${control.name}': not a number`);
  if (control.min != null && number < control.min) number = control.min;
  if (control.max != null && number > control.max) number = control.max;
  return Math.round(number);
}

function buildControlsExtend(controls) {
  const exposesList = controls.map((control) => {
    if (control.kind === "binary") {
      return e.binary(control.name, ea.STATE_SET, "ON", "OFF")
        .withDescription(control.description)
        .withCategory("config");
    }
    let ex = e.numeric(control.name, ea.STATE_SET)
      .withDescription(control.description)
      .withCategory("config");
    if (control.unit) ex = ex.withUnit(control.unit);
    if (control.min != null) ex = ex.withValueMin(control.min);
    if (control.max != null) ex = ex.withValueMax(control.max);
    return ex;
  });

  const fromZigbee = controls.map((control) => ({
    cluster: control.cluster,
    type: ["attributeReport", "readResponse"],
    convert: (model, msg) => {
      if (msg.endpoint.ID !== control.ep || msg.data == null || !(control.attribute in msg.data)) return;
      if (control.transport === "command") {
        return {[control.name]: msg.data[control.attribute] ? "ON" : "OFF"};
      }
      const value = Number(msg.data[control.attribute]);
      if (!Number.isFinite(value)) return;
      return {[control.name]: boundedNumber(value, control)};
    },
  }));

  const toZigbee = controls.map((control) => ({
    key: [control.name],
    convertSet: async (entity, key, value, meta) => {
      const ep = getEndpoint(entity, meta, control.ep, key);
      if (control.transport === "command") {
        const enabled = normalizeOnOff(value, key);
        await ep.command(control.cluster, enabled ? control.onCommand : control.offCommand, {});
        return {state: {[key]: enabled ? "ON" : "OFF"}};
      }
      const interval = boundedNumber(value, control);
      await ep.write(control.cluster, {[control.attribute]: interval});
      return {state: {[key]: interval}};
    },
    convertGet: async (entity, key, meta) => {
      await getEndpoint(entity, meta, control.ep, key).read(control.cluster, [control.attribute]);
    },
  }));

  const configure = [async (device) => {
    // Populate HA/Z2M state from NVS-backed standard attributes immediately
    // after the sleepy device's long interview window opens. This is a read,
    // not a write: it never resets either persisted control.
    for (const control of controls) {
      const ep = device.getEndpoint(control.ep);
      if (!ep) continue;
      await ep.read(control.cluster, [control.attribute]);
    }
  }];

  return {exposes: exposesList, fromZigbee, toZigbee, configure, isModernExtend: true};
}

const analogTelemetryExtend = buildAnalogTelemetryExtend(analogChannels, statusFlags);
const controlsExtend = buildControlsExtend(standardControls);

const definition = {
  zigbeeModel: identity.zigbeeModel,
  model: identity.model,
  vendor: identity.vendor,
  description: identity.description,
  extend: [
    identify(),
    temperature({reporting: {min: 0, max: 3600, change: 1}}),
    humidity({reporting: {min: 0, max: 3600, change: 10}}),
    pressure({reporting: {min: 0, max: 3600, change: 1}}),
    battery({
      voltage: true,
      percentageReporting: true,
      percentageReportingConfig: {min: 0, max: 3600, change: 1},
    }),
    analogTelemetryExtend,
    controlsExtend,
  ],
  meta: {multiEndpoint: false},
};

export {CONTRACT, analogTelemetryExtend, analogChannels, controlsExtend, standardControls};
export default definition;
