# c6-enviro

**Solar-powered Zigbee environment sensor**: an **ESP32-C6 Super Mini** + **BME680**
(temperature / humidity / pressure / gas) + **Waveshare Solar Power Manager** with a
single Li-ion cell. A **sleepy Zigbee end device** that wakes from deep sleep every
**3 seconds** (configurable 3 s…1 h from Home Assistant), measures everything the
BME680 offers plus the battery voltage, reports over **Zigbee2MQTT**, and goes back
to sleep. Flash it from the browser at **https://c6.miroslav.diy/flash/enviro/**.

Firmware **v0.1.15** uses recovery EUI-64 `0x8efd49fffe1a3d8c`. A full-flash erase
during the v0.1.8 field test destroyed `zb_storage`, while the coordinator retained
the old EUI's trust-center key. The new local-admin identity isolates this one sensor
without modifying coordinator NVRAM or any sibling device.

**v0.1.14 control-path hardware acceptance passed 2026-07-26:** after a routine no-erase update and return
to battery power, Z2M bound EP1 Poll Control and delivered queued normal-sleep
SET/GET for `report_interval_s=30`. Direct readback and later `first_boot=OFF`
telemetry retained 30 across increasing wake counts. See `docs/LESSONS.md` items
45–52 for the evidence and operational caveats.

**v0.1.15 reporting-fix candidate:** a physical temperature perturbation advanced
`wake_count` without an automatic EP1 update, while a direct ZCL read exposed a changed
temperature in the device attribute store. The BME680 and measurement path were alive;
the first push after each deep-sleep reboot occurred inside ZBOSS's 1 s reporting
minimum. v0.1.15 waits 1.2 s after registering reporting slots before the first push.
Independent pre-commit review also closed both adjacent recovery paths: a `LEAVE`
during reporting setup now stays awake for steering instead of sleeping, and a fresh
mid-cycle rejoin reopens the full five-minute commissioning window. Failed rejoin is
still battery-bounded by the later of that window and a fresh 60-second join deadline.
Software gates do not replace the pending no-erase hardware flash and long soak.

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
- **config**: `report_interval_s` (3…3600, persisted) over standard `genAnalogOutput` + `gas_enabled` over standard `genOnOff`; both live on EP1 without expanding the five-endpoint interview surface

## Repo layout

| Dir | What |
|---|---|
| [`contract/`](contract/) | **Single source of truth** for the Zigbee byte-contract → codegen → C header + JS module + docs |
| [`firmware/`](firmware/) | ESP-IDF 5.4 firmware: sleepy end device, deep sleep, vendored Bosch BME68x API, ADC battery sense |
| [`firmware/host-test/`](firmware/host-test/) | `make` → pure-C host checks: lifecycle deadlines/actions, Li-ion % curve, ZCL encodings, sleep budgeting, status bits |
| [`web/`](web/) | Browser flasher (esptool-js) + wiring diagram + auto-reconnecting web serial console; an issued short-lived capture link can archive raw console chunks to the server without putting a token in an HTTP URL |
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
#    Routine update: DO NOT erase whole flash; preserve zb_storage.

# 4. Pair: install z2m/ converter → restart Z2M → Permit join → reset the board.
#    Expected v0.1.15 IEEE: 0x8efd49fffe1a3d8c.
#    It stays awake 5 minutes after a fresh join or firmware-update cold boot.
#    v0.1.15 turns continuous RX on only inside that bounded interview window;
#    the first 60 s also use 200 ms parent polls for ZDO/security traffic. Every
#    normal timer wake sends a standard Poll Control CheckIn, then reserves a
#    1 s 200 ms-poll slot to flush queued Z2M controls, registers reporting,
#    waits a 1.2 s settle interval, and only then pushes telemetry.
```

Full setup: [`docs/INTEGRATION.md`](docs/INTEGRATION.md) · design rationale:
[`ARCHITECTURE.md`](ARCHITECTURE.md) · power budget & battery life:
[`docs/WIRING.md`](docs/WIRING.md).

## Power reality check (be honest with yourself)

A 3 s cadence keeps the radio duty cycle near 50 % — great **on solar**, ~2–3 days on
a bare 2000 mAh cell. `report_interval_s: 60` → ~1 month battery-only;
`300` → several months. The WS2812 on the Super Mini leaks ~0.3 mA even when dark —
desolder it for true µA sleep. Numbers and math: [`docs/WIRING.md`](docs/WIRING.md).

> **Current field unit:** its battery-divider midpoint is not connected to GPIO2.
> Treat `vbat_mv`, `battery`, `voltage`, and `battery_low` as floating/invalid until
> that wire is installed; they were excluded from the v0.1.15 root-cause analysis.
