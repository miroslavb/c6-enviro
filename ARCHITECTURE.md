# Architecture

Third project in the C6/Zigbee family (after `c6-lcd-zigbee` and `c6-radiometer`) —
and the first **battery** one. Everything that was proven on hardware there is
inherited unchanged; what's new is the sleepy-end-device lifecycle.

## Locked decisions

| Decision | Choice | Why |
|---|---|---|
| Zigbee role | **Sleepy END DEVICE** (`CONFIG_ZB_ZED`, `rx_on_when_idle=false`) | Battery + deep sleep. Routers must keep the radio in RX permanently. |
| Sleep model | **Pure timer-wake deep sleep** (no light sleep, no `CONFIG_PM`) | Simplest reliable model at multi-second intervals; the user asked for deep sleep. ZBOSS restores the network from `zb_storage` NVRAM on every wake — no re-steering, just a parent re-attach. |
| Cadence | `report_interval_s`, default **3 s**, writable 3…3600 from HA, NVS-persisted | The spec. Interval-compensated: sleep = period − time awake. |
| UP telemetry | **STANDARD clusters only** (T 0x0402 / RH 0x0405 / P 0x0403 / PowerConfig 0x0001 on EP1; genAnalogInput EP2–EP5 for gas Ω, vbat mV, status bits, wake counter) | The Z2M addon cannot decode incoming custom-cluster frames (proven live 2026-07-11 on the radiometer). |
| DOWN config | Custom cluster 0xFC00 `biometalEnviro`, manuf 0x131B | Outgoing converter framing works; two writable attrs, persisted to NVS on the device. |
| Reporting transport | **Stack reporting engine** (self-binding + `esp_zb_zcl_update_reporting_info`, device min=1 s / delta=0) | The only transmit path that ever emitted frames on this hardware+lib; manual `report_attr_cmd_req` never did (five failed variants on the radiometer). Field evidence showed the ZED build rejects device-side min=0; min=1 still fits in the 2 s flush window. Z2M coordinator-side reporting requests remain min=0. |
| Sensor | Vendored **Bosch BME68x API v4.4.8** (BSD-3), integer mode, forced T/P/H+gas per wake | Official compensation math; forced mode = one conversion per wake; gas trusted only with `GASM_VALID`+`HEAT_STAB`. |
| Battery sense | ADC1 (GPIO2) + 2×200 kΩ divider, curve-fitting calibration, 8-sample average | PowerConfig gives % (0.5 % units — Z2M divides by 2) and 100 mV voltage; precise mV rides AI EP3. `batteryVoltage` is NOT stack-reportable (esp-zigbee #463) — reading only. |
| Interview | **5-minute stay-awake window** plus a hard **five-endpoint budget** (EP1..EP5); BOOT short-press re-opens it | A sleepy device that naps mid-interview never gets its endpoints into the Z2M database. Field evidence showed EP6..EP8 mirror endpoints pushed this ZED over the reliable interview budget. |
| Join battery guard | 60 s steering budget → sleep 60 s → retry | An unjoined, scanning radio burns ~80 mA and would flatten the cell overnight. |

## Wake-cycle sequence

```
RTC timer ──► boot (skip-validate) ──► NVS config ──► measure BME680 + ADC   (~0.3 s)
   ──► esp_zb_start(false) ──► DEVICE_REBOOT (NVRAM restore)                (~0.5–1.5 s)
   ──► push attrs ──► stack engine reports (device min=1 s, delta=0)
   ──► flush window (2 s, Kconfig) ──► deep sleep (period − awake, floor 0.5 s)
```

- Measurement happens **before** the radio comes up — data is ready when the network is.
- `wake_count` (AI EP5) changes every cycle → guaranteed ≥1 report per wake → HA
  `last_seen` tracks the cadence even in a perfectly static room.
- `keep_alive` = 1 s: every wake polls the parent at least twice, so queued HA writes
  (`report_interval_s`, `gas_enabled`) land within one cycle.
- Factory-new boot instead steers (permit-join must be open), then holds the
  5-minute awake window, reporting every interval without sleeping.

## Event flow (who owns what)

`zb_device.c` owns the stack lifecycle and emits events (`JOINED`, `FIRST_JOIN`,
`REPORT_FLUSHED`, `JOIN_FAILED`, `LEFT`); `main.c` owns the **sleep decision** and the
awake-window policy; `cycle.c` is pure math (battery curve, ZCL encodings, sleep
budgeting, status bits) and is host-tested. Config writes arrive on the stack task,
are clamped, applied to `g_config`, and persisted via `app_config.c`.

## Contract discipline

`contract/contract.json` → `codegen.mjs` → `zb_contract.h` (C) + `contract.generated.mjs`
(JS) + `docs/CONTRACT.md`, with a parity test that fails on drift. The converter is
assembled programmatically from the generated module — firmware and converter cannot
disagree about IDs, types, units or ranges.
