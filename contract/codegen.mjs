#!/usr/bin/env node
// Codegen for the C6-ENVIRO Zigbee contract.
//
// Reads contract/contract.json (the single source of truth) and emits:
//   1. firmware/main/zb_contract.h
//   2. z2m/lib/contract.generated.mjs
//   3. docs/CONTRACT.md
//
// Usage:
//   node contract/codegen.mjs
//   node contract/codegen.mjs --check
import {readFileSync, writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const contract = JSON.parse(readFileSync(join(HERE, "contract.json"), "utf8"));

const ZCL = {
  BOOLEAN: 0x10,
  UINT8: 0x20,
  UINT16: 0x21,
  UINT32: 0x23,
  INT16: 0x29,
  ENUM8: 0x30,
  SINGLE: 0x39,
  CHAR_STR: 0x42,
};
const ESP_TYPE = {
  BOOLEAN: "ESP_ZB_ZCL_ATTR_TYPE_BOOL",
  UINT8: "ESP_ZB_ZCL_ATTR_TYPE_U8",
  UINT16: "ESP_ZB_ZCL_ATTR_TYPE_U16",
  UINT32: "ESP_ZB_ZCL_ATTR_TYPE_U32",
  INT16: "ESP_ZB_ZCL_ATTR_TYPE_S16",
  ENUM8: "ESP_ZB_ZCL_ATTR_TYPE_8BIT_ENUM",
  SINGLE: "ESP_ZB_ZCL_ATTR_TYPE_SINGLE",
  CHAR_STR: "ESP_ZB_ZCL_ATTR_TYPE_CHAR_STRING",
};
const hex = (n, w = 4) => "0x" + n.toString(16).toUpperCase().padStart(w, "0");
const upperSnake = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
const attrByName = new Map(contract.attributes.map((a) => [a.name, a]));

function controlAttr(control) {
  const attr = attrByName.get(control.attr);
  if (!attr) throw new Error(`standardControls references unknown attr '${control.attr}'`);
  if (attr.dir !== "down") throw new Error(`standard control '${control.attr}' must target a down field`);
  if (control.name !== attr.expose) throw new Error(`standard control '${control.attr}' name must equal expose '${attr.expose}'`);
  return attr;
}

for (const control of contract.standardControls) controlAttr(control);
if (!contract.pollControl || contract.pollControl.ep !== 1 || contract.pollControl.clusterId !== 0x0020) {
  throw new Error("pollControl must define the standard EP1 genPollCtrl (0x0020) transport");
}

function genHeader() {
  const L = [];
  L.push("// AUTO-GENERATED from contract/contract.json by contract/codegen.mjs — DO NOT EDIT.");
  L.push("// Regenerate with: node contract/codegen.mjs");
  L.push("#pragma once");
  L.push("");
  L.push(`#define ZB_CONTRACT_VERSION ${contract.version}`);
  L.push("");
  L.push("// ---- Device identity (Basic cluster 0x0000) ----");
  L.push(`#define ZB_MANUF_NAME   \"${contract.device.manufacturerName}\"`);
  L.push(`#define ZB_MODEL_ID     \"${contract.device.modelId}\"`);
  L.push(`#define ZB_POWER_SOURCE ${hex(contract.device.powerSource, 2)}  // 0x03 = Battery`);
  L.push("");
  L.push("// ---- Domain fields: defaults/ranges shared by firmware and converter ----");
  for (const a of contract.attributes) {
    const u = upperSnake(a.name);
    const unit = a.unit ? `, ${a.unit}` : "";
    L.push(`// ${a.name} (${a.dir}${unit}): ${a.desc}`);
    if (a.default !== undefined) L.push(`#define DEFAULT_${u}   ${a.default}`);
    if (a.min !== undefined) L.push(`#define MIN_${u}       ${a.min}`);
    if (a.max !== undefined) L.push(`#define MAX_${u}       ${a.max}`);
  }
  L.push("");
  L.push("// ---- Standard EP1 control transport (no custom cluster on the wire) ----");
  for (const c of contract.standardControls) {
    const u = upperSnake(c.attr);
    const attr = controlAttr(c);
    L.push(`// ${attr.expose}: ${c.cluster}.${c.attribute} (${c.transport})`);
    L.push(`#define CTRL_${u}_EP           ${c.ep}`);
    L.push(`#define CTRL_${u}_CLUSTER_ID   ${hex(c.clusterId)}`);
    L.push(`#define CTRL_${u}_ATTR_ID      ${hex(c.attributeId)}`);
  }
  L.push("");
  L.push("// ---- Standard EP1 Poll Control synchronization ----");
  L.push(`#define POLL_CONTROL_EP                     ${contract.pollControl.ep}`);
  L.push(`#define POLL_CONTROL_CLUSTER_ID             ${hex(contract.pollControl.clusterId)}`);
  L.push(`#define POLL_CONTROL_COORDINATOR_SHORT_ADDR ${hex(contract.pollControl.coordinatorShortAddress)}`);
  L.push(`#define POLL_CONTROL_COORDINATOR_EP         ${contract.pollControl.coordinatorEndpoint}`);
  L.push(`#define POLL_CONTROL_CHECKIN_INTERVAL_QS    ${contract.pollControl.checkInIntervalQs}`);
  L.push(`#define POLL_CONTROL_LONG_POLL_INTERVAL_QS  ${contract.pollControl.longPollIntervalQs}`);
  L.push(`#define POLL_CONTROL_SHORT_POLL_INTERVAL_QS ${contract.pollControl.shortPollIntervalQs}`);
  L.push(`#define POLL_CONTROL_FAST_POLL_TIMEOUT_QS   ${contract.pollControl.fastPollTimeoutQs}`);
  L.push("");
  L.push("// ---- Sensor + power status bitmask (statusFlags domain field) ----");
  for (const s of contract.statusBits) {
    const u = upperSnake(s.name);
    L.push(`#define ST_BIT_${u}   ${s.bit}      // ${s.desc}`);
    L.push(`#define ST_FLAG_${u}  (1u << ${s.bit})`);
  }
  L.push(`#define ST_FLAG_COUNT   ${contract.statusBits.length}`);
  L.push("");
  L.push("// ---- UP-path: standard Analog Input endpoints (genAnalogInput 0x000C) ----");
  for (const c of contract.analogEndpoints) {
    L.push(`#define AI_EP_${upperSnake(c.attr)}   ${c.ep}   // ${c.description}`);
  }
  L.push(`#define AI_EP_FIRST   ${Math.min(...contract.analogEndpoints.map((c) => c.ep))}`);
  L.push(`#define AI_EP_LAST    ${Math.max(...contract.analogEndpoints.map((c) => c.ep))}`);
  L.push(`#define AI_EP_COUNT   ${contract.analogEndpoints.length}`);
  L.push("// {endpoint, description} rows for cluster-construction loops.");
  const continuation = String.fromCharCode(92);
  L.push("#define AI_CHANNELS_INIT { " + continuation);
  for (const c of contract.analogEndpoints) {
    L.push(`    { AI_EP_${upperSnake(c.attr)}, \"${c.description}\" }, ` + continuation);
  }
  L.push("}");
  L.push("");
  L.push("// ---- Power / commissioning constants ----");
  L.push(`#define BATTERY_LOW_MV   ${contract.batteryLowMv}`);
  L.push(`#define AWAKE_WINDOW_S   ${contract.awakeWindowS}`);
  L.push("");
  return L.join("\n");
}

function genJs() {
  const attrs = contract.attributes.map((a) => ({
    name: a.name,
    expose: a.expose ?? null,
    id: a.id,
    type: a.type,
    zclType: ZCL[a.type],
    dir: a.dir,
    unit: a.unit ?? null,
    min: a.min ?? null,
    max: a.max ?? null,
    default: a.default ?? null,
    optional: !!a.optional,
    report: !!a.report,
    desc: a.desc,
  }));
  const statusBits = {};
  for (const s of contract.statusBits) statusBits[s.name] = {bit: s.bit, desc: s.desc};
  const obj = {
    version: contract.version,
    device: contract.device,
    attributes: attrs,
    standardControls: contract.standardControls,
    pollControl: contract.pollControl,
    analogEndpoints: contract.analogEndpoints,
    standardClusters: contract.standardClusters,
    statusBits,
    batteryLowMv: contract.batteryLowMv,
    awakeWindowS: contract.awakeWindowS,
  };
  return [
    "// AUTO-GENERATED from contract/contract.json by contract/codegen.mjs — DO NOT EDIT.",
    "// Regenerate with: node contract/codegen.mjs",
    "",
    "export const Zcl_DataType = " + JSON.stringify(ZCL, null, 2) + ";",
    "",
    "export const CONTRACT = " + JSON.stringify(obj, null, 2) + ";",
    "",
    "export default CONTRACT;",
    "",
  ].join("\n");
}

function genDoc() {
  const L = [];
  L.push("# Zigbee contract (generated)");
  L.push("");
  L.push("> AUTO-GENERATED from `contract/contract.json` by `contract/codegen.mjs` — do not edit by hand.");
  L.push("");
  L.push(`- **Device**: manufacturerName \`${contract.device.manufacturerName}\`, modelId \`${contract.device.modelId}\`, powerSource \`${hex(contract.device.powerSource, 2)}\` (Battery)`);
  L.push("- **Role**: sleepy Zigbee END DEVICE (deep sleep between cycles; `rx_on_when_idle=false`)");
  L.push("- **Wire rule**: no manufacturer-specific custom cluster is registered. Both telemetry and control use standard ZCL clusters.");
  L.push("");
  L.push("## Standard clusters (EP1) — telemetry");
  L.push("");
  L.push("| Cluster | ID | Attribute | Encoding | Source |");
  L.push("|---|---|---|---|---|");
  for (const s of contract.standardClusters) L.push(`| ${s.cluster} | ${hex(s.id)} | \`${s.attr}\` | ${s.encoding} | ${s.source} |`);
  L.push("");
  L.push("## Standard control transport (EP1) — HA → device");
  L.push("");
  L.push("| HA key | Field | Cluster | ID | Attribute / command | Transport | Persistence |");
  L.push("|---|---|---|---|---|---|---|");
  for (const c of contract.standardControls) {
    const a = controlAttr(c);
    const action = c.transport === "command" ? `\`${c.onCommand}\` / \`${c.offCommand}\`` : `\`${c.attribute}\``;
    L.push(`| \`${c.name}\` | \`${c.attr}\` | ${c.cluster} | ${hex(c.clusterId)} | ${action} | ${c.transport} | NVS |`);
    if (a.min !== undefined || a.max !== undefined) L.push(`| ↳ range | — | — | — | ${a.min ?? ""}…${a.max ?? ""} ${a.unit ?? ""} | firmware + converter clamp | — |`);
  }
  L.push("");
  L.push("The two configuration clusters share EP1 with the measurement clusters; EP2…EP5 remain the four Analog Input telemetry endpoints, preserving the sleepy-device interview surface `EP1…EP5`.");
  L.push("");
  L.push("## Standard sleepy-control synchronization (EP1)");
  L.push("");
  L.push(`- Cluster: \`${contract.pollControl.cluster}\` ${hex(contract.pollControl.clusterId)} (server)`);
  L.push("- Converter configure binds this server cluster to the coordinator endpoint so automatic CheckIn commands have a destination.");
  L.push(`- CheckIn destination: coordinator short ${hex(contract.pollControl.coordinatorShortAddress)}, EP${contract.pollControl.coordinatorEndpoint}`);
  L.push(`- Automatic awake-window CheckIn: ${contract.pollControl.checkInIntervalQs} quarter-seconds (${contract.pollControl.checkInIntervalQs / 4} s)`);
  L.push(`- Long/short poll: ${contract.pollControl.longPollIntervalQs}/${contract.pollControl.shortPollIntervalQs} quarter-seconds; fast-poll timeout: ${contract.pollControl.fastPollTimeoutQs} quarter-seconds`);
  L.push("- Normal deep-sleep timer wakes additionally send one explicit CheckIn before reporting so Herdsman can flush its pending control queue.");
  L.push("");
  L.push("## Analog Input endpoints (standard `genAnalogInput` 0x000C)");
  L.push("");
  L.push("| EP | Channel | Domain field |");
  L.push("|---|---|---|");
  for (const c of contract.analogEndpoints) L.push(`| ${c.ep} | ${c.description} | \`${c.attr}\` |`);
  L.push("");
  L.push("## Domain fields");
  L.push("");
  L.push("| Field | HA key (`expose`) | Type | Dir | Unit | Default | Range | Purpose |");
  L.push("|---|---|---|---|---|---|---|---|");
  for (const a of contract.attributes) {
    const range = (a.min !== undefined || a.max !== undefined) ? `${a.min ?? ""}…${a.max ?? ""}` : "—";
    L.push(`| \`${a.name}\` | \`${a.expose}\` | ${a.type} | ${a.dir} | ${a.unit ?? "—"} | ${a.default ?? "—"} | ${range} | ${a.desc} |`);
  }
  L.push("");
  L.push("## Sensor + power status bitmask (`statusFlags`)");
  L.push("");
  L.push("| Bit | Flag | Meaning |");
  L.push("|---|---|---|");
  for (const s of contract.statusBits) L.push(`| ${s.bit} | \`${s.name}\` | ${s.desc} |`);
  L.push("");
  L.push("## Constants");
  L.push("");
  L.push(`- \`batteryLowMv\` = ${contract.batteryLowMv}`);
  L.push(`- \`awakeWindowS\` = ${contract.awakeWindowS}`);
  L.push("");
  return L.join("\n");
}

const outputs = [
  [join(ROOT, "firmware/main/zb_contract.h"), genHeader()],
  [join(ROOT, "z2m/lib/contract.generated.mjs"), genJs()],
  // The deployable external converter lives beside sibling projects, whose
  // generic filenames collide. Publish an identical, enviro-scoped contract.
  [join(ROOT, "z2m/lib/enviro-contract.generated.mjs"), genJs()],
  [join(ROOT, "docs/CONTRACT.md"), genDoc()],
];

if (process.argv.includes("--check")) {
  for (const [path, text] of outputs) process.stdout.write(`\n===== ${path} =====\n${text}`);
} else {
  for (const [path, text] of outputs) {
    writeFileSync(path, text);
    console.log("wrote", path);
  }
}
