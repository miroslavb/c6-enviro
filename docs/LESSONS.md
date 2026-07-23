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
   erase-first default ON; data as chunked binary STRINGS; `hardReset()` in try/catch;
   HTTPS + Chrome/Edge only.** [kbd] — the entire flasher stack, reused verbatim.
2. **C6 bootloader at offset 0x0; read real offsets from `flasher_args.json`.** [kbd→C6]
3. **Hold BOOT (GPIO9) → plug USB = the primary un-stick path** for the C6's flaky
   native-USB auto-reset. [C6]
4. **GPIO12/13 are USB — never touch.** [C6]
5. **esp-zigbee-lib 2.x: ONE component, `CONFIG_ZB_SDK_1xx=y` for the 1.x API;
   `ESP_ZB_ZR/ED_CONFIG()` macros don't exist — build `esp_zb_cfg_t` by hand.** [C6 #27]
6. **`zb_storage` partition subtype MUST be `nvs`** (the 1.x-era `fat` makes
   `nvs_open_from_partition` fail → `esp_zb_init` abort()s), and init it defensively. [rad]
7. **Z2M addon cannot decode INCOMING custom-cluster frames** (`msg.cluster` undefined →
   'No converter available', proven live 2026-07-11) → **UP telemetry on STANDARD
   clusters only**; custom cluster for DOWN writes. [rad]
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
12. **manufacturerCode 0x131B identical in firmware and converter or every
    manufacturer-specific op silently fails; contract-driven codegen prevents drift.** [C6]

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
