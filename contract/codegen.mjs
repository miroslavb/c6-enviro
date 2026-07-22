#!/usr/bin/env node
// Codegen for the C6-ENVIRO Zigbee byte-contract.
//
// Reads contract/contract.json (the single source of truth) and emits, deterministically:
//   1. firmware/main/zb_contract.h   — C header (#defines) for the ESP-IDF firmware
//   2. z2m/lib/contract.generated.mjs — JS module consumed by the Z2M external converter
//   3. docs/CONTRACT.md              — human-readable reference table
//
// Usage:
//   node contract/codegen.mjs          # write the generated files
//   node contract/codegen.mjs --check  # print generated text to stdout only (no write) — used by tests
//
// Edit ONLY contract.json, then re-run this. CI (contract/contract.test.mjs) fails if the
// committed generated files differ from a fresh run, so they can never silently drift.

import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const contract = JSON.parse(readFileSync(join(HERE, 'contract.json'), 'utf8'));

// ZCL attribute data-type codes (herdsman Zcl.DataType == ZCL spec == esp-zigbee-sdk codes)
const ZCL = {
  BOOLEAN: 0x10,
  UINT8: 0x20,
  UINT16: 0x21,
  UINT32: 0x23,
  INT16: 0x29,
  ENUM8: 0x30,
  SINGLE: 0x39,   // IEEE-754 float32
  CHAR_STR: 0x42,
};
// esp-zigbee-sdk attribute-type macro names (for header comments / firmware authoring)
const ESP_TYPE = {
  BOOLEAN: 'ESP_ZB_ZCL_ATTR_TYPE_BOOL',
  UINT8: 'ESP_ZB_ZCL_ATTR_TYPE_U8',
  UINT16: 'ESP_ZB_ZCL_ATTR_TYPE_U16',
  UINT32: 'ESP_ZB_ZCL_ATTR_TYPE_U32',
  INT16: 'ESP_ZB_ZCL_ATTR_TYPE_S16',
  ENUM8: 'ESP_ZB_ZCL_ATTR_TYPE_8BIT_ENUM',
  SINGLE: 'ESP_ZB_ZCL_ATTR_TYPE_SINGLE',
  CHAR_STR: 'ESP_ZB_ZCL_ATTR_TYPE_CHAR_STRING',
};

const hex = (n, w = 4) => '0x' + n.toString(16).toUpperCase().padStart(w, '0');
const upperSnake = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();

function genHeader() {
  const L = [];
  L.push('// AUTO-GENERATED from contract/contract.json by contract/codegen.mjs — DO NOT EDIT.');
  L.push('// Regenerate with: node contract/codegen.mjs');
  L.push('#pragma once');
  L.push('');
  L.push(`#define ZB_CONTRACT_VERSION ${contract.version}`);
  L.push('');
  L.push('// ---- Device identity (Basic cluster 0x0000) ----');
  L.push(`#define ZB_MANUF_NAME   "${contract.device.manufacturerName}"`);
  L.push(`#define ZB_MODEL_ID     "${contract.device.modelId}"`);
  L.push(`#define ZB_POWER_SOURCE ${hex(contract.device.powerSource, 2)}  // 0x03 = Battery`);
  L.push(`#define ZB_MANUF_CODE   ${hex(contract.manufacturerCode)}  // Espressif Systems — MUST match converter`);
  L.push('');
  L.push('// ---- Custom manufacturer cluster (DOWN config writes only) ----');
  L.push(`#define ENVIRO_CLUSTER_ID ${hex(contract.customCluster.id)}  // ${contract.customCluster.name}`);
  L.push('');
  L.push('// ---- Custom-cluster attributes: id / zcl type / min / max / default ----');
  for (const a of contract.attributes) {
    const u = upperSnake(a.name);
    const unit = a.unit ? ', ' + a.unit : '';
    L.push(`// ${a.name} (${a.dir}${unit}): ${a.desc}`);
    L.push(`#define ATTR_${u}      ${hex(a.id)}`);
    L.push(`#define ATTRTYPE_${u}  ${hex(ZCL[a.type], 2)}  // ${ESP_TYPE[a.type]}`);
    if (a.default !== undefined) L.push(`#define DEFAULT_${u}   ${a.default}`);
    if (a.min !== undefined) L.push(`#define MIN_${u}       ${a.min}`);
    if (a.max !== undefined) L.push(`#define MAX_${u}       ${a.max}`);
  }
  L.push('');
  L.push('// ---- Sensor + power status bitmask (statusFlags attribute) ----');
  for (const s of contract.statusBits) {
    const u = upperSnake(s.name);
    L.push(`#define ST_BIT_${u}   ${s.bit}      // ${s.desc}`);
    L.push(`#define ST_FLAG_${u}  (1u << ${s.bit})`);
  }
  L.push(`#define ST_FLAG_COUNT   ${contract.statusBits.length}`);
  L.push('');
  L.push('// ---- UP-path: standard Analog Input endpoints (genAnalogInput 0x000C) ----');
  L.push('// One endpoint per non-standard telemetry channel; value reported via');
  L.push('// presentValue (SINGLE). See _upPathNote in contract.json for the WHY');
  L.push('// (the Z2M addon cannot decode incoming custom-cluster frames).');
  for (const c of contract.analogEndpoints) {
    L.push(`#define AI_EP_${upperSnake(c.attr)}   ${c.ep}   // ${c.description}`);
  }
  L.push(`#define AI_EP_FIRST   ${Math.min(...contract.analogEndpoints.map((c) => c.ep))}`);
  L.push(`#define AI_EP_LAST    ${Math.max(...contract.analogEndpoints.map((c) => c.ep))}`);
  L.push(`#define AI_EP_COUNT   ${contract.analogEndpoints.length}`);
  L.push('// {endpoint, description} rows for cluster-construction loops.');
  L.push('#define AI_CHANNELS_INIT { \\');
  for (const c of contract.analogEndpoints) {
    L.push(`    { AI_EP_${upperSnake(c.attr)}, "${c.description}" }, \\`);
  }
  L.push('}');
  L.push('');
  L.push('// ---- Power / commissioning constants ----');
  L.push(`#define BATTERY_LOW_MV   ${contract.batteryLowMv}  // below this -> battery_low status bit`);
  L.push(`#define AWAKE_WINDOW_S   ${contract.awakeWindowS}  // stay-awake window after first join / BOOT press (Z2M interview)`);
  L.push('');
  return L.join('\n');
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
    manufacturerCode: contract.manufacturerCode,
    device: contract.device,
    cluster: {name: contract.customCluster.name, id: contract.customCluster.id},
    attributes: attrs,
    analogEndpoints: contract.analogEndpoints,
    standardClusters: contract.standardClusters,
    statusBits,
    batteryLowMv: contract.batteryLowMv,
    awakeWindowS: contract.awakeWindowS,
  };

  const L = [];
  L.push('// AUTO-GENERATED from contract/contract.json by contract/codegen.mjs — DO NOT EDIT.');
  L.push('// Regenerate with: node contract/codegen.mjs');
  L.push('');
  L.push('export const Zcl_DataType = ' + JSON.stringify(ZCL, null, 2) + ';');
  L.push('');
  L.push('export const CONTRACT = ' + JSON.stringify(obj, null, 2) + ';');
  L.push('');
  L.push('export default CONTRACT;');
  L.push('');
  return L.join('\n');
}

function genDoc() {
  const L = [];
  L.push('# Zigbee byte-contract (generated)');
  L.push('');
  L.push('> AUTO-GENERATED from `contract/contract.json` by `contract/codegen.mjs` — do not edit by hand.');
  L.push('');
  L.push(`- **Device**: manufacturerName \`${contract.device.manufacturerName}\`, modelId \`${contract.device.modelId}\`, powerSource \`${hex(contract.device.powerSource, 2)}\` (Battery)`);
  L.push(`- **Role**: sleepy Zigbee END DEVICE (deep sleep between cycles; rx_on_when_idle = false)`);
  L.push(`- **manufacturerCode**: \`${hex(contract.manufacturerCode)}\` (Espressif) — identical on firmware + converter or manufacturer-specific writes fail`);
  L.push(`- **Custom cluster**: \`${contract.customCluster.name}\` = \`${hex(contract.customCluster.id)}\` — DOWN config writes only`);
  L.push('');
  L.push('## Standard clusters (EP1) — the main telemetry path');
  L.push('');
  L.push('| Cluster | ID | Attribute | Encoding | Source |');
  L.push('|---|---|---|---|---|');
  for (const s of contract.standardClusters) {
    L.push(`| ${s.cluster} | ${hex(s.id)} | \`${s.attr}\` | ${s.encoding} | ${s.source} |`);
  }
  L.push('');
  L.push('Z2M decodes these natively (zero custom glue): `temperature`, `humidity`, `pressure`, `battery`, `voltage`. `linkquality` is added automatically.');
  L.push('');
  L.push('## Analog Input endpoints (standard genAnalogInput 0x000C) — non-standard channels');
  L.push('');
  L.push('| EP | Channel | Custom-cluster attr mirrored |');
  L.push('|---|---|---|');
  for (const c of contract.analogEndpoints) L.push(`| ${c.ep} | ${c.description} | \`${c.attr}\` |`);
  L.push('');
  L.push('The Z2M addon cannot decode INCOMING custom-cluster frames (endpoint→registry lookup loses the attached cluster → `msg.cluster` undefined → no converter matches; proven live 2026-07-11 on c6-radiometer). Non-standard telemetry therefore travels on STANDARD `genAnalogInput` clusters — one endpoint per channel, value in `presentValue` (SINGLE float), reported by the stack engine. `wakeCount` changes every cycle, guaranteeing ≥1 report per wake.');
  L.push('');
  L.push('## Custom-cluster attributes');
  L.push('');
  L.push('| Attr | HA key (`expose`) | ID | Type | Dir | Unit | Default | Range | Purpose |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const a of contract.attributes) {
    const range = (a.min !== undefined || a.max !== undefined) ? `${a.min ?? ''}…${a.max ?? ''}` : '—';
    L.push(`| \`${a.name}\` | \`${a.expose}\` | ${hex(a.id)} | ${a.type} | ${a.dir} | ${a.unit ?? '—'} | ${a.default ?? '—'} | ${range} | ${a.desc} |`);
  }
  L.push('');
  L.push('`up` attributes are readable on the custom cluster (diagnostics; NOT reported — reports would arrive undecodable, see above). `down` attributes are written HA→device via `zigbee2mqtt/<device>/set`; the firmware persists them in NVS so they survive deep sleep and power loss.');
  L.push('');
  L.push('## Sensor + power status bitmask (`statusFlags`)');
  L.push('');
  L.push('| Bit | Flag | Meaning |');
  L.push('|---|---|---|');
  for (const s of contract.statusBits) L.push(`| ${s.bit} | \`${s.name}\` | ${s.desc} |`);
  L.push('');
  L.push(`## Constants`);
  L.push('');
  L.push(`- \`batteryLowMv\` = ${contract.batteryLowMv} — below this the \`battery_low\` bit is raised`);
  L.push(`- \`awakeWindowS\` = ${contract.awakeWindowS} — stay-awake window after factory-new join / BOOT press so the Z2M interview completes`);
  L.push('');
  return L.join('\n');
}

const outputs = [
  [join(ROOT, 'firmware/main/zb_contract.h'), genHeader()],
  [join(ROOT, 'z2m/lib/contract.generated.mjs'), genJs()],
  [join(ROOT, 'docs/CONTRACT.md'), genDoc()],
];

if (process.argv.includes('--check')) {
  for (const [path, text] of outputs) {
    process.stdout.write(`\n===== ${path} =====\n` + text);
  }
} else {
  for (const [path, text] of outputs) {
    writeFileSync(path, text);
    console.log('wrote', path);
  }
}
