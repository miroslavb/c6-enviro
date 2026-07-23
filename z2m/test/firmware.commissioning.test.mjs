// Regression guard for the real commissioning failure seen on 2026-07-23.
// Keeping the MCU awake was not enough: rx_on_when_idle=false still put the
// Zigbee radio to sleep between parent polls, so Z2M's active endpoint requests
// timed out. Fresh steering and a BOOT-extended interview window must turn RX on.
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const zbSource = readFileSync(join(ROOT, "firmware/main/zb_device.c"), "utf8");
const mainSource = readFileSync(join(ROOT, "firmware/main/main.c"), "utf8");

function functionBody(source, signature, nextSignature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${signature} not found`);
  const end = source.indexOf(nextSignature, start + signature.length);
  assert.notEqual(end, -1, `${nextSignature} not found after ${signature}`);
  return source.slice(start, end);
}

test("fresh steering enables continuous RX before opening the interview window", () => {
  const steering = functionBody(
    zbSource,
    "case ESP_ZB_BDB_SIGNAL_STEERING:",
    "case ESP_ZB_ZDO_SIGNAL_LEAVE:",
  );
  const enable = steering.indexOf("esp_zb_set_rx_on_when_idle(true);");
  const firstJoin = steering.indexOf("emit(ZB_EVT_FIRST_JOIN);");
  assert.notEqual(enable, -1, "fresh steering leaves the radio sleepy during interview");
  assert.notEqual(firstJoin, -1, "fresh steering does not emit FIRST_JOIN");
  assert.ok(enable < firstJoin, "RX must be continuous before FIRST_JOIN starts Z2M interview timing");
});

test("BOOT interview extension requests continuous RX through the Zigbee task", () => {
  const button = functionBody(
    mainSource,
    "static void on_button_short_press(void)",
    "static void do_measure(bool first_boot)",
  );
  assert.match(button, /zb_device_enable_interview_rx\(\);/);
  assert.match(zbSource, /void zb_device_enable_interview_rx\(void\)/);
});
