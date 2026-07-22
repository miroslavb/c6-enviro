// app.js — installer entry point for the C6-ENVIRO sensor (ESP32-C6 Super Mini).
//
// Single-purpose page: detect Web-Serial support + secure context, then wire the
// "Connect & Flash" and "Recover (erase only)" buttons to flash.js. There is no
// keyboard view, no WiFi form, no relay, no cfg-blob — the device talks to Home
// Assistant over Zigbee, so nothing needs to be baked in at flash time.
import { initFlash } from './flash.js';

const $ = (id) => document.getElementById(id);

/**
 * Decide whether this browser/context can flash at all and, if not, show a
 * specific reason. Web Serial requires (a) a Chromium-family browser that
 * implements `navigator.serial` and (b) a secure context (HTTPS or localhost).
 * We distinguish the two so the user gets actionable advice.
 *
 * @returns {boolean} true if flashing is possible.
 */
function checkEnvironment() {
  const hasSerial = 'serial' in navigator;
  // `isSecureContext` is true for https:// and for http://localhost — Web Serial
  // is gated on it independently of the API's mere presence.
  const secure = window.isSecureContext;

  if (hasSerial && secure) return true;

  const warn = $('serialWarn');
  const msg = $('serialWarnMsg');
  if (hasSerial && !secure) {
    // The API exists but we're not in a secure context (e.g. served over plain
    // http:// to a non-localhost host). requestPort() would throw.
    msg.innerHTML =
      'This page is not running in a <b>secure context</b>. Web Serial flashing requires ' +
      '<b>HTTPS</b> (or <code>localhost</code>). Reopen this page over an <code>https://</code> URL.';
  } else {
    // No navigator.serial at all → wrong browser (Firefox/Safari, or iOS).
    msg.innerHTML =
      "This browser doesn't support the <b>Web Serial</b> API. Use <b>Chrome</b> or <b>Edge</b> " +
      'on desktop (or Chrome on Android) over <b>HTTPS</b> to flash the device.';
  }
  warn.classList.remove('hidden');
  $('flashBtn').disabled = true;
  $('eraseBtn').disabled = true;
  return false;
}

const supported = checkEnvironment();
// Always wire the buttons (initFlash also feature-gates internally); when the
// environment is unsupported they're already disabled above.
initFlash({ supported });
