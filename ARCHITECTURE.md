# Architecture

Third project in the C6/Zigbee family (after `c6-lcd-zigbee` and `c6-radiometer`) —
and the first **battery** one. Everything that was proven on hardware there is
inherited unchanged; what's new is the sleepy-end-device lifecycle.

## Differential controls

| Firmware | Hardware-verified role | Shared controls | Intentional difference |
|---|---|---|---|
| `/root/c6-lcd-zigbee` | Mains-powered Zigbee **Router** | ESP32-C6, ESP-IDF 5.4, esp-zigbee-lib 2.x, endpoint registration, NVS restore, `esp_zb_start(false)`, +20 dBm TX | Router capability keeps RX on by design. |
| `/root/c6-radiometer` | Mains-powered Zigbee **Router** | Same stack; channel 11 primary; +20 dBm TX was the proven fix for asymmetric ZDO replies | No deep sleep or parent polling. |
| `/root/c6-enviro` | Solar/Li-ion sleepy **End Device** | Same stack startup, NVS and +20 dBm TX; same five-endpoint interview budget as the successful v0.1.0 | `rx_on_when_idle=false`, 1 s parent polling, deep sleep; it must not inherit router always-on behavior. |

The controls rule out a generic ESP32-C6, endpoint-registration, or low-TX-power
failure. They do **not** justify copying router power semantics into Enviro. The
v0.1.8 field gate also proved that coordinator/device security identity is an upstream
boundary: transient coordinator-side joins are not equivalent to device-side BDB
`STEERING=ESP_OK`.

## Locked decisions

| Decision | Choice | Why |
|---|---|---|
| Zigbee role | **Sleepy END DEVICE** (`CONFIG_ZB_ZED`, `rx_on_when_idle=false`) | Battery + deep sleep. Routers must keep the radio in RX permanently. |
| Zigbee identity | **Recovery EUI `0x8efd49fffe1a3d8c`**, set little-endian after `esp_zb_init` and before `esp_zb_start` | Full-flash erase destroyed the old device key state while the coordinator retained the old EUI/link key. A unique local-admin EUI avoids that stale trust-center record without coordinator-wide NVRAM surgery. |
| Sleep model | **Pure timer-wake deep sleep** (no light sleep, no `CONFIG_PM`) | Simplest reliable model at multi-second intervals; the user asked for deep sleep. ZBOSS restores the network from `zb_storage` NVRAM on every wake — no re-steering, just a parent re-attach. |
| Cadence | `report_interval_s`, default **3 s**, writable 3…3600 from HA, NVS-persisted | The spec. Interval-compensated: sleep = period − time awake. |
| UP telemetry | **STANDARD clusters only** (T 0x0402 / RH 0x0405 / P 0x0403 / PowerConfig 0x0001 on EP1; genAnalogInput EP2–EP5 for gas Ω, vbat mV, status bits, wake counter) | The Z2M addon cannot decode incoming custom-cluster frames (proven live 2026-07-11 on the radiometer). |
| DOWN config | Custom cluster 0xFC00 `biometalEnviro`, manuf 0x131B | Outgoing converter framing works; two writable attrs, persisted to NVS on the device. |
| Reporting transport | **Stack reporting engine** (self-binding + `esp_zb_zcl_update_reporting_info`, device min=1 s / delta=0), enabled only after commissioning's 60 s quiet phase | The only transmit path that emitted frames on this hardware+lib. v0.1.0 interviewed while these slots were rejected; once min=1 made them work, simultaneous self-bind/report traffic correlated with the active-endpoint regression. Z2M coordinator-side reporting requests remain min=0. |
| Sensor | Vendored **Bosch BME68x API v4.4.8** (BSD-3), integer mode, forced T/P/H+gas per wake | Official compensation math; forced mode = one conversion per wake; gas trusted only with `GASM_VALID`+`HEAT_STAB`. |
| Battery sense | ADC1 (GPIO2) + 2×200 kΩ divider, curve-fitting calibration, 8-sample average | PowerConfig gives % (0.5 % units — Z2M divides by 2) and 100 mV voltage; precise mV rides AI EP3. `batteryVoltage` is NOT stack-reportable (esp-zigbee #463) — reading only. |
| Commissioning + interview | **200 ms sleepy parent polls begin before BDB steering** and continue through the first **60 s quiet ZDO phase** after `JOINED`; no bind/report traffic during that phase; five endpoints EP1..EP5 | v0.1.9 proved the new EUI removes old-address churn but the factory-new device still failed before device-side `JOINED`, while Z2M timed out on node descriptor. v0.1.10 moves fast polling upstream so the buffered trust-center transport key can arrive without always-on RX. Normal 1000 ms polling returns before reporting. |
| Join battery guard | 60 s steering budget → sleep 60 s → retry | An unjoined, scanning radio burns ~80 mA and would flatten the cell overnight. |

## Wake-cycle sequence

```
RTC timer ──► boot (skip-validate) ──► NVS config ──► measure BME680 + ADC   (~0.3 s)
   ──► esp_zb_start(false) ──► DEVICE_REBOOT (NVRAM restore)                (~0.5–1.5 s)
   ──► [commissioning cold boot only: 60 s quiet ZDO phase, 200 ms parent polls]
   ──► configure self-bind/report slots ──► push attrs ──► stack reports
   ──► flush window (2 s, Kconfig) ──► deep sleep (period − awake, floor 0.5 s)
```

- Measurement happens **before** the radio comes up — data is ready when the network is.
- `wake_count` (AI EP5) changes every cycle → guaranteed ≥1 report per wake → HA
  `last_seen` tracks the cadence even in a perfectly static room.
- `keep_alive` = 1 s: every wake polls the parent at least twice, so queued HA writes
  (`report_interval_s`, `gas_enabled`) land within one cycle.
- Factory-new boot instead steers (permit-join must be open), then holds the
  5-minute MCU-awake window while remaining a sleepy, parent-polled ZED. It emits
  no self-bind or attribute-report traffic for the first 60 s and polls its parent
  every 200 ms so buffered active-endpoint/descriptor requests arrive promptly.
  The normal 1000 ms poll interval is restored before reporting. A power/reset/
  firmware-update cold boot uses the same quiet phase for a pending re-interview.
  Timer deep-sleep wakes configure reporting immediately and stay short.

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
