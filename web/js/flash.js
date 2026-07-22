// flash.js — flash the ESP32-C6 Super Mini (C6-ENVIRO) from the browser via Web Serial
// + esptool-js (vendored bundle). Manifest-driven multi-part write; no config blob
// (the device pairs over Zigbee, so nothing is baked in at flash time).
//
// All the hard-won lessons from the prior kbd-web-keyboard (ESP32-S3) installer are
// carried forward, because the C6 — like the S3 — has *native* USB-Serial/JTAG where
// the same failure modes appear:
//   * esptool-js 0.5.7 (vendored), pako bundled — NOT 0.6.x (no uncompressed fallback).
//   * default baud 115200 with romBaudrate === baudrate, so esptool-js skips the
//     mid-session baud change that corrupts writes over virtual (USB-CDC) baud.
//   * erase-whole-flash default ON + a standalone "Recover (erase only)" path.
//   * writeFlash data passed as chunked binary STRINGS (esptool-js 0.5.x contract).
//   * compression ON (the proven esp-web-tools path).
//   * hardReset() wrapped in try/catch — native USB reset is flaky; tell the user to replug.
//   * a prominent "hold BOOT (GPIO9) while connecting" recovery instruction.
import { ESPLoader, Transport } from '../lib/esptool-bundle.js';

const $ = (id) => document.getElementById(id);
const MANIFEST_URL = './firmware/manifest.json';
// We expect a C6; we warn (but don't hard-block) if a different chip is detected,
// matching the prior installer's behavior.
const EXPECTED_CHIP = /ESP32-?C6/i;

function log(line) {
  const el = $('log');
  el.textContent += line + '\n';
  el.scrollTop = el.scrollHeight;
}
function setStatus(msg) { $('flashStatus').textContent = msg; }
function setProgress(pct) {
  $('progressWrap').classList.remove('hidden');
  $('progressBar').style.width = `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`;
}

// ArrayBuffer/Uint8Array -> binary string. esptool-js 0.5.x's writeFlash() expects
// each fileArray[i].data to be a *binary string*, not a Uint8Array. Convert in
// 0x8000-byte chunks so String.fromCharCode.apply doesn't overflow the arg list.
function toBinaryString(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return s;
}

async function fetchBin(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`cannot fetch ${path} (${res.status})`);
  return res.arrayBuffer();
}

// esptool-js writes its stub/loader chatter through this terminal-like object.
const espTerminal = {
  clean() { $('log').textContent = ''; },
  writeLine(data) { log(data); },
  write(data) { $('log').textContent += data; },
};

let busy = false;

function selectedBaud() {
  return parseInt($('baud')?.value || '115200', 10);
}

// Shared connect path: request a port, build an ESPLoader with rom==main baud, run
// the stub loader, and return { transport, loader, chip }.
async function connect() {
  const baud = selectedBaud();
  const port = await navigator.serial.requestPort();
  const transport = new Transport(port, false);
  // Keep rom/main baud EQUAL: on native USB-Serial/JTAG the baud is virtual, so a
  // mid-session baud change buys nothing and is a known cause of write failures.
  const loader = new ESPLoader({ transport, baudrate: baud, romBaudrate: baud, terminal: espTerminal });
  setStatus('Connecting to the device (hold BOOT if it fails)…');
  const chip = await loader.main();
  log(`Detected: ${chip}`);
  return { transport, loader, chip, baud };
}

async function doFlash() {
  if (busy) return;
  if (!('serial' in navigator)) { alert('Web Serial is not supported in this browser.'); return; }

  busy = true;
  $('flashBtn').disabled = true;
  $('eraseBtn').disabled = true;
  $('logBox').classList.remove('hidden');
  $('log').textContent = '';
  setStatus('Select the device serial port…');

  let transport;
  try {
    const { transport: t, loader, chip } = await connect();
    transport = t;
    if (!EXPECTED_CHIP.test(String(chip))) {
      if (!confirm(`Detected "${chip}", expected ESP32-C6. Flash anyway?`)) {
        throw new Error('aborted: wrong chip');
      }
    }

    // Load firmware parts from the manifest (bootloader / partition-table / app).
    // No cfg/credential blob is appended — the device pairs over Zigbee.
    setStatus('Downloading firmware…');
    const manifest = await (await fetch(MANIFEST_URL, { cache: 'no-cache' })).json();
    if (manifest.chipFamily && !EXPECTED_CHIP.test(String(manifest.chipFamily))) {
      log(`(warning: manifest chipFamily="${manifest.chipFamily}")`);
    }
    const fileArray = [];
    for (const part of manifest.parts) {
      const data = await fetchBin('./' + part.path);
      fileArray.push({ data: toBinaryString(data), address: part.offset });
      log(`  ${part.path} @ 0x${part.offset.toString(16)} (${data.byteLength} B)`);
    }

    // Write. Erase-whole-flash first (default ON) clears any half-written/garbage
    // flash from a previous failed attempt and makes writes far more reliable.
    const eraseAll = $('eraseFirst')?.checked !== false;
    const compress = $('compress')?.checked !== false; // default ON — proven esp-web-tools path
    setStatus(eraseAll ? 'Flashing (erasing first)… do not unplug.' : 'Flashing… do not unplug.');
    log(`baud=${selectedBaud()} eraseAll=${eraseAll} compress=${compress}`);

    const totals = fileArray.map((f) => f.data.length);
    const grand = totals.reduce((a, b) => a + b, 0) || 1;
    const done = totals.map(() => 0);
    await loader.writeFlash({
      fileArray,
      flashSize: 'keep',   // honor the bootloader header (do not force a size)
      flashMode: 'keep',
      flashFreq: 'keep',
      eraseAll,
      compress,
      reportProgress: (idx, written /*, total */) => {
        done[idx] = written;
        setProgress((done.reduce((a, b) => a + b, 0) / grand) * 100);
      },
    });
    setProgress(100);
    log('Done. Resetting device…');
    // hardReset can throw on native USB — never let it mask a successful flash.
    try { await loader.hardReset(); } catch (e) { log('(reset hint: unplug and replug the device)'); }

    setStatus('✅ Flashed successfully. Open Zigbee2MQTT → Permit join, then reset the board so it pairs.');
    log('Next: open Zigbee2MQTT → Permit join, reset the board. It joins as EndDevice "C6-ENVIRO"');
    log('and stays awake 5 minutes for the interview — do not unplug during that window.');
  } catch (err) {
    console.error(err);
    setStatus('❌ ' + (err.message || err));
    log('ERROR: ' + (err.message || err));
    log('Recovery: unplug, HOLD the BOOT button (GPIO9), plug in while holding, release after ~2s,');
    log('then keep the speed at 115200 with "Erase whole flash first" checked and try again.');
    log('If a previous write left the device wedged, use "Recover device (erase flash only)" first.');
  } finally {
    try { await transport?.disconnect(); } catch {}
    busy = false;
    $('flashBtn').disabled = false;
    $('eraseBtn').disabled = false;
  }
}

// Recovery: connect and erase the whole flash. Use this to un-wedge a device after
// a flash failed mid-write, then flash again.
async function doErase() {
  if (busy) return;
  if (!('serial' in navigator)) { alert('Web Serial is not supported in this browser.'); return; }
  if (!confirm('Erase the entire flash? Do this to recover from a failed flash, then flash again.')) return;

  busy = true;
  $('flashBtn').disabled = true;
  $('eraseBtn').disabled = true;
  $('logBox').classList.remove('hidden');
  $('log').textContent = '';
  setStatus('Select the device serial port…');

  let transport;
  try {
    const { transport: t, loader } = await connect();
    transport = t;
    setStatus('Erasing entire flash… this can take 10–30 s.');
    await loader.eraseFlash();
    setStatus('✅ Flash erased. Now press "Connect & Flash" to install the firmware.');
    log('Erase complete.');
  } catch (err) {
    console.error(err);
    setStatus('❌ ' + (err.message || err));
    log('ERROR: ' + (err.message || err));
    log('Tip: unplug, HOLD BOOT (GPIO9), plug in while holding, release after ~2s, then retry.');
  } finally {
    try { await transport?.disconnect(); } catch {}
    busy = false;
    $('flashBtn').disabled = false;
    $('eraseBtn').disabled = false;
  }
}

/**
 * Wire the two buttons. app.js has already feature-gated the environment and
 * disabled the buttons when flashing is impossible; we still guard inside the
 * handlers so a stray click can never throw.
 * @param {{supported: boolean}} [opts]
 */
export function initFlash(opts = {}) {
  $('flashBtn').addEventListener('click', doFlash);
  $('eraseBtn').addEventListener('click', doErase);
  if (opts.supported === false) {
    $('flashBtn').disabled = true;
    $('eraseBtn').disabled = true;
  }
}
