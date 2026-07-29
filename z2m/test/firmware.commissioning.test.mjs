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

test("solar ZED is sleepy by default and opens RX only for a bounded interview window", () => {
  const task = functionBody(zbSource, "static void zb_task(void *arg)", "esp_err_t zb_device_start(");
  const sleepy = task.indexOf("esp_zb_set_rx_on_when_idle(false);");
  const start = task.indexOf("esp_zb_start(false)");
  assert.notEqual(sleepy, -1, "ZED startup does not explicitly select sleepy RX");
  assert.notEqual(start, -1, "Zigbee stack start not found");
  assert.ok(sleepy < start, "sleepy capability must be selected before stack startup");

  assert.match(zbHeader, /void\s+zb_device_enable_interview_rx\s*\(\s*void\s*\)/,
    "main has no bounded interview-window hook");
  const enable = functionBody(
    zbSource,
    "static void enable_interview_rx_cb(uint8_t param)",
    "void zb_device_enable_interview_rx(void)",
  );
  assert.match(enable, /esp_zb_set_rx_on_when_idle\s*\(\s*true\s*\)/,
    "the temporary interview window never enables RX");
  assert.match(enable, /esp_zb_scheduler_alarm\s*\(\s*disable_interview_rx_cb\s*,\s*0\s*,\s*\(uint32_t\)AWAKE_WINDOW_S\s*\*\s*1000u\s*\)/,
    "continuous RX is not bounded to AWAKE_WINDOW_S");
  const disable = functionBody(
    zbSource,
    "static void disable_interview_rx_cb(uint8_t param)",
    "static void enable_interview_rx_cb(uint8_t param)",
  );
  assert.match(disable, /esp_zb_set_rx_on_when_idle\s*\(\s*false\s*\)/,
    "the bounded interview window never restores sleepy RX");
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
  assert.match(signals, /if\s*\(\s*s_commissioning_boot\s*\)\s*\{\s*zb_device_enable_interview_rx\s*\(\s*\)/,
    "a cold boot with restored NVRAM does not open a bounded RX interview window");
  assert.match(signals, /case ESP_ZB_BDB_SIGNAL_STEERING:[\s\S]*?zb_device_enable_interview_rx\s*\(\s*\)/,
    "a fresh steering join does not open a bounded RX interview window");
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
  const setup = callback.indexOf("setup_self_reporting(s_wake_local_heartbeat);");
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

test("sole normal-wake push clears a full reporting tick plus scheduler guard", () => {
  assert.match(zbSource, /#define\s+REPORTING_MIN_INTERVAL_S\s+1u?/,
    "this ZED's reporting minimum must stay explicit and shared with its settle calculation");
  assert.match(zbSource, /#define\s+REPORTING_TICK_GUARD_MS\s+200u?/,
    "normal wake needs a positive post-tick scheduler guard");

  const ready = functionBody(
    zbSource,
    "static void reporting_ready_cb(uint8_t param)",
    "static void setup_self_reporting_cb(uint8_t param)",
  );
  assert.match(ready, /emit\s*\(\s*ZB_EVT_REPORTING_READY\s*\)/,
    "the delayed callback must release main's first measurement push");

  const setup = functionBody(
    zbSource,
    "static void setup_self_reporting_cb(uint8_t param)",
    "static void schedule_self_reporting(bool quiet)",
  );
  const configure = setup.indexOf("setup_self_reporting(s_wake_local_heartbeat);");
  const delayedReady = setup.indexOf("cycle_reporting_settle_ms(");
  const prime = setup.indexOf("mirror_measurement_attributes(&g_measurement);");
  assert.notEqual(prime, -1,
    "normal wake must prime the measured ZCL values before its heartbeat deadline starts");
  assert.notEqual(configure, -1, "device-side reporting setup is missing its wake-local mode");
  assert.ok(prime < configure,
    "the reporting engine must never see reset-zero attributes before a normal-wake heartbeat");
  assert.notEqual(delayedReady, -1, "normal wake has no derived post-registration settle");
  assert.ok(configure < delayedReady,
    "reporting slots must be registered before the whole-tick settle begins");
  assert.match(setup,
    /esp_zb_scheduler_alarm\s*\(\s*reporting_ready_cb\s*,\s*0\s*,\s*cycle_reporting_settle_ms\s*\(\s*REPORTING_MIN_INTERVAL_S\s*,\s*REPORTING_TICK_GUARD_MS\s*\)\s*\)/,
    "normal wake must wait through a whole extra reporting tick instead of relying on a 1.2 s literal");
  assert.doesNotMatch(setup, /REPORTING_SETTLE_MS/,
    "the fragile fixed 1.2 s settle must not return");
  assert.doesNotMatch(setup, /emit\s*\(\s*ZB_EVT_REPORTING_READY\s*\)/,
    "REPORTING_READY must not be emitted synchronously inside reporting setup");

  const slots = functionBody(
    zbSource,
    "static void setup_self_reporting(bool wake_local_heartbeat)",
    "static void reporting_ready_cb(uint8_t param)",
  );
  assert.match(slots,
    /const\s+uint16_t\s+max_interval\s*=\s*wake_local_heartbeat\s*\?\s*cycle_reporting_wake_heartbeat_max_interval_s\s*\(\s*REPORTING_MIN_INTERVAL_S\s*\)\s*:\s*cycle_reporting_max_interval_s\s*\(\s*g_config\.report_interval_s\s*,\s*REPORTING_MIN_INTERVAL_S\s*\)/,
    "normal deep-sleep wake must create a heartbeat deadline that fits before its reporting-ready release");
  assert.match(slots,
    /max_interval\s*=\s*max_interval\s*;/,
    "the active ZCL reporting maximum must use the selected wake-local/configured deadline");
  assert.match(slots,
    /def_max_interval\s*=\s*max_interval\s*;/,
    "the default ZCL reporting maximum must match the selected deadline");
  assert.doesNotMatch(slots, /max_interval\s*=\s*3600/,
    "a one-hour static heartbeat cannot satisfy a 3–3600s sleepy cadence");
});

test("normal wake retains the radio through the strict heartbeat deadline after its final push", () => {
  const push = functionBody(
    zbSource,
    "static void push_cb(uint8_t param)",
    "void zb_device_push_measurement(void)",
  );
  assert.match(push,
    /const\s+uint32_t\s+flush_ms\s*=\s*cycle_reporting_post_push_flush_ms\s*\(\s*CONFIG_ENVIRO_REPORT_FLUSH_MS\s*,\s*s_wake_local_heartbeat\s*,\s*REPORTING_MIN_INTERVAL_S\s*,\s*REPORTING_TICK_GUARD_MS\s*\)/,
    "normal wake must derive its post-push flush from the wake-local heartbeat deadline");
  assert.match(push,
    /esp_zb_scheduler_alarm\s*\(\s*flush_done_cb\s*,\s*0\s*,\s*flush_ms\s*\)/,
    "flush completion must wait for the derived post-push interval");
});

test("normal timer wakes reserve a bounded fast-poll slot for queued controls", () => {
  assert.match(zbSource, /#define\s+NORMAL_CONTROL_POLL_WINDOW_MS\s+1000u?/,
    "normal deep-sleep wakes need a one-second control receive budget");

  const schedule = functionBody(
    zbSource,
    "static void schedule_self_reporting(bool quiet)",
    "// ===========================================================================\n// Measurement push",
  );
  assert.match(schedule,
    /const\s+uint32_t\s+delay_ms\s*=\s*quiet\s*\?\s*INTERVIEW_QUIET_MS\s*:\s*NORMAL_CONTROL_POLL_WINDOW_MS/,
    "normal wake still starts reporting immediately instead of receiving queued controls first");
  assert.match(schedule,
    /s_wake_local_heartbeat\s*=\s*!quiet\s*;/,
    "only ordinary timer wakes may use the short wake-local heartbeat deadline");
  assert.match(schedule,
    /else\s*\{[\s\S]*?ezb_nwk_set_keepalive_interval\s*\(\s*INTERVIEW_POLL_MS\s*\)/,
    "normal control slot does not use fast sleepy-parent polling");
  assert.doesNotMatch(schedule, /esp_zb_set_rx_on_when_idle\s*\(\s*true\s*\)/,
    "normal control slot must not turn the solar ZED into an always-on receiver");
});

test("normal timer wakes check in through standard Poll Control before reporting", () => {
  assert.match(zbSource, /esp_zb_cluster_list_add_poll_control_cluster\s*\(/,
    "EP1 must expose a standard Poll Control server for coordinated sleepy downlinks");
  assert.match(zbSource, /\.check_in_interval\s*=\s*POLL_CONTROL_CHECKIN_INTERVAL_QS\b/,
    "the five-minute cold-boot window needs periodic CheckIn for controls queued after startup");

  const checkin = functionBody(
    zbSource,
    "static void send_poll_control_checkin(void)",
    "// ===========================================================================\n// SET_ATTR write router",
  );
  assert.match(checkin, /esp_zb_zcl_poll_control_check_in_cmd_req\s*\(/,
    "the normal wake path never asks Zigbee2MQTT to flush pending requests");
  assert.match(checkin, /dst_addr_u\.addr_short\s*=\s*POLL_CONTROL_COORDINATOR_SHORT_ADDR/,
    "Poll Control CheckIn must target the coordinator directly");

  const signals = functionBody(
    zbSource,
    "void esp_zb_app_signal_handler(esp_zb_app_signal_t *signal_struct)",
    "// ===========================================================================\n// Stack task",
  );
  const normalBranch = signals.indexOf("if (!s_commissioning_boot)");
  const checkinCall = signals.indexOf("send_poll_control_checkin();", normalBranch);
  const reportingCall = signals.indexOf("schedule_self_reporting(s_commissioning_boot);", normalBranch);
  assert.notEqual(normalBranch, -1, "restored-network signal has no normal-wake branch");
  assert.notEqual(checkinCall, -1, "normal timer wake does not emit Poll Control CheckIn");
  assert.ok(checkinCall < reportingCall,
    "CheckIn must open the queued-control window before reporting begins");
});

test("stale reporting alarms cannot escape across leave/rejoin", () => {
  const schedule = functionBody(
    zbSource,
    "static void schedule_self_reporting(bool quiet)",
    "// ===========================================================================\n// Measurement push",
  );
  const cancelSetup = schedule.indexOf("esp_zb_scheduler_alarm_cancel(setup_self_reporting_cb, 0);");
  const cancelReady = schedule.indexOf("esp_zb_scheduler_alarm_cancel(reporting_ready_cb, 0);");
  const alarm = schedule.indexOf("esp_zb_scheduler_alarm(setup_self_reporting_cb, 0, delay_ms);");
  assert.notEqual(cancelSetup, -1, "new reporting schedule does not cancel the prior setup alarm");
  assert.notEqual(cancelReady, -1, "new reporting schedule does not cancel the prior delayed-ready alarm");
  assert.notEqual(alarm, -1, "reporting alarm schedule not found");
  assert.ok(cancelSetup < alarm && cancelReady < alarm,
    "all prior reporting alarms must be cancelled before replacement");

  const leave = functionBody(
    zbSource,
    "case ESP_ZB_ZDO_SIGNAL_LEAVE:",
    "default:",
  );
  assert.match(leave, /esp_zb_scheduler_alarm_cancel\s*\(\s*setup_self_reporting_cb\s*,\s*0\s*\)/,
    "LEAVE does not invalidate the delayed reporting-setup callback");
  assert.match(leave, /esp_zb_scheduler_alarm_cancel\s*\(\s*reporting_ready_cb\s*,\s*0\s*\)/,
    "LEAVE does not invalidate the delayed reporting-ready callback");
});

test("LEFT wins over REPORTING_READY when both event bits are present", () => {
  const wait = functionBody(
    mainSource,
    "static cycle_report_action_t wait_for_reporting_ready(void)",
    "void app_main(void)",
  );
  const left = wait.indexOf("if (bits & EVT_LEFT)");
  const ready = wait.indexOf("if (bits & EVT_REPORTING_READY)");
  assert.notEqual(left, -1, "reporting wait does not handle LEFT explicitly");
  assert.notEqual(ready, -1, "reporting wait does not handle READY");
  assert.ok(left < ready, "LEFT must take priority over a stale READY bit");
});

test("LEAVE while reporting settles re-enters join flow instead of sleeping", () => {
  const recover = functionBody(
    mainSource,
    "static bool wait_for_network_and_reporting(bool cold_boot)",
    "void app_main(void)",
  );
  assert.match(recover, /for\s*\(\s*;\s*;\s*\)/,
    "network/reporting recovery is not retryable");
  assert.match(recover, /case\s+CYCLE_REPORT_REJOIN\s*:\s*continue\s*;/,
    "LEFT during reporting setup still exits toward deep sleep instead of rejoining");
  assert.doesNotMatch(recover, /go_to_sleep\s*\(/,
    "the recovery helper must return timeout to its caller, not sleep on LEFT");

  const app = mainSource.slice(mainSource.indexOf("void app_main(void)"));
  assert.match(app, /wait_for_network_and_reporting\s*\(\s*first_boot\s*\)/,
    "initial startup does not use the retryable network/reporting lifecycle");
});

test("mid-cycle fresh rejoin reopens the five-minute commissioning window", () => {
  const waitNetwork = functionBody(
    mainSource,
    "static bool wait_for_network(bool cold_boot)",
    "static bool wait_for_network_and_reporting(bool cold_boot)",
  );
  assert.match(waitNetwork,
    /cycle_join_opens_awake_window\s*\(\s*\(bits\s*&\s*EVT_FIRST_JOIN\)\s*!=\s*0\s*,\s*cold_boot\s*\)/,
    "join handling does not classify a fresh rejoin independently of original boot cause");
  assert.match(waitNetwork, /s_awake_until_us\s*=/,
    "the classified commissioning join does not arm the MCU awake window");

  const app = mainSource.slice(mainSource.indexOf("void app_main(void)"));
  const leftStart = app.indexOf("if (bits & EVT_LEFT)");
  const afterLeft = app.indexOf("const uint32_t awake_ms", leftStart);
  assert.ok(leftStart >= 0 && afterLeft > leftStart, "mid-cycle LEFT branch not found");
  const leftBranch = app.slice(leftStart, afterLeft);
  assert.match(leftBranch, /wait_for_network_and_reporting\s*\(\s*false\s*\)/,
    "mid-cycle leave bypasses the shared rejoin/window/reporting lifecycle");
  assert.doesNotMatch(leftBranch,
    /xEventGroupWaitBits\s*\(\s*s_events\s*,\s*EVT_JOINED\s*\|\s*EVT_FIRST_JOIN/,
    "mid-cycle leave still duplicates join handling without rearming the window");
});

test("failed rejoin cannot outlive both join and commissioning deadlines", () => {
  const waitNetwork = functionBody(
    mainSource,
    "static bool wait_for_network(bool cold_boot)",
    "static bool wait_for_network_and_reporting(bool cold_boot)",
  );
  assert.match(waitNetwork,
    /cycle_join_wait_expired\s*\(\s*esp_timer_get_time\s*\(\s*\)\s*,\s*t_start\s*,\s*CONFIG_ENVIRO_JOIN_TIMEOUT_S\s*,\s*s_awake_until_us\s*\)/,
    "join wait does not apply a bounded deadline that includes the active commissioning window");
  assert.doesNotMatch(waitNetwork, /s_awake_until_us\s*==\s*0/,
    "a stale nonzero awake timestamp still disables the failed-rejoin timeout");
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

test("BOOT extends the bounded MCU and RX interview windows", () => {
  const button = functionBody(
    mainSource,
    "static void on_button_short_press(void)",
    "static void do_measure(bool first_boot)",
  );
  assert.match(button, /zb_device_enable_interview_rx\s*\(\s*\)/,
    "BOOT must reopen the bounded RX window for a manual Z2M re-interview");
  assert.match(button, /s_awake_until_us\s*=/,
    "BOOT no longer extends the bounded commissioning window");
});

test("timer deep-sleep wakes never initialize the WS2812 status strip", () => {
  const app = mainSource.slice(mainSource.indexOf("void app_main(void)"));
  assert.match(app, /if\s*\(\s*first_boot\s*&&\s*led_init\s*\(\s*\)\s*==\s*ESP_OK\s*\)/,
    "LED initialization must be gated before the call on a timer wake");
  assert.doesNotMatch(app, /if\s*\(\s*led_init\s*\(\s*\)\s*==\s*ESP_OK\s*&&\s*first_boot\s*\)/,
    "C evaluates led_init() before first_boot in the old order, waking the RGB driver every cycle");
});
