// Pure derivation layer for the C6-ENVIRO Z2M external converter.
//
// The v3 contract deliberately has no manufacturer-specific custom cluster on
// the wire: ESP-Zigbee compat rejects custom READ_WRITE attributes with
// NOT_AUTHORIZED. Every descriptor below derives from standard transport data
// in contract.generated.mjs and remains Node-stdlib-testable.
import {CONTRACT, Zcl_DataType} from "./contract.generated.mjs";

export {CONTRACT, Zcl_DataType};

export const STATUS_FLAGS_ATTR = "statusFlags";

export function attributes() {
  return CONTRACT.attributes;
}

export function downAttributes() {
  return attributes().filter((a) => a.dir === "down");
}

export function upAttributes() {
  return attributes().filter((a) => a.dir === "up");
}

export function exposeName(camel) {
  return camel.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

export function builderKind(attr) {
  if (attr.type === "BOOLEAN") return "binary";
  if (attr.type === "CHAR_STR") return "text";
  return "numeric";
}

// Standard ZCL control descriptors. Each control references a down-field in
// the domain model, adds its standard wire mapping, and carries expose/range
// metadata for the converter without duplicating contract values.
export function buildStandardControls() {
  const byAttr = Object.fromEntries(attributes().map((a) => [a.name, a]));
  return CONTRACT.standardControls.map((control) => {
    const attr = byAttr[control.attr];
    if (!attr) throw new Error(`standardControls references unknown attr '${control.attr}'`);
    if (attr.dir !== "down") throw new Error(`standard control '${control.attr}' is not writable`);
    if (control.name !== (attr.expose ?? exposeName(attr.name))) {
      throw new Error(`standard control '${control.attr}' does not match its expose`);
    }
    return {
      ...control,
      kind: builderKind(attr),
      type: attr.type,
      unit: attr.unit ?? null,
      min: attr.min ?? null,
      max: attr.max ?? null,
      default: attr.default ?? null,
      description: attr.desc,
    };
  });
}

export function buildStatusFlagsDescriptor() {
  const attr = attributes().find((a) => a.name === STATUS_FLAGS_ATTR);
  if (!attr) throw new Error(`contract has no '${STATUS_FLAGS_ATTR}' field`);
  const bits = Object.entries(CONTRACT.statusBits)
    .map(([name, meta]) => ({name, bit: meta.bit, desc: meta.desc}))
    .sort((a, b) => a.bit - b.bit);
  return {
    name: attr.expose ?? exposeName(attr.name),
    attribute: attr.name,
    description: attr.desc,
    valueMin: 0,
    valueMax: 0xffff,
    bits,
  };
}

export function buildAnalogChannels() {
  const byAttr = Object.fromEntries(attributes().map((a) => [a.name, a]));
  return CONTRACT.analogEndpoints.map((channel) => {
    const attr = byAttr[channel.attr];
    if (!attr) throw new Error(`analogEndpoints references unknown attr '${channel.attr}'`);
    return {
      ep: channel.ep,
      attr: attr.name,
      name: attr.expose ?? exposeName(attr.name),
      unit: attr.unit ?? null,
      description: attr.desc,
      integer: attr.type !== "SINGLE",
    };
  });
}

export function buildDeviceIdentity() {
  const d = CONTRACT.device;
  return {
    zigbeeModel: [d.modelId],
    vendor: d.vendor,
    model: d.modelId,
    description: d.description,
  };
}
