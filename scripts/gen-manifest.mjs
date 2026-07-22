#!/usr/bin/env node
// gen-manifest.mjs — generate web/firmware/manifest.json from an ESP-IDF build.
//
// Reads firmware/build/flasher_args.json (produced by `idf.py build`), copies the
// referenced .bin artifacts into web/firmware/, and writes a manifest with the REAL
// offsets that the bootloader was actually built for. This avoids hard-coding offsets
// that can drift between IDF/partition-table changes.
//
// IDF (unlike Arduino-ESP32) has NO boot_app0.bin / OTA-data init blob — a typical
// single-app build flashes exactly three files: the second-stage bootloader, the
// partition table, and the app. On the ESP32-C6 the second-stage bootloader loads at
// offset 0x0 (like the C3/S3, NOT 0x1000 as on the classic ESP32) — gen-manifest just
// echoes whatever offsets flasher_args.json reports, so it stays correct either way.
//
// Usage:  node scripts/gen-manifest.mjs
// The committed web/firmware/*.bin are the artifacts the browser flasher serves, so
// this script is the bridge between an IDF build and the static installer.
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const BUILD = join(ROOT, 'firmware', 'build');
const FLASHER_ARGS = join(BUILD, 'flasher_args.json');
const OUT_DIR = join(ROOT, 'web', 'firmware');
const MANIFEST = join(OUT_DIR, 'manifest.json');

const CHIP_FAMILY = 'ESP32-C6';

function die(msg) {
  console.error('ERROR: ' + msg);
  process.exit(1);
}

// Scrape a human-readable version from the firmware sources if available, else 0.0.0.
// We look for a `FW_VERSION "x.y.z"` (or `= "x.y.z"`) token in firmware/main/*.
function readVersion() {
  const candidates = [
    join(ROOT, 'firmware', 'main', 'version.h'),
    join(ROOT, 'firmware', 'main', 'main.c'),
    join(ROOT, 'firmware', 'main', 'app_main.c'),
  ];
  for (const f of candidates) {
    try {
      const txt = readFileSync(f, 'utf8');
      const m = txt.match(/FW_VERSION\s*=?\s*"(\d+\.\d+\.\d+)"/);
      if (m) return m[1];
    } catch { /* file may not exist */ }
  }
  return '0.0.0';
}

function main() {
  let flasher;
  try {
    flasher = JSON.parse(readFileSync(FLASHER_ARGS, 'utf8'));
  } catch (e) {
    die(`cannot read ${FLASHER_ARGS} — run the IDF build first ` +
        `(scripts/build-firmware.sh). ${e.message}`);
  }

  // flasher_args.json has a `flash_files` object: { "<offset hex>": "<relpath>.bin", ... }.
  // (It also carries flat keys like bootloader/partition-table/app, but flash_files is
  // the canonical address->file map.)
  const flashFiles = flasher.flash_files;
  if (!flashFiles || typeof flashFiles !== 'object') {
    die('flasher_args.json has no flash_files map');
  }

  mkdirSync(OUT_DIR, { recursive: true });

  const parts = [];
  for (const [offsetHex, relPath] of Object.entries(flashFiles)) {
    if (!relPath) continue;
    const offset = parseInt(offsetHex, 16);
    if (Number.isNaN(offset)) die(`bad offset "${offsetHex}" in flash_files`);
    // Paths in flasher_args.json are relative to the build dir.
    const srcPath = join(BUILD, relPath);
    const fileName = basename(relPath);
    const dstPath = join(OUT_DIR, fileName);
    try {
      copyFileSync(srcPath, dstPath);
    } catch (e) {
      die(`cannot copy ${srcPath} -> ${dstPath}: ${e.message}`);
    }
    parts.push({ path: `firmware/${fileName}`, offset });
    console.log(`  copied ${fileName} @ 0x${offset.toString(16)}`);
  }

  if (parts.length === 0) die('no flashable files found in flash_files');
  // Flash in ascending offset order (deterministic; harmless but tidy).
  parts.sort((a, b) => a.offset - b.offset);

  const manifest = {
    name: 'C6-ENVIRO',
    version: readVersion(),
    chipFamily: CHIP_FAMILY,
    parts,
  };
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`==> wrote ${MANIFEST} (chipFamily ${CHIP_FAMILY}, version ${manifest.version}, ${parts.length} parts)`);
}

main();
