// Regression guard for the live C6 Enviro interview failure seen on 2026-07-23.
// v0.1.0 interviewed successfully while its reporting slots were rejected; after
// reporting was fixed (min_interval=1), the ZED started its own bind/report traffic
// at the same time as herdsman's ZDO interview and activeEpRsp began timing out.
// The solar sensor must remain a sleepy/polling end device: phase-separate a quiet
// interview window from outbound reporting instead of switching to always-on RX.
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const zbSource = readFileSync(join(ROOT, "firmware/main/zb_device.c"), "utf8");
const zbHeader = readFileSync(join(ROOT, "firmware/main/zb_device.h"), "utf8");
const mainSource = readFileSync(join(ROOT, "firmware/main/main.c"), "utf8");

function functionBody(source, signature, nextSignature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${signature} not found`);
  const end = source.indexOf(nextSignature, start + signature.length);
  assert.notEqual(end, -1, `${nextSignature} not found after ${signature}`);
  return source.slice(start, end);
}

test("solar ZED never switches to always-on RX", () => {
  assert.doesNotMatch(zbSource, /esp_zb_set_rx_on_when_idle\s*\(\s*true\s*\)/,
    "always-on RX violates the battery/solar sleepy-end-device contract");
  assert.doesNotMatch(zbSource + zbHeader + mainSource, /zb_device_enable_interview_rx/,
    "obsolete always-on interview helper is still referenced");

  const task = functionBody(zbSource, "static void zb_task(void *arg)", "esp_err_t zb_device_start(");
  const sleepy = task.indexOf("esp_zb_set_rx_on_when_idle(false);");
  const start = task.indexOf("esp_zb_start(false)");
  assert.notEqual(sleepy, -1, "ZED startup does not explicitly select sleepy RX");
  assert.notEqual(start, -1, "Zigbee stack start not found");
  assert.ok(sleepy < start, "sleepy capability must be selected before stack startup");
});

test("recovery firmware uses a unique local-admin EUI before stack startup", () => {
  assert.match(zbSource,
    /DEVICE_IEEE_ADDR\s*=\s*\{\s*0x8c\s*,\s*0x3d\s*,\s*0x1a\s*,\s*0xfe\s*,\s*0xff\s*,\s*0x49\s*,\s*0xfd\s*,\s*0x8e\s*,?\s*\}/i,
    "expected little-endian EUI for 0x8efd49fffe1a3d8c is missing");

  const task = functionBody(zbSource, "static void zb_task(void *arg)", "esp_err_t zb_device_start(");
  const init = task.indexOf("esp_zb_init(&zb_cfg);");
  const setAddress = task.indexOf("esp_zb_set_long_address(DEVICE_IEEE_ADDR)");
  const start = task.indexOf("esp_zb_start(false)");
  assert.notEqual(init, -1, "Zigbee core init not found");
  assert.notEqual(setAddress, -1, "custom EUI is not applied");
  assert.notEqual(start, -1, "Zigbee stack start not found");
  assert.ok(init < setAddress && setAddress < start,
    "custom EUI must be applied after core init and before stack startup");
});

test("factory-new steering fast-polls before the BDB security handshake", () => {
  const steering = functionBody(
    zbSource,
    "static void start_steering(void)",
    "static void steering_retry_cb(uint8_t param)",
  );
  const fastPoll = steering.indexOf("ezb_nwk_set_keepalive_interval(INTERVIEW_POLL_MS);");
  const bdb = steering.indexOf("esp_zb_bdb_start_top_level_commissioning(ESP_ZB_BDB_MODE_NETWORK_STEERING);");
  assert.notEqual(fastPoll, -1,
    "sleepy child does not fast-poll while waiting for the trust-center transport key");
  assert.notEqual(bdb, -1, "BDB network steering call not found");
  assert.ok(fastPoll < bdb,
    "fast parent polling must begin before the BDB security handshake starts");
});

test("fresh and restored commissioning defer self-reporting behind a 60 s quiet window", () => {
  assert.match(zbSource, /#define\s+INTERVIEW_QUIET_MS\s+60000u?/,
    "commissioning needs a bounded quiet period for herdsman ZDO interview");
  assert.match(zbSource, /schedule_self_reporting\s*\(\s*true\s*\)/,
    "fresh steering does not defer reporting");
  assert.match(zbSource, /schedule_self_reporting\s*\(\s*s_commissioning_boot\s*\)/,
    "restored-network cold boot does not defer reporting");

  const signals = functionBody(
    zbSource,
    "void esp_zb_app_signal_handler(esp_zb_app_signal_t *signal_struct)",
    "// ===========================================================================\n// Stack task",
  );
  assert.doesNotMatch(signals, /setup_self_reporting\s*\(\s*\)/,
    "join handler starts bind/report traffic synchronously during interview");
  assert.match(zbSource, /emit\s*\(\s*ZB_EVT_REPORTING_READY\s*\)/,
    "delayed reporting setup does not signal readiness to main");
});

test("bounded fast parent polling serves the quiet interview phase", () => {
  assert.match(zbSource, /#define\s+INTERVIEW_POLL_MS\s+200u?/,
    "commissioning parent-poll interval must be explicitly bounded at 200 ms");

  const callback = functionBody(
    zbSource,
    "static void setup_self_reporting_cb(uint8_t param)",
    "static void schedule_self_reporting(bool quiet)",
  );
  const restore = callback.indexOf("ezb_nwk_set_keepalive_interval(ED_KEEP_ALIVE_MS);");
  const setup = callback.indexOf("setup_self_reporting();");
  assert.notEqual(restore, -1, "normal 1 s keepalive is not restored after quiet phase");
  assert.ok(restore < setup, "normal keepalive must be restored before reporting starts");

  const schedule = functionBody(
    zbSource,
    "static void schedule_self_reporting(bool quiet)",
    "// ===========================================================================\n// Measurement push",
  );
  assert.match(schedule,
    /if\s*\(quiet\)[\s\S]*?ezb_nwk_set_keepalive_interval\s*\(\s*INTERVIEW_POLL_MS\s*\)/,
    "quiet phase does not accelerate sleepy parent polling");
});

test("stale reporting alarms cannot escape across leave/rejoin", () => {
  const schedule = functionBody(
    zbSource,
    "static void schedule_self_reporting(bool quiet)",
    "// ===========================================================================\n// Measurement push",
  );
  const cancel = schedule.indexOf("esp_zb_scheduler_alarm_cancel(setup_self_reporting_cb, 0);");
  const alarm = schedule.indexOf("esp_zb_scheduler_alarm(setup_self_reporting_cb, 0, delay_ms);");
  assert.notEqual(cancel, -1, "new reporting schedule does not cancel the prior alarm");
  assert.notEqual(alarm, -1, "reporting alarm schedule not found");
  assert.ok(cancel < alarm, "prior reporting alarm must be cancelled before replacement");

  const leave = functionBody(
    zbSource,
    "case ESP_ZB_ZDO_SIGNAL_LEAVE:",
    "default:",
  );
  assert.match(leave, /esp_zb_scheduler_alarm_cancel\s*\(\s*setup_self_reporting_cb\s*,\s*0\s*\)/,
    "LEAVE does not invalidate the delayed reporting callback");
});

test("LEFT wins over REPORTING_READY when both event bits are present", () => {
  const wait = functionBody(
    mainSource,
    "static bool wait_for_reporting_ready(void)",
    "void app_main(void)",
  );
  const left = wait.indexOf("if (bits & EVT_LEFT)");
  const ready = wait.indexOf("if (bits & EVT_REPORTING_READY)");
  assert.notEqual(left, -1, "reporting wait does not handle LEFT explicitly");
  assert.notEqual(ready, -1, "reporting wait does not handle READY");
  assert.ok(left < ready, "LEFT must take priority over a stale READY bit");
});

test("main passes cold-boot context and waits for reporting readiness before first push", () => {
  assert.match(zbHeader, /ZB_EVT_REPORTING_READY/);
  assert.match(zbHeader, /zb_device_start\s*\(\s*zb_event_cb_t\s+cb\s*,\s*bool\s+commissioning_boot\s*\)/);
  assert.match(mainSource, /zb_device_start\s*\(\s*zb_event_handler\s*,\s*first_boot\s*\)/);
  assert.match(mainSource, /EVT_REPORTING_READY/);

  const readyWait = mainSource.indexOf("EVT_REPORTING_READY");
  const firstPush = mainSource.indexOf("zb_device_push_measurement();");
  assert.notEqual(readyWait, -1, "main never waits for delayed reporting setup");
  assert.notEqual(firstPush, -1, "measurement push not found");
  assert.ok(readyWait < firstPush, "measurement is pushed before reporting setup is ready");
});

test("BOOT extends the awake window without changing the sleepy radio capability", () => {
  const button = functionBody(
    mainSource,
    "static void on_button_short_press(void)",
    "static void do_measure(bool first_boot)",
  );
  assert.doesNotMatch(button, /zb_device_enable_interview_rx\s*\(/,
    "BOOT must not turn a solar sleepy end device into an always-on receiver");
  assert.match(button, /s_awake_until_us\s*=/,
    "BOOT no longer extends the bounded commissioning window");
});
