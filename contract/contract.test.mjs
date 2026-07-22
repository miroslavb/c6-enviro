#!/usr/bin/env node
// Parity test: the committed generated files MUST match a fresh codegen run.
// This is the "one source of truth + a parity test that fails loudly" discipline carried
// over from the kbd project — it guarantees firmware (C), the Z2M converter (JS), and the
// docs can never silently drift from contract/contract.json.
//
// Run: node contract/contract.test.mjs   (exit 0 = in sync, exit 1 = drift)

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {execFileSync} from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const files = [
  'firmware/main/zb_contract.h',
  'z2m/lib/contract.generated.mjs',
  'docs/CONTRACT.md',
];

// Run codegen in --check mode and split its output back into per-file sections.
const out = execFileSync('node', [join(HERE, 'codegen.mjs'), '--check'], {encoding: 'utf8'});
const sections = {};
let cur = null;
for (const line of out.split('\n')) {
  const m = line.match(/^===== (.+) =====$/);
  if (m) {
    cur = m[1];
    sections[cur] = [];
  } else if (cur) {
    sections[cur].push(line);
  }
}

let failed = 0;
for (const rel of files) {
  const abs = join(ROOT, rel);
  const committed = readFileSync(abs, 'utf8');
  const key = Object.keys(sections).find((k) => k.endsWith(rel));
  const fresh = (sections[key] || []).join('\n');
  // codegen --check joins sections with a leading newline; normalise trailing whitespace.
  if (committed.trimEnd() !== fresh.trimEnd()) {
    console.error(`DRIFT: ${rel} is stale. Run: node contract/codegen.mjs`);
    failed++;
  } else {
    console.log(`ok: ${rel}`);
  }
}

if (failed) {
  console.error(`\n${failed} generated file(s) out of sync with contract.json`);
  process.exit(1);
}
console.log('\ncontract parity OK');
