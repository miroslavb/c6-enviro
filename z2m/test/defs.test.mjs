// Pure unit tests for z2m/lib/defs.mjs — no herdsman imports, Node stdlib only.
// Run: node --test test/   (or `npm test`)
import test from "node:test";
import assert from "node:assert/strict";

import {
  CONTRACT,
  Zcl_DataType,
  MANUF,
  CLUSTER_NAME,
  CLUSTER_ID,
  resolveZclType,
  upAttributes,
  downAttributes,
  builderKind,
  buildCustomClusterDef,
  buildDownDescriptors,
  buildStatusFlagsDescriptor,
  buildAnalogChannels,
  buildDeviceIdentity,
} from "../lib/defs.mjs";

test("contract identity", () => {
  assert.equal(MANUF, 0x131b);
  assert.equal(CLUSTER_NAME, "biometalEnviro");
  assert.equal(CLUSTER_ID, 0xfc00);
  assert.equal(CONTRACT.device.modelId, "C6-ENVIRO");
  assert.equal(CONTRACT.device.powerSource, 3); // battery
});

test("attribute split: up diagnostics vs down config", () => {
  const up = upAttributes().map((a) => a.name);
  const down = downAttributes().map((a) => a.name);
  assert.deepEqual(down, ["reportIntervalS", "gasEnabled"]);
  for (const want of ["statusFlags", "wakeCount", "vbatMv", "awakeMs", "gasResistance", "tempC", "humidityPct", "pressureKpa"]) {
    assert.ok(up.includes(want), `up attr '${want}' missing`);
  }
});

test("builderKind maps types", () => {
  assert.equal(builderKind({type: "BOOLEAN"}), "binary");
  assert.equal(builderKind({type: "UINT16"}), "numeric");
  assert.equal(builderKind({type: "SINGLE"}), "numeric");
});

test("custom cluster def resolves ZCL types", () => {
  const def = buildCustomClusterDef(Zcl_DataType);
  assert.equal(def.ID, 0xfc00);
  assert.equal(def.attributes.reportIntervalS.ID, 0x0010);
  assert.equal(def.attributes.reportIntervalS.type, Zcl_DataType.UINT16);
  assert.equal(def.attributes.gasEnabled.ID, 0x0011);
  assert.equal(def.attributes.gasEnabled.type, Zcl_DataType.BOOLEAN);
  assert.equal(def.attributes.gasResistance.type, Zcl_DataType.SINGLE);
});

test("resolveZclType handles herdsman SINGLE_PREC alias", () => {
  assert.equal(resolveZclType("SINGLE", {SINGLE_PREC: 57}), 57);
  assert.throws(() => resolveZclType("NOPE", {}));
});

test("down descriptors carry range + set-only access", () => {
  const d = buildDownDescriptors();
  const interval = d.find((x) => x.name === "report_interval_s");
  assert.ok(interval);
  assert.equal(interval.access, "STATE_SET");
  assert.equal(interval.valueMin, 3);
  assert.equal(interval.valueMax, 3600);
  assert.equal(interval.unit, "s");
  const gas = d.find((x) => x.name === "gas_enabled");
  assert.ok(gas);
  assert.equal(gas.kind, "binary");
});

test("status flags descriptor fans out the contract bits", () => {
  const f = buildStatusFlagsDescriptor();
  assert.equal(f.name, "status_flags");
  const names = f.bits.map((b) => b.name);
  assert.deepEqual(names, [
    "sensor_error", "heater_unstable", "battery_low",
    "vbat_invalid", "gas_disabled", "first_boot",
  ]);
  assert.deepEqual(f.bits.map((b) => b.bit), [0, 1, 2, 3, 4, 5]);
});

test("analog channels: EP2..EP5, wake_count integer, gas float", () => {
  const ch = buildAnalogChannels();
  assert.deepEqual(ch.map((c) => c.ep), [2, 3, 4, 5, 6, 7, 8]);
  const gas = ch.find((c) => c.attr === "gasResistance");
  assert.equal(gas.name, "gas_resistance");
  assert.equal(gas.integer, false);  // SINGLE
  const wake = ch.find((c) => c.attr === "wakeCount");
  assert.equal(wake.integer, true);  // UINT32 rides the float, rounded back
});

test("device identity block", () => {
  const id = buildDeviceIdentity();
  assert.deepEqual(id.zigbeeModel, ["C6-ENVIRO"]);
  assert.equal(id.vendor, "Biometal");
});
