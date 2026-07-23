# c6-enviro

**Solar-powered Zigbee environment sensor**: an **ESP32-C6 Super Mini** + **BME680**
(temperature / humidity / pressure / gas) + **Waveshare Solar Power Manager** with a
single Li-ion cell. A **sleepy Zigbee end device** that wakes from deep sleep every
**3 seconds** (configurable 3 s…1 h from Home Assistant), measures everything the
BME680 offers plus the battery voltage, reports over **Zigbee2MQTT**, and goes back
to sleep. Flash it from the browser at **https://c6.miroslav.diy/flash/enviro/**.

```
 ☀ solar ─► Waveshare Solar     ┌──────────── ESP32-C6 Super Mini ────────────┐
            Power Manager ─► 🔋─┤ 5V/VIN   deep sleep ⇆ wake every 3 s        │
                       BAT+ ─┬──┤ GPIO2    ADC: battery mV + %                │
                        2×200k  │ GPIO22/23 I²C ── BME680: T · RH · P · gas   │
                                │ Zigbee END DEVICE ──► Z2M ──► Home Assistant│
                                └──────────────────────────────────────────────┘
   flasher + wiring + web console: c6.miroslav.diy/flash/enviro/  (Chrome/Edge)
```

## What you get in Home Assistant

- **temperature / humidity / pressure** — standard clusters, standard Z2M entities
- **gas_resistance** (Ω, higher = cleaner air) — Analog Input EP2
- **battery** (%) + **voltage** (100 mV) + precise **vbat_mv** — solar charge curve visible
- **status bits** — `sensor_error`, `heater_unstable`, `battery_low`, `vbat_invalid`, `gas_disabled`, `first_boot`
- **wake_count** — increments every cycle: proof of life at the 3 s cadence
- **config**: `report_interval_s` (3…3600, persisted) + `gas_enabled` (heater on/off)

## Repo layout

| Dir | What |
|---|---|
| [`contract/`](contract/) | **Single source of truth** for the Zigbee byte-contract → codegen → C header + JS module + docs |
| [`firmware/`](firmware/) | ESP-IDF 5.4 firmware: sleepy end device, deep sleep, vendored Bosch BME68x API, ADC battery sense |
| [`firmware/host-test/`](firmware/host-test/) | `make` → 269 host checks: Li-ion % curve, ZCL encodings, sleep budgeting, status bits |
| [`web/`](web/) | Browser flasher (esptool-js) + wiring diagram + **auto-reconnecting** web serial console |
| [`z2m/`](z2m/) | Zigbee2MQTT external converter (assembled from the contract) + tests vs real ZHC ^26 |
| [`homeassistant/`](homeassistant/) | HA notes + optional package (battery-low & gone-silent alerts) |
| [`deploy/`](deploy/) | c6.miroslav.diy Caddy route |
| [`docs/`](docs/) | `ARCHITECTURE` · `HARDWARE` · `WIRING` · `INTEGRATION` · `LESSONS` · `CONTRACT` (generated) |

## Quick start

```bash
# 1. Tests (host, no toolchain needed)
make -C firmware/host-test && node contract/contract.test.mjs && (cd z2m && npm install && npm test)

# 2. Firmware (Docker, reproducible)
bash scripts/build-firmware.sh          # → web/firmware/*.bin + manifest.json

# 3. Flash from the browser
#    serve web/ behind HTTPS → https://c6.miroslav.diy/flash/enviro/

# 4. Pair: install z2m/ converter → restart Z2M → Permit join → reset the board.
#    It stays awake 5 minutes after a fresh join or firmware-update cold boot so
#    the interview can complete even when Zigbee NVRAM was preserved.
```

Full setup: [`docs/INTEGRATION.md`](docs/INTEGRATION.md) · design rationale:
[`ARCHITECTURE.md`](ARCHITECTURE.md) · power budget & battery life:
[`docs/WIRING.md`](docs/WIRING.md).

## Power reality check (be honest with yourself)

A 3 s cadence keeps the radio duty cycle near 50 % — great **on solar**, ~2–3 days on
a bare 2000 mAh cell. `report_interval_s: 60` → ~1 month battery-only;
`300` → several months. The WS2812 on the Super Mini leaks ~0.3 mA even when dark —
desolder it for true µA sleep. Numbers and math: [`docs/WIRING.md`](docs/WIRING.md).
