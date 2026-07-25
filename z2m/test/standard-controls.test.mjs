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
    async write(cluster, payload) {
      calls.push({kind: "write", cluster, payload});
    },
    async command(cluster, command, payload) {
      calls.push({kind: "command", cluster, command, payload});
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
    await interval.convertSet(entity, "report_interval_s", 90, {}),
    {state: {report_interval_s: 90}},
  );
  assert.deepEqual(calls.shift(), {
    kind: "write",
    cluster: "genAnalogOutput",
    payload: {presentValue: 90},
  });

  assert.deepEqual(
    await gas.convertSet(entity, "gas_enabled", "OFF", {}),
    {state: {gas_enabled: "OFF"}},
  );
  assert.deepEqual(calls.shift(), {
    kind: "command",
    cluster: "genOnOff",
    command: "off",
    payload: {},
  });
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

test("converter reads both persisted standard controls during configuration", async () => {
  const mod = await import("../biometal_enviro.mjs");
  const reads = [];
  const device = {
    getEndpoint(id) {
      assert.equal(id, 1);
      return {
        async read(cluster, attributes) {
          reads.push({cluster, attributes});
        },
      };
    },
  };
  assert.ok(Array.isArray(mod.controlsExtend.configure),
    "standard control extension must request persisted state after interview");
  await mod.controlsExtend.configure[0](device, {});
  assert.deepEqual(reads, [
    {cluster: "genAnalogOutput", attributes: ["presentValue"]},
    {cluster: "genOnOff", attributes: ["onOff"]},
  ]);
});
