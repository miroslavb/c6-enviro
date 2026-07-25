// Pure unit tests for z2m/lib/defs.mjs — Node stdlib only.
import test from "node:test";
import assert from "node:assert/strict";
import {existsSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const converterSource = readFileSync(join(ROOT, "z2m/biometal_enviro.mjs"), "utf8");
const enviroDefsSource = readFileSync(join(ROOT, "z2m/lib/enviro-defs.mjs"), "utf8");

import {
  CONTRACT,
  upAttributes,
  downAttributes,
  builderKind,
  buildStandardControls,
  buildStatusFlagsDescriptor,
  buildAnalogChannels,
  buildDeviceIdentity,
} from "../lib/defs.mjs";

test("contract identity and standard-only wire rule", () => {
  assert.equal(CONTRACT.device.modelId, "C6-ENVIRO");
  assert.equal(CONTRACT.device.powerSource, 3);
  assert.equal("cluster" in CONTRACT, false, "no custom cluster may be registered on the wire");
});

test("attribute split keeps two writable configuration fields", () => {
  assert.deepEqual(downAttributes().map((a) => a.name), ["reportIntervalS", "gasEnabled"]);
  for (const name of ["statusFlags", "wakeCount", "vbatMv", "awakeMs", "gasResistance"]) {
    assert.ok(upAttributes().some((a) => a.name === name), `up field '${name}' missing`);
  }
});

test("builderKind maps field types", () => {
  assert.equal(builderKind({type: "BOOLEAN"}), "binary");
  assert.equal(builderKind({type: "UINT16"}), "numeric");
  assert.equal(builderKind({type: "SINGLE"}), "numeric");
});

test("standard controls preserve EP1..EP5 while mapping each down field", () => {
  const controls = buildStandardControls();
  assert.deepEqual(controls.map((c) => c.ep), [1, 1]);
  assert.deepEqual(controls.map((c) => c.cluster), ["genAnalogOutput", "genOnOff"]);
  assert.deepEqual(controls.map((c) => c.name), ["report_interval_s", "gas_enabled"]);
  assert.deepEqual(controls.map((c) => c.transport), ["write", "command"]);
  assert.equal(controls[0].min, 3);
  assert.equal(controls[0].max, 3600);
  assert.equal(controls[1].onCommand, "on");
  assert.equal(controls[1].offCommand, "off");
});

test("status flags descriptor fans out contract bits", () => {
  const descriptor = buildStatusFlagsDescriptor();
  assert.equal(descriptor.name, "status_flags");
  assert.deepEqual(descriptor.bits.map((b) => b.name), [
    "sensor_error", "heater_unstable", "battery_low",
    "vbat_invalid", "gas_disabled", "first_boot",
  ]);
});

test("analog channels remain EP2..EP5", () => {
  const channels = buildAnalogChannels();
  assert.deepEqual(channels.map((c) => c.ep), [2, 3, 4, 5]);
  assert.equal(channels.find((c) => c.attr === "gasResistance").integer, false);
  assert.equal(channels.find((c) => c.attr === "wakeCount").integer, true);
});

test("device identity block", () => {
  const identity = buildDeviceIdentity();
  assert.deepEqual(identity.zigbeeModel, ["C6-ENVIRO"]);
  assert.equal(identity.vendor, "Biometal");
});

test("converter owns a collision-safe enviro library namespace", () => {
  assert.match(converterSource, /\.\/lib\/enviro-contract\.generated\.mjs/,
    "the shared Z2M deployment must not resolve another project's generic contract file");
  assert.match(converterSource, /\.\/lib\/enviro-defs\.mjs/,
    "the shared Z2M deployment must not resolve another project's generic defs file");
  assert.match(enviroDefsSource, /\.\/enviro-defs\.factory\.mjs/,
    "the deployable defs wrapper must not import a generic shared factory filename");
  assert.ok(existsSync(join(ROOT, "z2m/lib/enviro-contract.generated.mjs")));
  assert.ok(existsSync(join(ROOT, "z2m/lib/enviro-defs.mjs")));
  assert.ok(existsSync(join(ROOT, "z2m/lib/enviro-defs.factory.mjs")));
});
