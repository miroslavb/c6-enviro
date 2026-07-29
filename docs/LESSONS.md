# LESSONS — consolidated gotchas

Every item is **symptom → fix**, with provenance. Sources:
**[kbd]** = ESP32-S3 web-installer (`/root/kbd-web-keyboard`), **[C6]** =
`c6-lcd-zigbee` research + hardware bring-up, **[rad]** = `c6-radiometer` on-hardware
war stories, **[env]** = new findings from THIS project (sleepy end device + solar).

The full inherited lists live in the sibling repos
(`c6-lcd-zigbee/docs/LESSONS.md`, 28 items; `c6-radiometer/docs/LESSONS.md`).
Below: the ones that shaped this firmware, plus everything new.

---

## A. Inherited and still binding (short form)

1. **esptool-js 0.5.7 vendored, compression ON; 115200 with `romBaudrate === baudrate`;
   erase-first default OFF; data as chunked binary STRINGS; `hardReset()` in try/catch;
   HTTPS + Chrome/Edge only.** [kbd] — the entire flasher stack, reused verbatim.
2. **C6 bootloader at offset 0x0; read real offsets from `flasher_args.json`.** [kbd→C6]
3. **Hold BOOT (GPIO9) → plug USB = the primary un-stick path** for the C6's flaky
   native-USB auto-reset. [C6]
4. **GPIO12/13 are USB — never touch.** [C6]
5. **esp-zigbee-lib 2.x: ONE component, `CONFIG_ZB_SDK_1xx=y` for the 1.x API;
   `ESP_ZB_ZR/ED_CONFIG()` macros don't exist — build `esp_zb_cfg_t` by hand.** [C6 #27]
6. **`zb_storage` partition subtype MUST be `nvs`** (the 1.x-era `fat` makes
   `nvs_open_from_partition` fail → `esp_zb_init` abort()s), and init it defensively. [rad]
7. **Custom clusters are unsafe in both directions on the current Z2M + ESP-Zigbee compat path.**
   *Symptom:* Z2M cannot decode incoming custom reports (`msg.cluster` undefined), and
   custom `READ_WRITE` attributes return `NOT_AUTHORIZED` on the device. *Fix:* **all
   telemetry and controls ride standard clusters**; v0.1.11 maps interval to
   `genAnalogOutput.presentValue` and gas enable to `genOnOff` commands on EP1. [rad/env]
8. **Manual `esp_zb_zcl_report_attr_cmd_req` never emitted a single frame** across five
   variants (and correlated with a reboot loop) → use the **stack reporting engine**:
   self-bind to the coordinator + `esp_zb_zcl_update_reporting_info`. [rad]
9. **`esp_zb_set_tx_power(20)`** — the stack default is low; ZDO replies barely reached
   the coordinator (asymmetric link, interview timeouts). [rad]
10. **One guarded steering-retry chain; LEAVE during commissioning is failed-assoc
    cleanup, NOT a real leave** — reacting to it multiplies scan chains without bound
    ("the great rejoin saga of 2026-07-10"). [rad]
11. **Channel: primary = coordinator's (11), secondary = all; permit-join must be open
    or steering fails silently.** [C6/rad]
12. **A standard-cluster control plane avoids manufacturer-code coupling.**
    The current Enviro converter uses `genAnalogOutput` / `genOnOff`; do not add
    manufacturer-specific writes back merely to reuse an old field ID. [env]

## B. New in this project [env]

13. **Deep sleep ≠ light sleep in esp-zigbee — different machinery, don't mix.**
    *Symptom:* copying `CONFIG_PM_ENABLE` / tickless / `CONFIG_IEEE802154_SLEEP_ENABLE` /
    `esp_zb_sleep_enable()` from the light_sleep example into a deep-sleep build adds
    nothing and confuses the stack. *Fix:* pure deep sleep needs NONE of that — just
    `esp_deep_sleep_start()`; the 2.x compat layer even stubs `esp_zb_sleep_enable`
    to a no-op. Network state persists in `zb_storage`; every wake is a reboot that
    emits `DEVICE_REBOOT` (non-factory-new) and re-attaches to the parent without
    steering.
14. **A sleepy device that naps mid-interview never finishes pairing.**
    *Symptom:* device joins, Z2M shows it "unsupported / interview failed", entities
    missing. *Fix:* after a factory-new join stay awake long enough for the whole
    interview — this firmware holds a **5-minute window** (and BOOT re-opens it).
    The SDK example's 5 s is far too short (Z2M FAQ suggests pressing a button every
    3 s — same idea).
15. **`batteryVoltage` (0x0020) is not reportable by the stack** (esp-zigbee-sdk
    issue #463). *Fix:* report only `batteryPercentageRemaining` (0x0021); expose the
    precise mV on an Analog Input endpoint instead.
16. **Z2M divides `batteryPercentageRemaining` by 2.** Report ZCL-compliant 0–200
    half-percent units, or your battery shows 50 % when full.
17. **Reporting min_interval must be 0 for a deep-sleeping reporter.**
    With the radiometer's min=5 s a 3 s-cycle device would fall asleep before the
    engine is allowed to transmit. min=0 + delta=0 → attribute set → frame goes out
    immediately, inside the flush window.
18. **`wake_count` as a reported channel = free liveness.** Static air → static T/H/P
    → no reports → HA can't tell "asleep" from "dead". A counter that changes every
    cycle guarantees one report per wake; `last_seen` becomes the heartbeat.
19. **BOOT (GPIO9) cannot wake the C6 from deep sleep** — LP GPIOs are 0–7 only.
    Press it during a wake slice (the device is awake ~2.5 s of every 3 s cycle) or
    tap RESET. Don't burn an LP pin on a wake button unless you really need it.
20. **The unjoined state is the battery killer.** Steering = continuous active scan
    ≈ 80 mA. A device flashed in the field with permit-join closed would flatten a
    2000 mAh cell in ~24 h. *Fix:* 60 s join budget → deep sleep 60 s → retry.
21. **Super Mini board leaks in deep sleep** (~50–400 µA depending on clone): the
    WS2812's control IC draws from 3V3 even when dark, plus LDO quiescent. Desolder
    the WS2812 for µA-class sleep; irrelevant at 3 s cadence, dominant at 1 h.
22. **Power the C6 from the battery terminal, not the manager's 5 V boost.** The
    (D)'s boost lists up to tens of mA quiescent — more than the entire sensor
    budget. BAT+ → VIN(5V) pin; the LDO takes 3.0–4.2 V fine. The manager is just a
    charger.
23. **BME680 gas value is only trustworthy with `GASM_VALID` + `HEAT_STAB` set** —
    the first cycles after power-on routinely report unstable heater; surface it as
    a status bit instead of publishing garbage ohms. Integer-mode humidity is
    **%×1000** (not ×100 like temperature) — divide by 10 for the ZCL encoding.
24. **"BME860" does not exist** — the Bosch gas-sensor family is BME680/BME688 (same
    registers/API). Wiring and firmware here fit both.

## C. Field bring-up saga (2026-07-23) — open + closed items

25. **Sensor + I²C are perfect** — console shows real `BME680@0x77: T=23–27 °C
    RH=40–45 % P=98010 Pa gas=…Ω`, calib genuine (`par_t1=26092 par_t2=26574
    variant=0`). No hardware fault anywhere. Every problem below is firmware/Zigbee.
26. **`temperature = 0` in HA while RH/P are live** — the standard 0x0402 write path;
    v0.1.2 added `set temp(0x0402) -> zcl status` logging + T/RH/P MIRRORS on AI
    EP6-8 as a workaround. NOT root-caused yet (need the zcl-status line from a live
    join).
27. **Device-side reporting never registered** — `esp_zb_zcl_update_reporting_info`
    returned `ESP_ERR_INVALID_ARG` for EVERY slot: the **ZED ZBOSS build rejects
    `min_interval = 0`** (router builds used 5..30 and never tripped it). Fixed in
    v0.1.4 → min 1 s. Until v0.1.4, all live data rode Z2M's *coordinator-side*
    configureReporting only.
28. **⭐ THE interview regression (user's key hint: "the first interview passed").**
    v0.1.0 had **5 endpoints** and interviewed in 23 s. v0.1.2 added the T/RH/P
    mirror endpoints → **8 endpoints**. A sleepy ZED (radio only on during ~1 s
    parent polls), competing with a Tuya DIN-meter's cluster flood, cannot answer
    Active_EP_req + 8 simple-descriptor reads before herdsman's interview timeout →
    `Interview failed ... can not get active endpoints`. The Z2M DB confirms it:
    `endpoints 1..8, modelId C6-ENVIRO, swBuildId 0.1.0, interviewCompleted:false`.
    **v0.1.5 implementation:** drop EP6/7/8 and return to EP1..EP5. The contract,
    firmware endpoint table, reporting slots, converter, tests and browser binary all
    enforce this budget. T/RH/P are again carried only by their standard EP1 clusters;
    the v0.1.4 device-side min=1 reporting fix is retained. Fresh hardware interview
    is the acceptance test — do not claim the regression closed until Z2M records
    `interviewCompleted:true` with endpoints `[1,2,3,4,5]`. Data DID flow at 04:22
    (T/RH/P/battery/gas) even with `interviewCompleted:false`, but a successful
    interview is required for clean HA discovery and reliable configuration.
29. **Operational hazards to avoid next time:** (a) don't `force-remove` + rejoin —
    it leaves a half-known device that interviews worse than a clean factory-new
    join; (b) the CH340 coordinator (Z-Stack 20210708) wedges "in bootloader" when
    the serial port is reopened — every Z2M restart is a gamble against the
    DIN-meter flood; migrate to the spare ZBDongle-E (ember) — runbook pending;
    (c) flashing a deep-sleeper needs BOOT-hold→RESET (freeze in ROM loader), the
    port mirrors with the 3 s sleep cycle otherwise; (d) close the flasher tab
    before opening the web console — the serial port is exclusive.
30. **The continuous-RX hypothesis was falsified, not validated.** v0.1.5 returned
    to five endpoints but still failed `activeEpRsp`; v0.1.6 then changed the joined
    ZED to `rx_on_when_idle=true`. That was only a hypothesis and never passed the
    required hardware gate. It also conflicts with the user's solar/battery contract:
    Enviro must remain a sleepy, parent-polled end device on every path.
31. **Firmware updates preserve Zigbee NVRAM, so fresh steering is not guaranteed —
    but reopening continuous RX did not solve it.** v0.1.7 added a cold-boot path for
    restored-network `JOINED`. Under a fully started, stable Z2M with the Supervisor
    watchdog disabled, the board delivered dense uplink telemetry at LQI 84–93 while
    herdsman still failed active endpoints. The database remained
    `interviewCompleted:false`, `interviewState:FAILED`, `epList:[1,2,3,4,5]`.
32. **The regression boundary is reporting activation, so commissioning must be
    phase-separated.** v0.1.0 interviewed in 23 s with five endpoints while its
    device-side reporting slots were rejected (`min_interval=0`). v0.1.4 made those
    slots work with min=1; from then on the device started eight self-bind/reporting
    workloads at the same moment as herdsman's ZDO interview. Data reached Z2M/HA,
    but active-endpoint discovery failed. **v0.1.8 candidate:** keep
    `rx_on_when_idle=false`, hold the MCU awake, emit no device-side bind/report
    traffic for the first 60 s after fresh/cold commissioning, and temporarily
    reduce the parent-poll interval from 1000 ms to 200 ms so buffered indirect ZDO
    requests are fetched promptly. Restore 1000 ms before configuring reporting and
    releasing the first measurement. Timer wakes skip the delay. This
    remains a candidate until live Z2M records `interviewCompleted:true` with
    `[1,2,3,4,5]` and the current `swBuildId`.
33. **Coordinator-side `Device joined` is not device-side BDB success.** After the
    v0.1.8 full-flash erase, serial never emitted `JOINED`; every steering result was
    `ESP_FAIL` followed by `LEAVE`, while Z2M assigned changing NWK addresses and
    launched interviews against transient associations. Therefore the v0.1.8 quiet
    phase and 200 ms polling were never reached and cannot be called hardware-proven.
34. **`force=true` removal deletes only the Z2M database row.** Zigbee2MQTT 2.12.1
    calls `removeFromDatabase()` and leaves coordinator trust-center/key state intact;
    normal removal sends `mgmtLeaveReq` but timed out for this device. The coordinator
    backup still contained the old EUI/link key after the board lost `zb_storage`.
    v0.1.9 therefore uses unique local-admin EUI `0x8efd49fffe1a3d8c` as the safe,
    device-scoped diagnostic instead of coordinator-wide NVRAM surgery.
35. **Do not erase whole flash for routine firmware updates.** Preserve `zb_storage`.
    A recovery erase is an explicit factory-new event and requires re-pairing.
36. **Known liveness bug:** a short BOOT press makes `s_awake_until_us` nonzero, while
    the no-network battery guard currently checks `s_awake_until_us == 0`; after the
    window expires the value is not cleared, so an unjoined device can scan forever.
    Keep this separate from the v0.1.9 EUI experiment; RESET without BOOT restores the
    60 s join/sleep guard.
37. **Fast polling that begins after `STEERING=OK` cannot help the security handshake.**
    v0.1.9 created a clean new-EUI Z2M record with a stable NWK address, proving that
    stale identity/address churn was removed, but serial still stayed factory-new and
    never emitted device-side `JOINED`; Z2M then failed even the node descriptor.
    v0.1.10 therefore starts the same bounded 200 ms sleepy polling immediately before
    `ESP_ZB_BDB_MODE_NETWORK_STEERING`, so the parent's buffered trust-center transport
    key can be delivered. It does not enable `rx_on_when_idle`.
38. **Custom `READ_WRITE` does not imply a writable wire attribute in ESP-Zigbee compat.**
    Live 2026-07-25 Z2M writes to Enviro attrs `0x0010`/`0x0011` returned
    `NOT_AUTHORIZED`; v0.1.12 uses only the standard EP1 control plane. [env]
39. **LED colour alone is not a power-state diagnosis — but its init gate still matters.**
    A live device can show a transient commissioning colour while Z2M shows
    `interviewCompleted:true`, `first_boot:OFF` and an advancing `wake_count`.
    v0.1.10 also had a C evaluation-order bug: `led_init() == ESP_OK && first_boot`
    invoked `led_init()` on every timer wake. v0.1.12 fixes it to
    `first_boot && led_init() == ESP_OK`; check live Z2M evidence before reset.
    [env]
40. **A five-minute MCU-awake window is not a ZDO reachability window by itself.**
    Live 2026-07-25 v0.1.11 re-interviews received repeated device announces but
    still timed out on Active Endpoints after the 60 s 200 ms polling phase. v0.1.12
    retains the sleepy default and enables `rx_on_when_idle=true` only for the
    scheduler-bounded `AWAKE_WINDOW_S` cold-boot/BOOT interval, then explicitly
    restores false before normal reporting. Hardware acceptance still requires
    `interviewCompleted:true` and `epList:[1,2,3,4,5]`. [env]
41. **A larger ZCL timeout is necessary but not sufficient for a rebooting sleepy device.**
    Live 2026-07-26 Enviro continued to announce and report every 10 s with
    `presentValue:10`, but Z2M's default 10 s `genAnalogOutput.write` timed out
    at the poll boundary. The converter therefore derives a 30–120 s lifetime from
    the current persisted interval. Live retries with a 30 s timeout still failed,
    proving that wait budget alone cannot synchronize an indirect write with a child
    that may reattach through another parent after deep sleep. [env]
42. **Outbound telemetry does not prove a normal deep-sleep wake can receive ZCL.**
    Live 2026-07-25/26 Enviro sent `device_announce` + telemetry every 10 s while
    standard `read` and `write` requests still timed out after 10 and 30 s across
    multiple wakes. v0.1.13 reserved a 1000 ms fast (200 ms) parent-poll slot before
    telemetry, but live v0.1.13 still timed out: debug showed successful uplink reports,
    no read/write response, coordinator relation 255, and different source-route relays
    on adjacent wakes. A receive slot cannot fetch a frame buffered at yesterday's
    parent. It does not justify permanent RX. [env]
43. **Browser-only serial logs are not durable observability.**
    A Web Serial console reads a device physically attached to the operator's browser,
    so no server can see those lines unless the browser explicitly relays them. The
    capture relay uses short-lived per-project capabilities in URL fragments, strips the
    fragment immediately, sends bounded bearer-authenticated chunks to a loopback-only
    service, and stores append-only NDJSON. Never solve this with an unauthenticated
    public log POST endpoint or a token embedded in static JavaScript. [env]
44. **Caddy static 403 can be a file-mode regression, not a route defect.**
    A newly deployed `serial_capture.mjs` inherited `0600` from a root-side write;
    Caddy returned 403 locally and through the edge. Enforce dirs 0755/files 0644 on
    the static deploy target and verify the real public module URL. [env]
45. **Poll Control is the synchronization primitive for queued sleepy-device control.**
    v0.1.14 adds a standard EP1 `genPollCtrl` server. Normal timer wakes explicitly
    CheckIn; the bounded cold-boot/BOOT window checks in every 10 s. The converter sets
    a non-zero Herdsman `pendingRequestTimeout` and uses `sendPolicy:"bulk"` for both
    control set/get, so `Device.onZclData` can answer CheckIn, flush pending work during
    fast polling, and send FastPollStop. This preserves deep sleep, five endpoints, and
    `rx_on_when_idle=false` without trusting an unstable parent-side indirect queue. [env]
46. **Judge Poll Control by the queued operation and later cadence, not FastPollStop alone.**
    Live v0.1.14 battery acceptance after the five-minute RX window proved the full
    path: `sendPolicy:"bulk"` queued `presentValue=30`; the next CheckIn produced
    `checkinRsp(startFastPolling=1)`; Herdsman logged pending-request `send success`;
    device-originated readback returned `presentValue:30`; later `first_boot=OFF`
    telemetry and `state.json` retained interval 30 across wake-count growth. Herdsman
    twice timed out waiting for the default response to `fastPollStop`, but subsequent
    CheckIns used `startFastPolling=0` and the device followed the 30 s cadence, proving
    it was not stuck fast-polling. Preserve this as a visible caveat, but do not
    misclassify a successful write/read as failed solely from that tolerant cleanup log. [env]
47. **Valid ZNP traffic outranks an early unhealthy frontend probe.**
    After a verified 65 s coordinator power-off (`devnum` 8→9), the add-on still
    reported `starting/unhealthy` while debug logs already contained valid UNPI frames,
    coordinator-version output, SRSP status 0, AF confirmations and incoming Zigbee
    traffic. Restarting on health alone repeatedly discarded real recovery progress.
    Wait for the coordinator marker and observe whether ZNP frames advance before
    deciding the adapter is still dead. [env]
48. **Temporarily disable the Supervisor watchdog through its current local API, then restore it.**
    The historical `ha supervisor options --watchdog=...` CLI flag is gone. The working
    path is authenticated GET/POST against `/addons/<slug>/info` and `/options` using
    the SSH add-on's existing `SUPERVISOR_TOKEN`, changing only `{"watchdog":false}`.
    Restore `true` only after Docker is healthy and `Zigbee2MQTT started!` is present.
    Never print a full add-on `info/options` payload: it contains MQTT credentials and
    Zigbee network material; emit only explicitly allowlisted booleans/status fields. [env]
49. **One sleepy endpoint can serialize an otherwise live Z2M startup.**
    With ZNP already passing traffic, Z2M spent successive 10 s waits reading standard
    Analog Input/Output metadata (`description`, `applicationType`, units, min/max,
    resolution) from Enviro EP1–EP5; repeated announces added more work and delayed
    frontend health. One monitored, non-erasing RESET of Enviro opened its bounded RX
    window, the reads completed, and Z2M became healthy without another coordinator
    restart. [env]
50. **A USB bridge ID is not a radio-chip identification.**
    CH340 `1a86:7523` proved only the UART bridge. A user-approved, read-only
    `cc2538-bsl --bootloader-sonoff-usb -r -l 4` probe received no ROM ACK and changed
    no flash/NVRAM; therefore the adapter must not be called a Sonoff/CC2652 solely from
    that USB ID. Record the physical model or a proven firmware inventory before any
    future bootloader operation. [env]
51. **Use live evidence precedence when Z2M persistence lags.**
    After the successful v0.1.14 write/read, `state.json`, direct
    `genAnalogOutput.readResponse {presentValue:30}` and later battery telemetry all
    showed interval 30, while `database.db` still held `presentValue:10` and stale
    `swBuildId=0.1.10`. Acceptance precedence is direct ZCL response → subsequent
    device telemetry → runtime state; database snapshots are supporting evidence only
    unless freshly synchronized. [env]
52. **Changing the config file does not prove the running logger changed level.**
    For Z2M 2.12, publish the runtime option through
    `zigbee2mqtt/bridge/request/options`, then verify a live window contains zero
    `debug:` lines. Always restore on-disk `advanced.log_level: info` as well. [env]
53. **A normal-wake first push must occur after the reporting minimum interval.**
    v0.1.14 registered device-side slots with `min_interval=1`, emitted
    `REPORTING_READY` synchronously, pushed EP1 immediately, and returned to deep sleep
    before any second push. During the five-minute awake window later pushes reported;
    normal one-shot wakes left T/RH/P stale while AI heartbeat channels advanced. A
    controlled physical perturbation plus direct ZCL read showed a changed temperature
    in the device attribute store, excluding BME680 death and Z2M cache as the cause.
    v0.1.15 waits `REPORTING_SETTLE_MS=1200` before releasing the first push and cancels
    both delayed setup/ready alarms on replacement or `LEAVE`. Also distinguish Z2M's
    aggregate MQTT state (which repeats cached values) from raw `attributeReport` frames. [env]
54. **A delayed READY adds a recovery state, not a new boolean timeout.** Independent
    review caught that `LEFT` during quiet/setup/settle returned the same `false` as a
    true timeout, so main deep-slept while steering was already scheduled. It also
    caught a duplicated mid-cycle rejoin path that failed to arm the five-minute window
    after `EVT_FIRST_JOIN`. Model reporting wait as `READY / REJOIN / TIMEOUT`, give
    `LEFT` priority over stale `READY`, and route startup plus mid-cycle recovery through
    one lifecycle. A fresh association always opens the commissioning window; a plain
    timer NVRAM restore does not. Test the transition policy as pure host C in addition
    to source-contract checks. Because the shared rejoin path can now run after an old
    commissioning window, its battery guard must compare the current time against the
    later of a fresh join deadline and `s_awake_until_us`; checking only whether the
    latter is zero turns a stale timestamp into an infinite radio-scan loop. [env]
55. **A configured maximum cannot accumulate across a reboot-per-wake sleepy
    lifecycle.** A no-erase v0.1.15 field flash on 2026-07-28 retained
    `report_interval_s=30` and continued normal wakes with `first_boot=OFF`; T/RH source
    reports stopped after their initial sequence while the AI heartbeat advanced. Pressure's
    stored `measuredValue=986` also had a 3600 s maximum reporting interval, so unchanged
    pressure had no cadence heartbeat. v0.1.16 correctly replaced the fragile 1200 ms
    delay with `cycle_reporting_settle_ms(min_interval, guard)` (2200 ms for min=1) and
    derived max fields from `report_interval_s`. Its independent 900 s field soak proved
    the timing improvement for changing values — T/RH refreshed roughly every 30 s — but
    Pressure `last_reported` remained at `20:26:43.756750 UTC` while `wake_count` advanced
    3→34. A reporting record recreated on each reboot is never 30 s old before deep sleep;
    aggregate MQTT pressure remains cache evidence, not a source report. [env]
56. **Prime first, then use a wake-local maximum deadline for unchanged values.**
    v0.1.17 writes the current BME680 measurement into the ZCL backing store *before*
    registering normal-wake slots, then sets both standard slot max fields to
    `cycle_reporting_wake_heartbeat_max_interval_s(1) = 2 s`. The existing 2.2 s
    readiness wait makes that standard-engine heartbeat due before the normal push, and
    the following flush keeps the sleepy radio available. The external cadence does not
    become 2 s: there is one such opportunity only on each `report_interval_s` timer wake.
    Keep `report_interval_s` maxima for cold/commissioning paths, never resurrect the
    unsafe manual-report API, and accept this only after a no-erase soak shows advancing
    source/HA Pressure timestamps on multiple `first_boot=OFF` wakes. [env]
57. **The reporting deadline must survive the final attribute mirror, not only
    slot registration.** v0.1.17's no-erase soak showed that its 2 s wake-local
    maximum plus 2.2 s pre-push settle was insufficient: normal 30 s wakes continued,
    but unchanged T/RH/P had multi-minute HA `last_reported` gaps and Pressure moved
    only when `986 ↔ 987`. The final `mirror_measurement_attributes()` preceded a
    fixed 2.0 s flush, so a strict whole-second `elapsed > max_interval` deadline could
    be reset or become eligible only as the radio window ended. v0.1.18 retains
    prime-before-register but computes `cycle_reporting_post_push_flush_ms()` on every
    normal push: with min=1, `max=2 s`, and a 200 ms guard, it preserves at least
    3.2 s after the final mirror. This increases awake time only; `cycle_sleep_ms()`
    subtracts it from deep sleep, so the persisted external cadence is unchanged.
    It is a production candidate until a no-erase normal-wake source/HA soak proves
    unchanged T/RH/P transitions. [env]
58. **A `LEAVE` invalidates the post-push flush as well as setup/READY.** The
    deferred `flush_done_cb` emits `ZB_EVT_REPORT_FLUSHED`, so after a v0.1.18
    normal wake it can otherwise survive its 3.2 s window into a rejoin and
    let main consume a stale completion before the new reporting lifecycle is
    ready. Cancel setup, ready, and flush callbacks together on `LEAVE`; cover
    that contract in the commissioning source test. [env]
59. **`update_reporting_info()` needs the SDK-owned record handle.** A live
    post-rejoin `Read Reporting Configuration` for Pressure returned
    `minRepIntval=5`, `maxRepIntval=0`, and `status=0`, despite v0.1.18 source
    intending `min=1/max=2` on a normal wake. In esp-zigbee-lib 2.0.3,
    `EZB_ZCL_MAX_REPORTING_INTERVAL_DEFAULT` is `0x0000` — periodic reporting
    disabled — and the compat API documents that `.info` returned by
    `esp_zb_zcl_find_reporting_info()` is required by
    `esp_zb_zcl_update_reporting_info()`. v0.1.19 retains that opaque handle
    while patching the full interval/delta record. This is a source-level fix;
    direct post-flash readback plus no-erase unchanged-Pressure acceptance are
    still required. [env]
