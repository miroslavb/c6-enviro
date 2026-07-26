# Zigbee contract (generated)

> AUTO-GENERATED from `contract/contract.json` by `contract/codegen.mjs` — do not edit by hand.

- **Device**: manufacturerName `Biometal`, modelId `C6-ENVIRO`, powerSource `0x03` (Battery)
- **Role**: sleepy Zigbee END DEVICE (deep sleep between cycles; `rx_on_when_idle=false`)
- **Wire rule**: no manufacturer-specific custom cluster is registered. Both telemetry and control use standard ZCL clusters.

## Standard clusters (EP1) — telemetry

| Cluster | ID | Attribute | Encoding | Source |
|---|---|---|---|---|
| Temperature Measurement | 0x0402 | `measuredValue` | int16, °C × 100 | BME680 temperature |
| Pressure Measurement | 0x0403 | `measuredValue` | int16, hPa (0.1 kPa) | BME680 pressure |
| Relative Humidity | 0x0405 | `measuredValue` | uint16, % × 100 | BME680 humidity |
| Power Configuration | 0x0001 | `batteryVoltage 0x0020 / batteryPercentageRemaining 0x0021` | uint8 100 mV / uint8 0.5 % | battery ADC via divider |

## Standard control transport (EP1) — HA → device

| HA key | Field | Cluster | ID | Attribute / command | Transport | Persistence |
|---|---|---|---|---|---|---|
| `report_interval_s` | `reportIntervalS` | genAnalogOutput | 0x000D | `presentValue` | write | NVS |
| ↳ range | — | — | — | 3…3600 s | firmware + converter clamp | — |
| `gas_enabled` | `gasEnabled` | genOnOff | 0x0006 | `on` / `off` | command | NVS |

The two configuration clusters share EP1 with the measurement clusters; EP2…EP5 remain the four Analog Input telemetry endpoints, preserving the sleepy-device interview surface `EP1…EP5`.

## Standard sleepy-control synchronization (EP1)

- Cluster: `genPollCtrl` 0x0020 (server)
- Converter configure binds this server cluster to the coordinator endpoint so automatic CheckIn commands have a destination.
- CheckIn destination: coordinator short 0x0000, EP1
- Automatic awake-window CheckIn: 40 quarter-seconds (10 s)
- Long/short poll: 4/1 quarter-seconds; fast-poll timeout: 8 quarter-seconds
- Normal deep-sleep timer wakes additionally send one explicit CheckIn before reporting so Herdsman can flush its pending control queue.

## Analog Input endpoints (standard `genAnalogInput` 0x000C)

| EP | Channel | Domain field |
|---|---|---|
| 2 | gas ohm | `gasResistance` |
| 3 | vbat mV | `vbatMv` |
| 4 | status flags | `statusFlags` |
| 5 | wake count | `wakeCount` |

## Domain fields

| Field | HA key (`expose`) | Type | Dir | Unit | Default | Range | Purpose |
|---|---|---|---|---|---|---|---|
| `statusFlags` | `status_flags` | UINT16 | up | — | — | — | Sensor + power status bitmask (see statusBits); mirrored on AI EP4 |
| `wakeCount` | `wake_count` | UINT32 | up | — | — | — | Deep-sleep wake counter since power-on; increments every cycle, so HA sees one report per wake |
| `vbatMv` | `vbat_mv` | UINT16 | up | mV | — | — | Battery voltage, millivolts (precise; PowerConfig 0x0020 only has 100 mV steps) |
| `awakeMs` | `awake_ms` | UINT16 | up | ms | — | — | Duration of the previous wake cycle, ms (deep-sleep duty-cycle diagnostic) |
| `gasResistance` | `gas_resistance` | SINGLE | up | Ω | — | — | BME680 gas sensor resistance, ohms (higher = cleaner air); mirrored on AI EP2 |
| `reportIntervalS` | `report_interval_s` | UINT16 | down | s | 3 | 3…3600 | Deep-sleep measurement/report period, seconds (3 s default; raise to 60+ for battery-only operation) |
| `gasEnabled` | `gas_enabled` | BOOLEAN | down | — | 1 | — | Run the BME680 gas heater each cycle (heater burns ~12 mA for 150 ms; disable to save battery) |

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

- `batteryLowMv` = 3400
- `awakeWindowS` = 300
