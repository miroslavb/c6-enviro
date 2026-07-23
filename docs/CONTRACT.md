# Zigbee byte-contract (generated)

> AUTO-GENERATED from `contract/contract.json` by `contract/codegen.mjs` — do not edit by hand.

- **Device**: manufacturerName `Biometal`, modelId `C6-ENVIRO`, powerSource `0x03` (Battery)
- **Role**: sleepy Zigbee END DEVICE (deep sleep between cycles; rx_on_when_idle = false)
- **manufacturerCode**: `0x131B` (Espressif) — identical on firmware + converter or manufacturer-specific writes fail
- **Custom cluster**: `biometalEnviro` = `0xFC00` — DOWN config writes only

## Standard clusters (EP1) — the main telemetry path

| Cluster | ID | Attribute | Encoding | Source |
|---|---|---|---|---|
| Temperature Measurement | 0x0402 | `measuredValue` | int16, °C × 100 | BME680 temperature |
| Pressure Measurement | 0x0403 | `measuredValue` | int16, hPa (0.1 kPa) | BME680 pressure |
| Relative Humidity | 0x0405 | `measuredValue` | uint16, % × 100 | BME680 humidity |
| Power Configuration | 0x0001 | `batteryVoltage 0x0020 / batteryPercentageRemaining 0x0021` | uint8 100 mV / uint8 0.5 % | battery ADC via divider |

Z2M decodes these natively (zero custom glue): `temperature`, `humidity`, `pressure`, `battery`, `voltage`. `linkquality` is added automatically.

## Analog Input endpoints (standard genAnalogInput 0x000C) — non-standard channels

| EP | Channel | Custom-cluster attr mirrored |
|---|---|---|
| 2 | gas ohm | `gasResistance` |
| 3 | vbat mV | `vbatMv` |
| 4 | status flags | `statusFlags` |
| 5 | wake count | `wakeCount` |
| 6 | temp C | `tempC` |
| 7 | humidity pct | `humidityPct` |
| 8 | pressure kPa | `pressureKpa` |

The Z2M addon cannot decode INCOMING custom-cluster frames (endpoint→registry lookup loses the attached cluster → `msg.cluster` undefined → no converter matches; proven live 2026-07-11 on c6-radiometer). Non-standard telemetry therefore travels on STANDARD `genAnalogInput` clusters — one endpoint per channel, value in `presentValue` (SINGLE float), reported by the stack engine. `wakeCount` changes every cycle, guaranteeing ≥1 report per wake.

## Custom-cluster attributes

| Attr | HA key (`expose`) | ID | Type | Dir | Unit | Default | Range | Purpose |
|---|---|---|---|---|---|---|---|---|
| `statusFlags` | `status_flags` | 0x0000 | UINT16 | up | — | — | — | Sensor + power status bitmask (see statusBits); mirrored on AI EP4 |
| `wakeCount` | `wake_count` | 0x0001 | UINT32 | up | — | — | — | Deep-sleep wake counter since power-on; increments every cycle, so HA sees one report per wake |
| `vbatMv` | `vbat_mv` | 0x0002 | UINT16 | up | mV | — | — | Battery voltage, millivolts (precise; PowerConfig 0x0020 only has 100 mV steps) |
| `awakeMs` | `awake_ms` | 0x0003 | UINT16 | up | ms | — | — | Duration of the previous wake cycle, ms (deep-sleep duty-cycle diagnostic) |
| `gasResistance` | `gas_resistance` | 0x0004 | SINGLE | up | Ω | — | — | BME680 gas sensor resistance, ohms (higher = cleaner air); mirrored on AI EP2 |
| `tempC` | `temperature` | 0x0005 | SINGLE | up | °C | — | — | Temperature mirror, °C float (AI EP6 — belt-and-braces beside the standard 0x0402 cluster) |
| `humidityPct` | `humidity` | 0x0006 | SINGLE | up | % | — | — | Relative-humidity mirror, %% float (AI EP7 — beside the standard 0x0405 cluster) |
| `pressureKpa` | `pressure` | 0x0007 | SINGLE | up | kPa | — | — | Pressure mirror, kPa float (AI EP8 — beside the standard 0x0403 cluster) |
| `reportIntervalS` | `report_interval_s` | 0x0010 | UINT16 | down | s | 3 | 3…3600 | Deep-sleep measurement/report period, seconds (3 s default; raise to 60+ for battery-only operation) |
| `gasEnabled` | `gas_enabled` | 0x0011 | BOOLEAN | down | — | 1 | — | Run the BME680 gas heater each cycle (heater burns ~12 mA for 150 ms; disable to save battery) |

`up` attributes are readable on the custom cluster (diagnostics; NOT reported — reports would arrive undecodable, see above). `down` attributes are written HA→device via `zigbee2mqtt/<device>/set`; the firmware persists them in NVS so they survive deep sleep and power loss.

## Sensor + power status bitmask (`statusFlags`)

| Bit | Flag | Meaning |
|---|---|---|
| 0 | `sensor_error` | BME680 not detected or measurement failed this cycle |
| 1 | `heater_unstable` | Gas heater did not reach stability — gas_resistance unreliable this cycle |
| 2 | `battery_low` | Battery below the low-voltage threshold |
| 3 | `vbat_invalid` | Battery ADC read failed (check the divider wiring) |
| 4 | `gas_disabled` | Gas heater disabled via HA (gas_enabled = OFF) |
| 5 | `first_boot` | This cycle is a cold boot / reset, not a deep-sleep wake |

## Constants

- `batteryLowMv` = 3400 — below this the `battery_low` bit is raised
- `awakeWindowS` = 300 — stay-awake window after factory-new join / BOOT press so the Z2M interview completes
