// app.js — installer entry point for the C6-ENVIRO sensor (ESP32-C6 Super Mini).
//
// Detect Web-Serial support, wire flashing/recovery, and render a safe
// Zigbee2MQTT settings payload. The page never writes configuration to NVS:
// routine browser flashes preserve the existing device pairing and settings.
import { initFlash } from './flash.js?v=0.1.19';

const $ = (id) => document.getElementById(id);

function checkEnvironment() {
  const hasSerial = 'serial' in navigator;
  const secure = window.isSecureContext;
  if (hasSerial && secure) return true;

  const warn = $('serialWarn');
  const msg = $('serialWarnMsg');
  if (hasSerial && !secure) {
    msg.innerHTML =
      'This page is not running in a <b>secure context</b>. Web Serial flashing requires ' +
      '<b>HTTPS</b> (or <code>localhost</code>). Reopen this page over an <code>https://</code> URL.';
  } else {
    msg.innerHTML =
      "This browser doesn't support the <b>Web Serial</b> API. Use <b>Chrome</b> or <b>Edge</b> " +
      'on desktop (or Chrome on Android) over <b>HTTPS</b> to flash the device.';
  }
  warn.classList.remove('hidden');
  $('flashBtn').disabled = true;
  $('eraseBtn').disabled = true;
  return false;
}

function initPowerSettings() {
  const interval = $('reportIntervalS');
  const gas = $('gasEnabled');
  const payload = $('z2mPayload');
  const copy = $('copyZ2mPayload');
  const status = $('z2mPayloadStatus');
  if (!interval || !gas || !payload || !copy || !status) return;

  function current() {
    let seconds = Number(interval.value);
    if (!Number.isFinite(seconds)) seconds = 3;
    seconds = Math.max(3, Math.min(3600, Math.round(seconds)));
    interval.value = String(seconds);
    return {
      report_interval_s: seconds,
      gas_enabled: gas.checked ? 'ON' : 'OFF',
    };
  }

  function render() {
    payload.textContent = JSON.stringify(current(), null, 2);
  }

  interval.addEventListener('input', render);
  interval.addEventListener('change', render);
  gas.addEventListener('change', render);
  copy.addEventListener('click', async () => {
    const text = JSON.stringify(current());
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      status.textContent = 'Copied. In Zigbee2MQTT, paste it into C6 Enviro → Dev console / Set, or publish it to zigbee2mqtt/C6 Enviro/set.';
    } catch {
      status.textContent = `Copy this payload manually: ${text}`;
    }
  });
  render();
}

const supported = checkEnvironment();
initPowerSettings();
initFlash({ supported });
