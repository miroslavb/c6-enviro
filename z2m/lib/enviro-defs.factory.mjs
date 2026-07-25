// Contract-agnostic derivation factory for C6-ENVIRO Z2M definitions.
//
// The external-converters directory is shared with sibling projects. Keep the
// logic here independent of a filename so both the repository's generic test
// module and the deployed enviro-prefixed module bind to their own contract.
export function createDefinitions(CONTRACT) {
  const STATUS_FLAGS_ATTR = "statusFlags";

  function attributes() {
    return CONTRACT.attributes;
  }

  function downAttributes() {
    return attributes().filter((attribute) => attribute.dir === "down");
  }

  function upAttributes() {
    return attributes().filter((attribute) => attribute.dir === "up");
  }

  function exposeName(camel) {
    return camel.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  }

  function builderKind(attribute) {
    if (attribute.type === "BOOLEAN") return "binary";
    if (attribute.type === "CHAR_STR") return "text";
    return "numeric";
  }

  function buildStandardControls() {
    const byAttr = Object.fromEntries(attributes().map((attribute) => [attribute.name, attribute]));
    return CONTRACT.standardControls.map((control) => {
      const attribute = byAttr[control.attr];
      if (!attribute) throw new Error(`standardControls references unknown attr '${control.attr}'`);
      if (attribute.dir !== "down") throw new Error(`standard control '${control.attr}' is not writable`);
      if (control.name !== (attribute.expose ?? exposeName(attribute.name))) {
        throw new Error(`standard control '${control.attr}' does not match its expose`);
      }
      return {
        ...control,
        kind: builderKind(attribute),
        type: attribute.type,
        unit: attribute.unit ?? null,
        min: attribute.min ?? null,
        max: attribute.max ?? null,
        default: attribute.default ?? null,
        description: attribute.desc,
      };
    });
  }

  function buildStatusFlagsDescriptor() {
    const attribute = attributes().find((candidate) => candidate.name === STATUS_FLAGS_ATTR);
    if (!attribute) throw new Error(`contract has no '${STATUS_FLAGS_ATTR}' field`);
    const bits = Object.entries(CONTRACT.statusBits)
      .map(([name, meta]) => ({name, bit: meta.bit, desc: meta.desc}))
      .sort((a, b) => a.bit - b.bit);
    return {
      name: attribute.expose ?? exposeName(attribute.name),
      attribute: attribute.name,
      description: attribute.desc,
      valueMin: 0,
      valueMax: 0xffff,
      bits,
    };
  }

  function buildAnalogChannels() {
    const byAttr = Object.fromEntries(attributes().map((attribute) => [attribute.name, attribute]));
    return CONTRACT.analogEndpoints.map((channel) => {
      const attribute = byAttr[channel.attr];
      if (!attribute) throw new Error(`analogEndpoints references unknown attr '${channel.attr}'`);
      return {
        ep: channel.ep,
        attr: attribute.name,
        name: attribute.expose ?? exposeName(attribute.name),
        unit: attribute.unit ?? null,
        description: attribute.desc,
        integer: attribute.type !== "SINGLE",
      };
    });
  }

  function buildDeviceIdentity() {
    const device = CONTRACT.device;
    return {
      zigbeeModel: [device.modelId],
      vendor: device.vendor,
      model: device.modelId,
      description: device.description,
    };
  }

  return {
    STATUS_FLAGS_ATTR,
    attributes,
    downAttributes,
    upAttributes,
    exposeName,
    builderKind,
    buildStandardControls,
    buildStatusFlagsDescriptor,
    buildAnalogChannels,
    buildDeviceIdentity,
  };
}
