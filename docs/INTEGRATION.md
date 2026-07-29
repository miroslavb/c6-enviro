# Integration — flash → pair → Home Assistant

## 1. Flash (browser, no IDE)

1. Open **https://c6.miroslav.diy/flash/enviro/** in Chrome/Edge (desktop, HTTPS).
2. Plug the ESP32-C6 Super Mini in with a **data** USB-C cable.
3. **Connect & Flash** → pick "USB JTAG/serial debug unit".
4. If the port doesn't show up: unplug → hold **BOOT** → plug in → release after ~2 s.
5. Keep 115200 baud. For routine updates, **leave "Erase whole flash first" OFF**
   so `zb_storage` and Zigbee security state survive. Use **Recover device (erase
   flash only)** only for a genuinely broken half-write; a full erase makes the
   device factory-new and requires a clean re-pair.

Local build instead: `bash scripts/build-firmware.sh` (Docker, ESP-IDF 5.4) and serve
`web/` over HTTPS.

## 2. Zigbee2MQTT converter (do this BEFORE pairing)

```bash
# in your Z2M data dir; lib/ is shared with sibling external converters
mkdir -p external_converters/lib
cp z2m/biometal_enviro.mjs external_converters/
cp z2m/lib/enviro-contract.generated.mjs \
   z2m/lib/enviro-defs.mjs \
   z2m/lib/enviro-defs.factory.mjs \
   external_converters/lib/
```

> **Shared `external_converters/` with sibling projects:** the Enviro converter
> imports only the three `enviro-*` library files above. Do **not** overwrite a
> generic `lib/contract.generated.mjs` or `lib/defs.mjs`; those may belong to a
> sibling converter.

`configuration.yaml`:

```yaml
advanced:
  enable_external_js: true   # Z2M ≥ 2.11
homeassistant: true
```

Restart Z2M.

The converter's configure phase binds EP1 `genPollCtrl` to the coordinator endpoint.
For an already-paired Enviro upgraded to v0.1.14 or newer, press RESET after flashing and run
**Reconfigure** once during the bounded awake window before testing controls; a new
pair performs this configure step automatically.

## 3. Pair (sleepy-device rules)

1. Z2M → **Permit join (all)**.
2. Power or reset the board. Factory-new firmware steers immediately; the LED goes
   blue (steering) → green (joined).
   For v0.1.18 the expected IEEE is **`0x8efd49fffe1a3d8c`**.
3. **Leave it alone for the next few minutes**: after the first join or a
   firmware-update cold boot, the device stays awake **5 minutes** and v0.1.18
   temporarily enables continuous RX only for that bounded window. The first
   **60 seconds are intentionally quiet** (no
   telemetry/reporting) while it also polls its parent every 200 ms so Z2M can finish
   ZDO discovery. RX is explicitly switched off before reporting; normal timer wakes
   stay sleepy, send Poll Control CheckIn, and reserve a 1 s 200 ms-poll receive slot
   for queued controls before telemetry.
   If the interview stalls, press **BOOT** briefly to reopen the same bounded window
   and hit "Reconfigure" in Z2M.
4. Result: device `C6-ENVIRO` / `Biometal`, type **EndDevice**, entities for
   temperature, humidity, pressure, gas_resistance, battery, voltage, vbat_mv,
   status bits, wake_count + config `report_interval_s`, `gas_enabled`.

### Recovery from the v0.1.2–v0.1.4 interview regression

Those builds exposed eight endpoints and can repeatedly fail with
`Interview failed because can not get active endpoints`. v0.1.5 returned to five
endpoints; v0.1.6/v0.1.7 then tested continuous RX, but v0.1.7 still failed live
despite strong uplink telemetry. v0.1.8 also exposed a separate factory-new security
failure after a full-flash erase: Z2M saw transient joins, but device-side BDB never
reached `STEERING=ESP_OK` because the coordinator retained the old EUI/link-key state.
Flash **v0.1.14 or newer**, pair IEEE `0x8efd49fffe1a3d8c`, keep Permit join open until
the serial console prints `JOINED`, and then let the interview continue. v0.1.10
exposes `[1,2,3,4,5]`, keeps `rx_on_when_idle=false` by default, and starts 200 ms
parent polling before factory-new BDB steering so the trust-center key can reach the
sleepy child. v0.1.12 additionally keeps RX on only for the 5-minute cold-boot/BOOT
window because live 2026-07-25 re-interviews still received announces but timed out
on Active Endpoints after the 60 s sleepy-only phase. v0.1.13 added a one-second,
200 ms parent-poll slot, but live 2026-07-26 reads/writes still timed out while
successive wake routes used different relays. v0.1.14 adds standard Poll Control:
the device checks in, Herdsman flushes its pending queue in fast-poll mode, and then
stops fast polling. Do not enable **Erase whole
flash first** merely to reopen interview mode. Do not repeatedly force-remove/rejoin
a half-interviewed entry: that creates overlapping interview attempts and
network-address churn. Acceptance is the Z2M database showing `interviewCompleted:true`,
`interviewState:"SUCCESSFUL"`, and `epList:[1,2,3,4,5]`.

### v0.1.18 normal-wake environmental reporting

Device-side reporting slots use a one-second minimum interval. v0.1.14 configured
those slots and immediately pushed T/RH/P; a normal timer wake then slept before a
second push, while an initially awake sequence could appear healthy because later
cycles crossed the minimum interval. A 720 s no-erase v0.1.15 capture made two failures
observable: normal 30 s timer wakes and AI `wake_count` advanced while T/RH source
reports stopped after their initial sequence, and stable pressure (`measuredValue=986`)
never advanced because its stored maximum reporting interval was 3600 s.

v0.1.16 fixed the first timing boundary with a 2.2 s post-registration release and
replaced the one-hour maximum with persisted `report_interval_s`. Its 900 s no-erase
soak then showed fresh T/RH transitions at 30 s but Pressure `last_reported` still
stuck at `20:26:43.756750 UTC` while `wake_count` advanced 3→34. That is expected for a
reboot-per-wake ZED: a freshly registered 30 s maximum cannot expire inside its short
awake window; an aggregate MQTT payload containing cached pressure is not source proof.

v0.1.17 reduced the normal slot maximum to 2 s and primed standard attributes before
registration, but its no-erase acceptance still failed: unchanged Pressure updated only
when `986 ↔ 987`, while unchanged values had multi-minute gaps despite continuing 30 s
wakes. Its 2.2 s pre-push settle was not a post-push deadline. v0.1.18 retains that
safe priming/order, then keeps ordinary timer wakes awake for `max(configured_flush,
3.2 s)` after the final mirror: a strict whole-second `elapsed > 2 s` maximum gets its
next tick plus the 200 ms scheduler guard. It does not increase the external cadence;
interval-compensated deep sleep still targets persisted `report_interval_s`. Cold/
commissioning slots retain their configured flush. Hardware acceptance must observe
multiple source/HA T/RH/P reports on `first_boot=OFF` wakes; aggregate MQTT cache,
unchanged numerical state, or cold-boot updates alone do not pass.

If the device leaves while quiet/reporting setup is pending, v0.1.18 keeps the MCU awake
and follows the already-scheduled steering retry rather than sleeping. A successful
fresh rejoin from the running cycle reopens the complete five-minute commissioning
window before telemetry resumes; a normal timer-wake NVRAM restore remains short. If
steering never succeeds, the device sleeps after the later of the active commissioning
deadline and its fresh 60-second join budget, rather than scanning indefinitely.

### v0.1.14 standard controls + Poll Control queue

ESP-Zigbee compat rejects writable manufacturer-specific attributes with
`NOT_AUTHORIZED`, even when the attribute list uses `READ_WRITE`. v0.1.12
therefore retained the successful five endpoint descriptors but added two **standard
clusters on EP1**. v0.1.14 adds a third standard EP1 server, `genPollCtrl`, without
changing `epList:[1,2,3,4,5]`. Every normal deep-sleep wake sends CheckIn before its
short parent-polled control receive phase:

- `report_interval_s` → `genAnalogOutput.presentValue`, rounded and clamped to
  **3…3600 seconds** by converter and firmware;
- `gas_enabled` → `genOnOff` `on` / `off` commands.

Both values are persisted in NVS and apply on the next measurement cycle. The browser
installer's **Power settings** panel generates the exact Z2M payload; it deliberately
does not write through USB or replace NVS during a routine flash.

No network after 60 s (permit-join was closed)? The device sleeps 60 s and retries —
just open permit-join and wait, or tap RESET.

## 4. Zigbee network notes

- Primary channel is **11** (the home coordinator's); all channels are scanned as
  fallback.
- The device is a **sleepy end device**: it needs a parent (coordinator or any
  router) in range. `ed_timeout` is 64 min — if the device misses check-ins that
  long, the parent forgets it and the next wake triggers a rejoin.
- The converter places interactive control set/get operations into Herdsman's pending
  queue (`sendPolicy:"bulk"`) instead of sending immediately to a parent that may
  change across deep-sleep reboots. Every normal wake sends `genPollCtrl.checkin`;
  the five-minute cold-boot/BOOT window also checks in every **10 s**. Herdsman answers
  `checkinRsp(startFastPolling=true)` only when work exists, flushes the queue, then
  sends `fastPollStop`. The request lifetime remains cadence-aware: **at least 30 s**,
  current interval + 10 s when larger, capped at **120 s**. At intervals above the cap,
  press RESET/BOOT and submit the change during the bounded awake window.
- Live v0.1.14 acceptance may still log a timeout waiting for the default response to
  `fastPollStop` after a successful operation. Treat it as a cleanup caveat only when
  the queued set/read completed, later device telemetry retained the value, subsequent
  CheckIns decline fast polling, and the new wake cadence is visible; otherwise it is
  a real failure requiring investigation.

## 5. Home Assistant

Entities auto-discover via MQTT. Optional extras (battery-low push + gone-silent
watchdog): copy [`homeassistant/packages/c6_enviro.yaml`](../homeassistant/packages/c6_enviro.yaml)
into your `packages/` and adjust entity ids to your friendly name.

## 6. Debugging

- **Web console**: https://c6.miroslav.diy/flash/enviro/console/ — auto-reconnects
  across deep-sleep cycles, so you see every wake's log without touching anything.
  A normal console URL stays local-only. For durable server capture, open an operator-issued
  short-lived `#capture=…` link: the capability remains in the browser fragment, is removed
  from the address bar immediately, and serial chunks append server-side with `archive: active`.
- A healthy cycle logs:
  `C6-ENVIRO v0.1.18 starting (wake #N, deep-sleep wake)` →
  `vbat: …` → `BME680@0x76: T=…` → `network restored from NVRAM` →
  `deep sleep 2… ms`.
- `factory-new → network steering` in every cycle = the join never succeeded:
  check permit-join / channel / coordinator range.
- v0.1.18 additionally logs `Zigbee EUI-64 override: 0x8efd49fffe1a3d8c`,
  `steering: parent poll every 200 ms`, `normal wake: Poll Control CheckIn tsn=…`,
  `normal wake: 1000 ms control receive phase`, and on a cold boot/BOOT press
  `interview window: continuous Zigbee RX for 300 s`.
  Acceptance requires that same IEEE in Z2M and the subsequent `interviewCompleted:true` state.
- A white/red commissioning LED alone is not a failure verdict: confirm Z2M is still
  advancing `wake_count` and that `first_boot`/`status_flags` are healthy first.
  v0.1.14 also gates WS2812/RMT initialization behind `first_boot`, so timer wakes
  never initialize the RGB driver.
- Re-pair from scratch: hold **BOOT ≥3 s** (factory reset) with permit-join open.

### Z2M does not reach `started!` after a coordinator restart

1. Do not restart merely because frontend health is still `starting/unhealthy`.
   First confirm whether coordinator-version output and valid UNPI/SRSP/AF frames are
   advancing; on the current large zStack network this can precede frontend health by
   minutes.
2. If the Supervisor watchdog is terminating that progress, temporarily POST only
   `{"watchdog":false}` to the local Supervisor `/addons/<slug>/options` endpoint with
   the existing SSH add-on token. Never print the full `/info` response because it
   includes secrets. Restore watchdog `true` after `healthy` + `Zigbee2MQTT started!`.
3. If startup is stuck on sequential Enviro EP1–EP5 metadata reads, start monitoring
   first and tap Enviro RESET once. Its bounded five-minute RX window lets the reads
   finish; this is not erase, remove, factory reset or re-interview.
4. Restore both on-disk and runtime log level to `info`. For Z2M 2.12, runtime update is
   `zigbee2mqtt/bridge/request/options`; prove it by observing zero new debug lines.

For control acceptance, prefer a fresh device-originated ZCL read response and later
telemetry/state over lagging `database.db` attributes. A stale DB value is not a reason
to repeat a proven write or mutate the DB manually.
