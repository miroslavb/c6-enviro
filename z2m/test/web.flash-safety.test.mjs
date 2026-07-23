// Regression guard: routine browser flashes must preserve Zigbee NVRAM.
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const html = readFileSync(join(ROOT, "web/index.html"), "utf8");
const app = readFileSync(join(ROOT, "web/js/app.js"), "utf8");
const flash = readFileSync(join(ROOT, "web/js/flash.js"), "utf8");

test("routine flash preserves zb_storage by default", () => {
  const checkbox = html.match(/<input[^>]+id=["']eraseFirst["'][^>]*>/i)?.[0];
  assert.ok(checkbox, "erase-first checkbox is missing");
  assert.doesNotMatch(checkbox, /\schecked(?:\s|=|\/?>)/i,
    "erase-first checkbox must not be selected by default");
  assert.match(html, /preserve[^<]*(?:Zigbee|zb_storage)/i,
    "flasher does not explain why routine updates preserve Zigbee NVRAM");
  assert.match(flash,
    /const\s+eraseAll\s*=\s*\$\(['"]eraseFirst['"]\)\?\.checked\s*===\s*true\s*;/,
    "missing checkbox must fail safe to eraseAll=false");
  assert.doesNotMatch(flash, /erase-whole-flash default ON|Erase whole flash first[^\n]*checked and try again/i,
    "runtime guidance still recommends destructive erase by default");
  assert.doesNotMatch(html, /erase-first\s+(?:checked|on)\b/i,
    "HTML help still recommends destructive erase during routine recovery");
  assert.match(html, /src=["']js\/app\.js\?v=0\.1\.10["']/,
    "installer entry module is not cache-busted for v0.1.10");
  assert.match(app, /from\s+["']\.\/flash\.js\?v=0\.1\.10["']/,
    "flash safety module is not cache-busted for v0.1.10");
});

test("explicit recovery erase remains available", () => {
  assert.match(html, /id=["']eraseBtn["']/i);
  assert.match(flash, /async function doErase\s*\(/);
  assert.match(flash, /confirm\(['"]Erase the entire flash\?/);
});
