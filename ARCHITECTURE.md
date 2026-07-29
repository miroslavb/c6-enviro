# Architecture

Third project in the C6/Zigbee family (after `c6-lcd-zigbee` and `c6-radiometer`) —
and the first **battery** one. Everything that was proven on hardware there is
inherited unchanged; what's new is the sleepy-end-device lifecycle.

## Differential controls

| Firmware | Hardware-verified role | Shared controls | Intentional difference |
|---|---|---|---|
| `/root/c6-lcd-zigbee` | Mains-powered Zigbee **Router** | ESP32-C6, ESP-IDF 5.4, esp-zigbee-lib 2.x, endpoint registration, NVS restore, `esp_zb_start(false)`, +20 dBm TX | Router capability keeps RX on by design. |
| `/root/c6-radiometer` | Mains-powered Zigbee **Router** | Same stack; channel 11 primary; +20 dBm TX was the proven fix for asymmetric ZDO replies | No deep sleep or parent polling. |
| `/root/c6-enviro` | Solar/Li-ion sleepy **End Device** | Same stack startup, NVS and +20 dBm TX; same five-endpoint interview budget as the successful v0.1.0 | `rx_on_when_idle=false` + 1 s polling normally; v0.1.19 sends Poll Control CheckIn, reserves a 1 s 200 ms parent-poll slot, primes current ZCL values, patches each existing SDK reporting record through its opaque handle to a wake-local 2 s heartbeat deadline, then keeps a 3.2 s post-final-mirror flush window. Continuous RX remains limited to the bounded 5-minute cold-boot/BOOT interview window. |

The controls rule out a generic ESP32-C6, endpoint-registration, or low-TX-power
failure. They do **not** justify copying router power semantics into Enviro. The
v0.1.8 field gate also proved that coordinator/device security identity is an upstream
boundary: transient coordinator-side joins are not equivalent to device-side BDB
`STEERING=ESP_OK`.

## Locked decisions

| Decision | Choice | Why |
|---|---|---|
| Zigbee role | **Sleepy END DEVICE** (`CONFIG_ZB_ZED`, `rx_on_when_idle=false` by default) | Battery + deep sleep. Only the scheduler-bounded 5-minute cold-boot/BOOT interview window may set RX true; it always restores false before normal reporting. |
| Zigbee identity | **Recovery EUI `0x8efd49fffe1a3d8c`**, set little-endian after `esp_zb_init` and before `esp_zb_start` | Full-flash erase destroyed the old device key state while the coordinator retained the old EUI/link key. A unique local-admin EUI avoids that stale trust-center record without coordinator-wide NVRAM surgery. |
| Sleep model | **Pure timer-wake deep sleep** (no light sleep, no `CONFIG_PM`) | Simplest reliable model at multi-second intervals; the user asked for deep sleep. ZBOSS restores the network from `zb_storage` NVRAM on every wake — no re-steering, just a parent re-attach. |
| Cadence | `report_interval_s`, default **3 s**, writable 3…3600 from HA, NVS-persisted | The spec. Interval-compensated: sleep = period − time awake. |
| UP telemetry | **STANDARD clusters only** (T 0x0402 / RH 0x0405 / P 0x0403 / PowerConfig 0x0001 on EP1; genAnalogInput EP2–EP5 for gas Ω, vbat mV, status bits, wake counter) | The Z2M addon cannot decode incoming custom-cluster frames (proven live 2026-07-11 on the radiometer). |
| DOWN config | **Standard EP1 controls:** `genAnalogOutput` (0x000D) `presentValue` for `report_interval_s`; `genOnOff` (0x0006) commands for `gas_enabled`; `genPollCtrl` (0x0020) server for explicit CheckIn | ESP-Zigbee compat NACKs custom `READ_WRITE` attributes with `NOT_AUTHORIZED`. Deep-sleep reboot may change parent, so v0.1.14 queues controls in Herdsman and flushes them only after device-initiated CheckIn; the endpoint count remains five. |
| Reporting transport | **Stack reporting engine** (self-binding + `esp_zb_zcl_update_reporting_info`, device min=1 s / delta=0; normal wake `max=2 s`, cold/commissioning `max=report_interval_s`), enabled only after commissioning's 60 s quiet phase; v0.1.19 finds the record and preserves its opaque SDK handle before patching it, then primes attributes, retains the 2.2 s setup settle, and preserves a strict 3.2 s window after the final normal-wake mirror | The only transmit path that emitted frames on this hardware+lib. A normal deep-sleep wake recreates reporting state, so a 30 s maximum cannot expire during its short awake window; v0.1.16 therefore refreshed changing T/RH but not unchanged Pressure. v0.1.17 showed that a 2 s maximum before the final mirror was still insufficient. The v0.1.18 post-push window lets `elapsed > 2 s` clear on a whole-second clock while the external wake cadence remains user-configured. Z2M coordinator-side requests remain min=0. |
| Sensor | Vendored **Bosch BME68x API v4.4.8** (BSD-3), integer mode, forced T/P/H+gas per wake | Official compensation math; forced mode = one conversion per wake; gas trusted only with `GASM_VALID`+`HEAT_STAB`. |
| Battery sense | ADC1 (GPIO2) + 2×200 kΩ divider, curve-fitting calibration, 8-sample average | PowerConfig gives % (0.5 % units — Z2M divides by 2) and 100 mV voltage; precise mV rides AI EP3. `batteryVoltage` is NOT stack-reportable (esp-zigbee #463) — reading only. On the current field unit the divider midpoint is not connected to GPIO2, so its battery telemetry is floating and cannot be used as evidence. |
| Commissioning + controls | **200 ms sleepy parent polls begin before BDB steering** and continue through the first **60 s quiet ZDO phase** after `JOINED`; v0.1.12 enables RX only for the enclosing **5-minute cold-boot/BOOT window**, then schedules it off. v0.1.14 adds EP1 Poll Control CheckIn plus the separate **1 s / 200 ms normal-wake receive slot**; five endpoints EP1..EP5 | Live 2026-07-26 showed v0.1.13 telemetry while 10/30 s reads and writes still timed out and consecutive wake routes used different relays. Device-initiated CheckIn gives Herdsman a confirmed window to flush its own pending queue without permanent RX. |
| Join battery guard | 60 s steering budget → sleep 60 s → retry | An unjoined, scanning radio burns ~80 mA and would flatten the cell overnight. |

## Wake-cycle sequence

```
RTC timer ──► boot (skip-validate) ──► NVS config ──► measure BME680 + ADC   (~0.3 s)
   ──► esp_zb_start(false) ──► DEVICE_REBOOT (NVRAM restore)                (~0.5–1.5 s)
   ──► [cold boot / BOOT: 5 min bounded RX; first 60 s quiet ZDO phase, 200 ms parent polls]
   ──► [normal timer wake: genPollCtrl CheckIn → 1 s receive slot, 200 ms polls]
   ──► mirror current ZCL attrs ──► configure self-bind/report slots (`max=2 s` normal wake)
   ──► setup settle (2.2 s) ──► final normal mirror ──► post-push flush (≥3.2 s)
   ──► deep sleep (period − awake, floor 0.5 s)
```

- Measurement happens **before** the radio comes up — data is ready when the network is.
- `wake_count` (AI EP5) changes every cycle → guaranteed ≥1 report per wake → HA
  `last_seen` tracks the cadence even in a perfectly static room.
- Normal timer wakes first send standard Poll Control CheckIn to coordinator EP1.
  Herdsman answers only when pending work exists, flushes queued standard controls
  in fast-poll mode, then sends FastPollStop. The existing 1 s, 200 ms receive phase
  bounds this exchange; afterward `keep_alive` returns to 1 s for reporting/sleep.
- Factory-new boot instead steers (permit-join must be open), then holds the
  5-minute MCU-awake **and bounded continuous-RX** window. It emits no self-bind or
  attribute-report traffic for the first 60 s and polls its parent every 200 ms so
  buffered active-endpoint/descriptor requests arrive promptly. The RX window and
  normal 1000 ms poll interval is restored before reporting. Every timer wake
  first emits CheckIn and reserves a 1 s 200 ms-poll receive slot, then configures
  reporting and remains otherwise sleepy.

## Event flow (who owns what)

`zb_device.c` owns the stack lifecycle and emits events (`JOINED`, `FIRST_JOIN`,
`REPORTING_READY`, `REPORT_FLUSHED`, `JOIN_FAILED`, `LEFT`); `main.c` owns the **sleep decision** and the
awake-window policy; `cycle.c` is pure math (battery curve, ZCL encodings, sleep
budgeting, status bits) and is host-tested. Config writes arrive on the stack task,
are clamped, applied to `g_config`, and persisted via `app_config.c`.

## Contract discipline

`contract/contract.json` → `codegen.mjs` → `zb_contract.h` (C) + `contract.generated.mjs`
(JS) + `docs/CONTRACT.md`, with a parity test that fails on drift. The converter is
assembled programmatically from the generated module — firmware and converter cannot
disagree about IDs, types, units or ranges.

## v0.1.14 hardware acceptance — 2026-07-26

The routine browser update preserved `zb_storage`; the device returned to the existing
network on battery, retained EP1..EP5, and Z2M Configure installed the EP1 Poll Control
binding. After the five-minute RX window closed, `report_interval_s=30` was queued with
`sendPolicy:"bulk"`. The next device CheckIn produced
`checkinRsp(startFastPolling=1)`, Herdsman logged pending-request `send success`, a
device-originated GET returned `genAnalogOutput.presentValue=30`, and later
`first_boot=OFF` telemetry retained 30 while `wake_count` advanced. There were no
failed SET/GET or `NOT_AUTHORIZED` errors.

Herdsman twice timed out waiting for the default response to `fastPollStop`; subsequent
CheckIns used `startFastPolling=0` and the device followed the 30 s cadence, so this was
a cleanup-response caveat rather than a stuck-fast-poll or control failure. Runtime
`state.json` and direct readback were current while `database.db` attributes and
`swBuildId` lagged; do not use the lagging snapshot as the primary acceptance oracle.

## v0.1.15 → v0.1.19 EP1 reporting repair — 2026-07-29

On v0.1.14, raw cluster history showed that standard EP1 temperature/humidity/pressure
reports stopped after the bounded cold-boot awake phase while EP2–EP5 and `wake_count`
continued. Holding the device through two normal wakes did not produce an automatic
EP1 update, but a direct read returned temperature `23.63 °C` instead of Z2M's cached
`25.24 °C`. This proves the BME680 measurement and EP1 attribute store were live and
isolates the defect to the post-deep-sleep reporting lifecycle.

v0.1.15 delayed `ZB_EVT_REPORTING_READY` for `REPORTING_SETTLE_MS=1200` after registering
the 1 s reporting slots. The subsequent no-erase field flash falsified that timing:
normal 30 s wakes reached `first_boot=OFF` and advanced the AI heartbeat, but T/RH source
reports stopped after their initial sequence. Pressure never advanced in HA during the
720 s capture: its stored device/Z2M reporting configuration had `maxRepIntval=3600` and
raw `measuredValue=986`, so a stable pressure had no cadence heartbeat.

v0.1.16 replaced the literal with `cycle_reporting_settle_ms(min_interval, guard)` and
derived max fields from persisted `report_interval_s`. Its separate 900 s no-erase soak
proved the settle repair for changing values — `wake_count` advanced **3→34** and HA
recorded new T/RH timestamps at roughly 30 s — but falsified the configured-max theory:
Pressure `last_reported` remained exactly `20:26:43.756750 UTC` while the aggregate MQTT
payload merely repeated cached `98.6`. A per-wake ZBOSS reporting record is younger than
the 30 s maximum when the sleepy MCU returns to deep sleep, so the maximum cannot emit its
unchanged-value heartbeat.

v0.1.17 then mirrored `g_measurement` into the ZCL backing store **before** registering
ordinary-wake slots and used `cycle_reporting_wake_heartbeat_max_interval_s(1) == 2`
for both max fields. Its no-erase field acceptance **failed**: after the cold-start
window, `report_interval_s=30` and `wake_count` still advanced, but unchanged T/RH/P
had multi-minute `last_reported` gaps. Pressure advanced only on `986 ↔ 987` changes,
not as a heartbeat. The 2.2 s wait ended before the final mirror, and the subsequent
2.0 s flush could end at or before a strict whole-second `elapsed > max_interval`
deadline began to be eligible.

v0.1.18 retains the safe prime-before-register ordering and wake-local 2 s maximum,
but makes the final flush timing explicit: `cycle_reporting_post_push_flush_ms()` keeps
an ordinary wake alive for at least 3.2 s after its final attribute mirror (`2 s` max +
one strict tick + `200 ms` guard). It never shortens an operator-configured longer flush
and leaves cold/commissioning behavior unchanged. Interval-compensated sleep subtracts
this extra awake time, so it does not turn the user-visible 30 s cadence into a faster
wake schedule. Host/source tests guard the post-push calculation and use; no-erase
hardware acceptance still requires multiple source/HA T/RH/P timestamp transitions,
including unchanged Pressure.

Direct, read-only reporting configuration made the remaining defect concrete: v0.1.18
Pressure had the SDK default `min=5/max=0`, where `max=0` disables periodic reports.
The compat wrapper needs the opaque `.info` handle discovered by
`esp_zb_zcl_find_reporting_info()` to modify an existing record. v0.1.19 preserves
that handle before applying its interval/delta update. The no-erase field capture on
2026-07-29 passed at the Zigbee protocol layer: three ordinary sleepy wakes contained
31 device-originated EP1 `msPressureMeasurement` `attributeReport`s, including unchanged
Pressure. HA `last_reported` remained stale, so it is not an acceptance oracle for
unchanged numeric state on this Discovery path; raw source reports are authoritative.

Independent review found two recovery consequences around that wait. The main loop now
classifies `READY`, `REJOIN`, and `TIMEOUT` explicitly: `LEFT` outranks stale `READY`
and loops back through network acquisition instead of forcing deep sleep. Startup and
mid-cycle recovery share the same network/reporting lifecycle, and a fresh steering
association always arms `AWAKE_WINDOW_S`, regardless of the original boot cause. A
plain NVRAM restore on a timer wake remains short and battery-efficient. Failed network
acquisition expires at `max(wait_start + CONFIG_ENVIRO_JOIN_TIMEOUT_S,
s_awake_until_us)`: this preserves an active bounded commissioning window without
allowing its stale nonzero timestamp to disable the battery timeout forever.
