// Smoke test for the REAL converter (biometal_enviro.mjs) against the
// installed zigbee-herdsman-converters (^26). Verifies the definition loads,
// identity matches the contract, the exposes include the environment +
// battery + config entities, and the Analog Input fromZigbee decoder maps
// endpoints to channels and fans the status bitmask out correctly.
// Run: node --test test/   (or `npm test`)
import test from "node:test";
import assert from "node:assert/strict";

test("converter loads and exposes the enviro entities", async () => {
  const mod = await import("../biometal_enviro.mjs");
  const def = mod.default;

  assert.deepEqual(def.zigbeeModel, ["C6-ENVIRO"]);
  assert.equal(def.vendor, "Biometal");
  assert.equal(mod.manufacturerCode, 0x131b);
  assert.ok(Array.isArray(def.extend) && def.extend.length > 6, "modernExtend list present");

  const names = new Set();
  for (const ext of def.extend) {
    for (const ex of ext.exposes ?? []) {
      if (typeof ex === "object" && ex?.name) names.add(ex.name);
      if (typeof ex === "object" && ex?.property) names.add(ex.property);
    }
  }
  for (const want of [
    // standard EP1
    "temperature", "humidity", "pressure", "battery", "voltage",
    // AI channels
    "gas_resistance", "vbat_mv", "wake_count",
    // status fan-out
    "status_flags", "sensor_error", "heater_unstable", "battery_low",
    "vbat_invalid", "gas_disabled", "first_boot",
    // down config
    "report_interval_s", "gas_enabled",
  ]) {
    assert.ok(names.has(want), `expose '${want}' missing (have: ${[...names].join(", ")})`);
  }
});

test("analog telemetry decoder maps endpoints to channels", async () => {
  const mod = await import("../biometal_enviro.mjs");
  const fz = mod.analogTelemetryExtend.fromZigbee[0];
  assert.equal(fz.cluster, "genAnalogInput");

  // EP2 = gas_resistance (float passes through untouched)
  assert.deepEqual(
    fz.convert(null, {endpoint: {ID: 2}, cluster: "genAnalogInput", type: "attributeReport", data: {presentValue: 51234.5}}),
    {gas_resistance: 51234.5},
  );
  // EP3 = vbat_mv (integer channel -> rounded)
  assert.deepEqual(
    fz.convert(null, {endpoint: {ID: 3}, cluster: "genAnalogInput", type: "readResponse", data: {presentValue: 4071.9}}),
    {vbat_mv: 4072},
  );
  // EP5 = wake_count
  assert.deepEqual(
    fz.convert(null, {endpoint: {ID: 5}, cluster: "genAnalogInput", type: "attributeReport", data: {presentValue: 28801}}),
    {wake_count: 28801},
  );
  // Unknown endpoint -> undefined (no crash)
  assert.equal(
    fz.convert(null, {endpoint: {ID: 9}, cluster: "genAnalogInput", type: "attributeReport", data: {presentValue: 1}}),
    undefined,
  );
  // Missing presentValue -> undefined
  assert.equal(
    fz.convert(null, {endpoint: {ID: 2}, cluster: "genAnalogInput", type: "attributeReport", data: {}}),
    undefined,
  );
});

test("status_flags fans out into per-bit binaries", async () => {
  const mod = await import("../biometal_enviro.mjs");
  const fz = mod.analogTelemetryExtend.fromZigbee[0];

  // EP4 = status_flags. 0b100101 = sensor_error + battery_low + first_boot.
  const payload = fz.convert(null, {
    endpoint: {ID: 4}, cluster: "genAnalogInput", type: "attributeReport",
    data: {presentValue: 0b100101},
  });
  assert.equal(payload.status_flags, 0b100101);
  assert.equal(payload.sensor_error, "ON");
  assert.equal(payload.heater_unstable, "OFF");
  assert.equal(payload.battery_low, "ON");
  assert.equal(payload.vbat_invalid, "OFF");
  assert.equal(payload.gas_disabled, "OFF");
  assert.equal(payload.first_boot, "ON");

  // All clear.
  const clear = fz.convert(null, {
    endpoint: {ID: 4}, cluster: "genAnalogInput", type: "attributeReport",
    data: {presentValue: 0},
  });
  assert.equal(clear.status_flags, 0);
  assert.equal(clear.sensor_error, "OFF");
});
