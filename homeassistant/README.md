# Home Assistant integration

Everything arrives through **Zigbee2MQTT** — after the converter is installed and the
device paired, HA discovers the entities automatically (`homeassistant: true` in Z2M):

| Entity | Source | Notes |
|---|---|---|
| `sensor.<name>_temperature` | Temperature cluster 0x0402 | °C |
| `sensor.<name>_humidity` | Humidity cluster 0x0405 | % |
| `sensor.<name>_pressure` | Pressure cluster 0x0403 | kPa (÷10 of the hPa wire value) |
| `sensor.<name>_battery` | PowerConfig 0x0001 | %, from the Li-ion curve |
| `sensor.<name>_voltage` | PowerConfig 0x0001 | mV, 100 mV resolution |
| `sensor.<name>_gas_resistance` | Analog Input EP2 | Ω — higher = cleaner air |
| `sensor.<name>_vbat_mv` | Analog Input EP3 | precise battery mV (solar charge curve) |
| `sensor.<name>_status_flags` + per-bit binaries | Analog Input EP4 | `sensor_error`, `heater_unstable`, `battery_low`, `vbat_invalid`, `gas_disabled`, `first_boot` |
| `sensor.<name>_wake_count` | Analog Input EP5 | increments every cycle — proof of life |
| `number.<name>_report_interval_s` | custom cluster (write) | 3…3600 s, persisted on the device |
| `switch.<name>_gas_enabled` | custom cluster (write) | gas heater on/off |

## Install (Zigbee2MQTT)

1. Copy `z2m/biometal_enviro.mjs` **and the `z2m/lib/` folder** into Z2M's
   `external_converters/` directory.
2. In Z2M configuration: `advanced.enable_external_js: true`, `homeassistant: true`.
3. Restart Z2M, open **Permit join**, then power/reset the device. It stays awake
   **5 minutes** after the first join so the interview completes — don't cut power.
4. Check the device page: model `C6-ENVIRO`, vendor `Biometal`, type `EndDevice`.

## Optional package

`packages/c6_enviro.yaml` adds a battery-low alert and a stale-data (missed wakes)
alert on top of the auto-discovered entities. Copy into your `packages/` dir and set
the entity prefix to match your device's friendly name.
