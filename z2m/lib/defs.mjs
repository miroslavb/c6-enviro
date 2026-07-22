// z2m/lib/defs.mjs
//
// PURE derivation layer for the Biometal C6-ENVIRO external converter.
//
// This module imports ONLY ./contract.generated.mjs (the codegen output of the
// single source of truth, contract/contract.json). It deliberately does NOT
// import zigbee-herdsman / zigbee-herdsman-converters so that it stays unit-
// testable with nothing but the Node standard library (see
// ../biometal_radiometer.test.mjs).
//
// Everything the real converter needs is *derived* from CONTRACT here, so the
// converter can never drift from the firmware: change contract.json -> rerun
// codegen -> this module (and the converter built on top of it) follow
// automatically.
//
// The device is an ESP32-C6 Super Mini + BME680 solar-battery sensor running
// as a deep-sleeping Zigbee end device. UP telemetry rides STANDARD clusters
// (T/RH/P/battery on EP1, genAnalogInput channels on EP2..EP5); the custom
// cluster 0xFC00 (biometalEnviro) carries DOWN config writes (report interval,
// gas-heater enable) plus readable diagnostics.
//
// What we expose to the converter:
//   1. buildCustomClusterDef(ZclDataType)  -> the object handed to
//      modernExtend's deviceAddCustomCluster(name, def).
//   2. buildUpDescriptors()                -> plain descriptors for the simple
//      read-only ("up") attributes (dose_rate/dose/cps/error_pct/hv = numeric,
//      alarm = binary, detector_serial/detector_fw = text). statusFlags is
//      handled separately (see 4) because it fans one attribute out into many
//      HA entities.
//   3. buildDownDescriptors()              -> descriptors for the writable
//      ("down") attributes (dose_rate_alarm, poll_interval_ms = numeric).
//   4. buildStatusFlagsDescriptor()        -> the statusFlags bitmask
//      descriptor: raw UINT16 value + the decoded status bits from the contract.
//
// NOTE on Zcl type names: contract.generated.mjs stores BOTH the symbolic ZCL
// type name (e.g. "SINGLE") on `attr.type` AND the numeric ZCL data-type value
// on `attr.zclType` (e.g. 57). The real converter needs the herdsman
// Zcl.DataType *value*; to keep this module pure we accept a name->value map
// (the herdsman Zcl.DataType enum, or our own Zcl_DataType export) as an
// argument to buildCustomClusterDef and resolve names through it.

import {CONTRACT, Zcl_DataType} from "./contract.generated.mjs";

// Re-export so consumers (converter + tests) have one import site.
export {CONTRACT, Zcl_DataType};

// The Espressif-assigned ZCL manufacturer code (0x131B / 4891). MUST be
// identical to what the firmware emits on the Basic cluster and on every
// manufacturer-specific custom-cluster read/write/report, or herdsman frames
// the write without the manufacturer bit set and the device answers
// "unsupported attribute" -> the read/write/report silently fails. Sourced from
// CONTRACT so firmware + converter + docs share one value.
export const MANUF = CONTRACT.manufacturerCode;

// zigbeeCommandOptions shorthand reused by every custom-cluster builder.
export const COMMAND_OPTIONS = {manufacturerCode: MANUF};

// Custom-cluster name + ID, straight from the contract.
export const CLUSTER_NAME = CONTRACT.cluster.name; // "biometalEnviro"
export const CLUSTER_ID = CONTRACT.cluster.id; // 0xFC00

// The bitmask attribute that fans out into multiple HA entities. Handled by its
// own builder, not the generic up-descriptor path.
export const STATUS_FLAGS_ATTR = "statusFlags";

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/**
 * Resolve a symbolic ZCL data-type name ("SINGLE", "UINT8", ...) to its numeric
 * value using a name->value map. Defaults to the generated Zcl_DataType table
 * so this module is fully usable without herdsman; the converter passes the
 * real herdsman `Zcl.DataType` so the registered cluster carries the exact
 * enum values herdsman expects.
 *
 * @param {string} typeName        e.g. "SINGLE"
 * @param {Record<string,number>} [typeMap=Zcl_DataType]
 * @returns {number}
 */
export function resolveZclType(typeName, typeMap = Zcl_DataType) {
  // The contract uses the ZCL-spec names; zigbee-herdsman's DataType enum names
  // a few of them differently (verified against zigbee-herdsman 5.x):
  //   SINGLE (0x39, float32) -> SINGLE_PREC ; DOUBLE (0x3a) -> DOUBLE_PREC.
  const HERDSMAN_ALIAS = {SINGLE: "SINGLE_PREC", DOUBLE: "DOUBLE_PREC"};
  let value = typeMap[typeName];
  if (typeof value !== "number" && HERDSMAN_ALIAS[typeName]) {
    value = typeMap[HERDSMAN_ALIAS[typeName]];
  }
  if (typeof value !== "number") {
    throw new Error(
      `defs.mjs: unknown ZCL data type '${typeName}' (not in supplied type map)`,
    );
  }
  return value;
}

/** All custom-cluster attributes, in contract order. */
export function attributes() {
  return CONTRACT.attributes;
}

/** The writable "down" attributes (HA -> device). */
export function downAttributes() {
  return CONTRACT.attributes.filter((a) => a.dir === "down");
}

/** The read-only "up" attributes (device -> HA). */
export function upAttributes() {
  return CONTRACT.attributes.filter((a) => a.dir === "up");
}

/**
 * Convert a camelCase contract attribute name to a snake_case HA-friendly name.
 * Only a fallback: the contract carries the canonical `expose` name and that is
 * used directly wherever present.
 *
 * @param {string} camel
 * @returns {string}
 */
export function exposeName(camel) {
  return camel.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/**
 * Decide which modernExtend builder an attribute maps to:
 *   - BOOLEAN   -> "binary"   (binary)
 *   - CHAR_STR  -> "text"     (text)
 *   - otherwise -> "numeric"  (numeric)
 *
 * @param {object} attr  a CONTRACT.attributes entry
 * @returns {"binary"|"text"|"numeric"}
 */
export function builderKind(attr) {
  if (attr.type === "BOOLEAN") return "binary";
  if (attr.type === "CHAR_STR") return "text";
  return "numeric";
}

// -------------------------------------------------------------------------
// (a) Custom-cluster definition for deviceAddCustomCluster
// -------------------------------------------------------------------------

/**
 * Build the ClusterDefinition object for
 *   deviceAddCustomCluster(CLUSTER_NAME, <this>).
 *
 * Every contract attribute becomes an entry in `attributes` keyed by its name,
 * with {ID, type, manufacturerCode}. We tag each attribute with the cluster
 * manufacturerCode so herdsman always frames reads/writes manufacturer-
 * specific (the whole cluster is in the 0xFC00-0xFFFF manufacturer range) AND
 * so herdsman can decode incoming manufacturer-specific reports by name/type.
 *
 * @param {Record<string,number>} [typeMap=Zcl_DataType]
 *        herdsman `Zcl.DataType` (preferred) or the generated table.
 * @returns {{ID:number, manufacturerCode:number,
 *            attributes:Record<string,{ID:number,type:number,manufacturerCode:number}>,
 *            commands:object, commandsResponse:object}}
 */
export function buildCustomClusterDef(typeMap = Zcl_DataType) {
  const attrs = {};
  for (const a of CONTRACT.attributes) {
    // v0.1.10: PLAIN attributes (no manufacturerCode). esp-zigbee's compat
    // layer registers custom-cluster attributes as non-manufacturer-specific,
    // so reports/writes are plain ZCL frames; a manufacturerCode here would
    // make herdsman skip these attrs when decoding plain frames.
    attrs[a.name] = {
      ID: a.id,
      type: resolveZclType(a.type, typeMap),
    };
  }
  return {
    ID: CLUSTER_ID,
    attributes: attrs,
    commands: {},
    commandsResponse: {},
  };
}

// -------------------------------------------------------------------------
// (b) Read-only "up" descriptors (excluding the statusFlags bitmask)
// -------------------------------------------------------------------------

/**
 * Attach the optional numeric metadata the contract carries, without ever
 * injecting `undefined` keys (some validators dislike them).
 *
 * @param {object} base  descriptor being built
 * @param {object} a     contract attribute
 */
function attachNumericMeta(base, a) {
  if (a.unit != null) base.unit = a.unit;
  if (a.scale != null) base.scale = a.scale;
  if (a.min != null) base.valueMin = a.min;
  if (a.max != null) base.valueMax = a.max;
}

/**
 * Build the list of read-only "up" descriptors for the simple telemetry
 * attributes. Excludes statusFlags (see buildStatusFlagsDescriptor). Each
 * descriptor is a plain, herdsman-free object the converter turns into a
 * modernExtend numeric()/binary()/text() call.
 *
 * Common fields:
 *   kind             "numeric" | "binary" | "text"
 *   name             HA expose name (from contract `expose`)
 *   attribute        contract attribute name (camelCase, matches cluster def)
 *   cluster          CLUSTER_NAME
 *   access           'STATE_GET' (reported up + manual read; never writable)
 *   reportable       whether firmware reports it (contract `report`)
 *   description      contract desc
 *   manufacturerCode MANUF (converter wraps as zigbeeCommandOptions)
 *
 * numeric-only fields: unit, scale, valueMin, valueMax
 * binary-only fields:  on / off  (['ON', 1] / ['OFF', 0])
 *
 * @returns {Array<object>}
 */
export function buildUpDescriptors() {
  return upAttributes()
    .filter((a) => a.name !== STATUS_FLAGS_ATTR)
    .map((a) => {
      const base = {
        kind: builderKind(a),
        name: a.expose ?? exposeName(a.name),
        attribute: a.name,
        cluster: CLUSTER_NAME,
        // v0.1.9: STATE only (reports). GET would make modernExtend register a
        // configure read-step that walks the broken endpoint->registry cluster
        // lookup in the Z2M addon ('no input cluster'). The device self-reports
        // every attr (device-side reporting config), so GET is redundant.
        access: "STATE",
        reportable: !!a.report,
        description: a.desc,
        manufacturerCode: MANUF,
      };

      if (base.kind === "numeric") {
        attachNumericMeta(base, a);
      } else if (base.kind === "binary") {
        // ZCL BOOLEAN decodes to 0/1 on the wire; present it as ON/OFF in HA.
        base.on = ["ON", 1];
        base.off = ["OFF", 0];
      }
      // "text" needs no extra fields; firmware caps length (serial<=8, fw<=32).

      return base;
    });
}

// -------------------------------------------------------------------------
// (c) Writable "down" descriptors
// -------------------------------------------------------------------------

/**
 * Build the list of writable "down" descriptors (HA -> device config). Both are
 * numeric: dose_rate_alarm (UINT32 nSv/h) and poll_interval_ms (UINT16 ms). The
 * converter maps each to a modernExtend numeric() with access 'ALL', so it
 * surfaces in HA as a settable number AND responds to
 * `zigbee2mqtt/<device>/set` JSON writes; the write goes out as a
 * manufacturer-specific ZCL write on attrs 0x0010 / 0x0011.
 *
 * @returns {Array<object>}
 */
export function buildDownDescriptors() {
  return downAttributes().map((a) => {
    const base = {
      kind: builderKind(a),
      name: a.expose ?? exposeName(a.name),
      attribute: a.name,
      cluster: CLUSTER_NAME,
      // v0.1.9: SET without GET — writes work; a GET-read configure step would
      // hit the same broken cluster lookup. Z2M keeps the last written value.
      access: "STATE_SET",
      description: a.desc,
      manufacturerCode: MANUF,
      optional: !!a.optional,
    };
    if (base.kind === "numeric") {
      attachNumericMeta(base, a);
    }
    return base;
  });
}

// -------------------------------------------------------------------------
// (d) statusFlags bitmask descriptor
// -------------------------------------------------------------------------

/**
 * Build the descriptor for the statusFlags attribute: a reportable UINT16
 * bitmask the firmware computes (detector error flags + link state + dose
 * alarm) and pushes to HA. The converter fans it out into:
 *   - a raw numeric `status_flags` value (STATE_GET, diagnostic), and
 *   - one read-only binary entity per contract status bit (hv_fault,
 *     tube_silent, ..., detector_offline, dose_alarm).
 *
 * Fields:
 *   name             "status_flags"
 *   attribute        "statusFlags"
 *   cluster          CLUSTER_NAME
 *   access           'STATE_GET'  (report + manual read; never settable)
 *   reportable       true
 *   description      contract desc
 *   manufacturerCode MANUF
 *   valueMin/valueMax 0..0xFFFF
 *   bits             [{name, bit, desc}, ...] in ascending bit order
 *
 * @returns {object}
 */
export function buildStatusFlagsDescriptor() {
  const a = CONTRACT.attributes.find((x) => x.name === STATUS_FLAGS_ATTR);
  if (!a) {
    throw new Error(`defs.mjs: contract has no '${STATUS_FLAGS_ATTR}' attribute`);
  }
  // CONTRACT.statusBits is an object keyed by bit-name; flatten to an array in
  // ascending bit order so the converter can iterate deterministically.
  const bits = Object.entries(CONTRACT.statusBits)
    .map(([name, meta]) => ({name, bit: meta.bit, desc: meta.desc}))
    .sort((x, y) => x.bit - y.bit);

  return {
    name: a.expose ?? exposeName(a.name), // "status_flags"
    attribute: a.name, // "statusFlags"
    cluster: CLUSTER_NAME,
    access: "STATE",
    reportable: !!a.report,
    description: a.desc,
    manufacturerCode: MANUF,
    valueMin: 0,
    valueMax: 0xffff,
    bits,
  };
}

// -------------------------------------------------------------------------
// (e) v0.2.0 Analog Input telemetry channels (standard-cluster UP-path)
// -------------------------------------------------------------------------

/**
 * Build the Analog Input channel table: one STANDARD genAnalogInput (0x000C)
 * endpoint per telemetry value, from CONTRACT.analogEndpoints.
 *
 * WHY standard clusters: the Z2M addon environment cannot decode INCOMING
 * custom-cluster frames — its endpoint→registry lookup loses the attached
 * cluster definition, `msg.cluster` arrives as undefined, and no fromZigbee
 * converter can match (proven live 2026-07-11: a statusFlags readResponse
 * surfaced as cluster 'undefined', data '{"undefined":256}', 'No converter
 * available'). genAnalogInput is decoded by herdsman's own standard
 * definitions — no registration involved, immune to that bug. The custom
 * cluster remains for DOWN config writes (outgoing framing works fine).
 *
 * Each channel:
 *   ep          Zigbee endpoint carrying the genAnalogInput server cluster
 *   attr        contract attribute name this channel mirrors (camelCase)
 *   name        HA expose name (contract `expose`)
 *   unit        engineering unit or null
 *   description contract desc
 *   integer     true when the mirrored attribute is an integer type (the
 *               float presentValue is rounded back on decode)
 *
 * @returns {Array<object>}
 */
export function buildAnalogChannels() {
  const byName = Object.fromEntries(CONTRACT.attributes.map((a) => [a.name, a]));
  return CONTRACT.analogEndpoints.map((c) => {
    const a = byName[c.attr];
    if (!a) {
      throw new Error(`defs.mjs: analogEndpoints references unknown attribute '${c.attr}'`);
    }
    return {
      ep: c.ep,
      attr: a.name,
      name: a.expose ?? exposeName(a.name),
      unit: a.unit ?? null,
      description: a.desc,
      integer: a.type !== "SINGLE",
    };
  });
}

// -------------------------------------------------------------------------
// Device identity (zigbeeModel / vendor / model / description)
// -------------------------------------------------------------------------

/**
 * Device identity block for the converter's top-level definition, derived from
 * CONTRACT.device. `zigbeeModel` matches the Basic-cluster modelId the firmware
 * reports.
 *
 * @returns {{zigbeeModel:string[], vendor:string, model:string, description:string}}
 */
export function buildDeviceIdentity() {
  const d = CONTRACT.device;
  return {
    zigbeeModel: [d.modelId], // Basic.modelId reported by firmware
    vendor: d.vendor, // Basic.manufacturerName ("Biometal")
    model: d.modelId, // "C6-ENVIRO"
    description: d.description,
  };
}
