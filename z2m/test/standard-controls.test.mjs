// Regression tests for the v0.1.12 standard-control migration.
//
// ESP-Zigbee's compat stack rejects writes to custom-cluster attributes as
// NOT_AUTHORIZED even when the attribute is registered READ_WRITE. The sleepy
// C6 Enviro must therefore keep its five-endpoint interview surface while
// carrying its two downlink controls on standard clusters at EP1:
//   report_interval_s -> genAnalogOutput.presentValue (SINGLE)
//   gas_enabled       -> genOnOff on/off commands
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";

import CONTRACT from "../lib/contract.generated.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const firmwareSource = readFileSync(join(ROOT, "firmware/main/zb_device.c"), "utf8");

const expectedControls = [
  {
    attr: "reportIntervalS",
    name: "report_interval_s",
    ep: 1,
    cluster: "genAnalogOutput",
    clusterId: 0x000d,
    attribute: "presentValue",
    attributeId: 0x0055,
    transport: "write",
  },
  {
    attr: "gasEnabled",
    name: "gas_enabled",
    ep: 1,
    cluster: "genOnOff",
    clusterId: 0x0006,
    attribute: "onOff",
    attributeId: 0x0000,
    transport: "command",
    onCommand: "on",
    offCommand: "off",
  },
];

test("contract puts both writable controls on standard EP1 clusters", () => {
  assert.deepEqual(CONTRACT.standardControls, expectedControls);
});

test("firmware declares standard control clusters without expanding the endpoint set", () => {
  assert.match(firmwareSource, /esp_zb_cluster_list_add_analog_output_cluster\s*\(/,
    "report_interval_s needs a standard Analog Output server");
  assert.match(firmwareSource, /esp_zb_cluster_list_add_on_off_cluster\s*\(/,
    "gas_enabled needs a standard On/Off server");
  assert.doesNotMatch(firmwareSource, /build_custom_cluster\s*\(/,
    "the rejected custom-cluster control plane must not remain registered");
  assert.match(firmwareSource, /ESP_ZB_ZCL_CLUSTER_ID_ANALOG_OUTPUT/);
  assert.match(firmwareSource, /CTRL_GAS_ENABLED_CLUSTER_ID/);
});

test("converter routes interval writes and gas commands through standard ZCL", async () => {
  const mod = await import("../biometal_enviro.mjs");
  assert.ok(mod.controlsExtend, "converter must export its standard control extension for testability");

  const calls = [];
  const endpoint = {
    async write(cluster, payload, options) {
      calls.push({kind: "write", cluster, payload, options});
    },
    async command(cluster, command, payload, options) {
      calls.push({kind: "command", cluster, command, payload, options});
    },
    async read(cluster, attributes) {
      calls.push({kind: "read", cluster, attributes});
    },
  };
  const entity = {
    getDevice() {
      return {
        getEndpoint(ep) {
          assert.equal(ep, 1, "both controls must retain the five-endpoint interview surface");
          return endpoint;
        },
      };
    },
  };

  const interval = mod.controlsExtend.toZigbee.find((tz) => tz.key.includes("report_interval_s"));
  const gas = mod.controlsExtend.toZigbee.find((tz) => tz.key.includes("gas_enabled"));
  assert.ok(interval, "interval toZigbee converter missing");
  assert.ok(gas, "gas toZigbee converter missing");

  assert.deepEqual(
    await interval.convertSet(entity, "report_interval_s", 90, {state: {report_interval_s: 10}}),
    {state: {report_interval_s: 90}},
  );
  assert.deepEqual(calls.shift(), {
    kind: "write",
    cluster: "genAnalogOutput",
    payload: {presentValue: 90},
    options: {timeout: 30000, sendPolicy: "bulk"},
  });

  assert.deepEqual(
    await gas.convertSet(entity, "gas_enabled", "OFF", {state: {report_interval_s: 10}}),
    {state: {gas_enabled: "OFF"}},
  );
  assert.deepEqual(calls.shift(), {
    kind: "command",
    cluster: "genOnOff",
    command: "off",
    payload: {},
    options: {timeout: 30000, sendPolicy: "bulk"},
  });
});

test("converter gives sleepy control writes a cadence-aware response budget", async () => {
  const mod = await import("../biometal_enviro.mjs");
  const calls = [];
  const entity = {
    getDevice() {
      return {
        getEndpoint() {
          return {
            async write(cluster, payload, options) {
              calls.push({cluster, payload, options});
            },
          };
        },
      };
    },
  };
  const interval = mod.controlsExtend.toZigbee.find((tz) => tz.key.includes("report_interval_s"));
  await interval.convertSet(entity, "report_interval_s", 61, {state: {report_interval_s: 60}});
  await interval.convertSet(entity, "report_interval_s", 3600, {state: {report_interval_s: 3600}});
  assert.deepEqual(calls, [
    {cluster: "genAnalogOutput", payload: {presentValue: 61}, options: {timeout: 70000, sendPolicy: "bulk"}},
    {cluster: "genAnalogOutput", payload: {presentValue: 3600}, options: {timeout: 120000, sendPolicy: "bulk"}},
  ]);
});

test("converter clamps report_interval_s before the radio write", async () => {
  const mod = await import("../biometal_enviro.mjs");
  assert.ok(mod.controlsExtend, "converter must export its standard control extension for testability");

  const calls = [];
  const entity = {
    getDevice() {
      return {
        getEndpoint() {
          return {
            async write(cluster, payload) {
              calls.push({cluster, payload});
            },
          };
        },
      };
    },
  };
  const interval = mod.controlsExtend.toZigbee.find((tz) => tz.key.includes("report_interval_s"));
  await interval.convertSet(entity, "report_interval_s", 1, {});
  assert.deepEqual(calls, [{cluster: "genAnalogOutput", payload: {presentValue: 3}}]);
});

test("converter accepts Zigbee2MQTT's object-shaped number payload", async () => {
  const mod = await import("../biometal_enviro.mjs");
  const calls = [];
  const entity = {
    getDevice() {
      return {
        getEndpoint() {
          return {
            async write(cluster, payload) {
              calls.push({cluster, payload});
            },
          };
        },
      };
    },
  };
  const interval = mod.controlsExtend.toZigbee.find((tz) => tz.key.includes("report_interval_s"));
  assert.deepEqual(
    await interval.convertSet(entity, "report_interval_s", {value: 120}, {}),
    {state: {report_interval_s: 120}},
  );
  assert.deepEqual(calls, [{cluster: "genAnalogOutput", payload: {presentValue: 120}}]);
});

test("converter binds Poll Control and reads persisted controls during configuration", async () => {
  const mod = await import("../biometal_enviro.mjs");
  const reads = [];
  const binds = [];
  const coordinatorEndpoint = {ID: 1, deviceIeeeAddress: "0x0000000000000000"};
  const endpoint = {
    async bind(cluster, target) {
      binds.push({cluster, target});
    },
    async read(cluster, attributes) {
      reads.push({cluster, attributes});
    },
  };
  const device = {
    getEndpoint(id) {
      assert.equal(id, 1);
      return endpoint;
    },
  };
  assert.ok(Array.isArray(mod.controlsExtend.configure),
    "standard control extension must configure the sleepy control path after interview");
  await mod.controlsExtend.configure[0](device, coordinatorEndpoint);
  assert.deepEqual(binds, [{cluster: "genPollCtrl", target: coordinatorEndpoint}],
    "automatic CheckIn needs an EP1 Poll Control binding to the coordinator");
  assert.deepEqual(reads, [
    {cluster: "genAnalogOutput", attributes: ["presentValue"]},
    {cluster: "genOnOff", attributes: ["onOff"]},
  ]);
});

test("converter queues control set and get until the device Poll Control CheckIn", async () => {
  const mod = await import("../biometal_enviro.mjs");
  const calls = [];
  const device = {
    pendingRequestTimeout: 0,
    getEndpoint() {
      return endpoint;
    },
  };
  const endpoint = {
    getDevice() {
      return device;
    },
    async write(cluster, payload, options) {
      calls.push({kind: "write", cluster, payload, options});
    },
    async read(cluster, attributes, options) {
      calls.push({kind: "read", cluster, attributes, options});
    },
    async command(cluster, command, payload, options) {
      calls.push({kind: "command", cluster, command, payload, options});
    },
  };
  const entity = {getDevice: () => device};
  const interval = mod.controlsExtend.toZigbee.find((tz) => tz.key.includes("report_interval_s"));
  const gas = mod.controlsExtend.toZigbee.find((tz) => tz.key.includes("gas_enabled"));

  await interval.convertSet(entity, "report_interval_s", 30, {state: {report_interval_s: 10}});
  await interval.convertGet(entity, "report_interval_s", {state: {report_interval_s: 10}});
  await gas.convertSet(entity, "gas_enabled", "OFF", {state: {report_interval_s: 10}});
  await gas.convertGet(entity, "gas_enabled", {state: {report_interval_s: 10}});

  assert.equal(device.pendingRequestTimeout, 30000,
    "Herdsman needs a non-zero request lifetime before sendPolicy can queue");
  assert.deepEqual(calls, [
    {
      kind: "write",
      cluster: "genAnalogOutput",
      payload: {presentValue: 30},
      options: {timeout: 30000, sendPolicy: "bulk"},
    },
    {
      kind: "read",
      cluster: "genAnalogOutput",
      attributes: ["presentValue"],
      options: {timeout: 30000, sendPolicy: "bulk"},
    },
    {
      kind: "command",
      cluster: "genOnOff",
      command: "off",
      payload: {},
      options: {timeout: 30000, sendPolicy: "bulk"},
    },
    {
      kind: "read",
      cluster: "genOnOff",
      attributes: ["onOff"],
      options: {timeout: 30000, sendPolicy: "bulk"},
    },
  ]);
});
