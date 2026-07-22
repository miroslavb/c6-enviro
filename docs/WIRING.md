# Wiring & power budget

Interactive diagram: [`web/wiring.svg`](../web/wiring.svg) (also on the flasher page
at https://c6.miroslav.diy/flash/enviro/#wiring).

## Connections

```
Solar panel (6–24 V) ──► SOLAR IN  ┌────────────────────────┐
                                   │ Waveshare Solar Power  │
                                   │ Manager (plain / D)    │
                          BAT +/− ─┤  MPPT · 4.2 V cutoff   │
                                   └───────┬────────────────┘
                                           │ (cell also in holder / PH2.0)
        ┌──────────── 18650 / LiPo 1S ─────┴───┐
        │ +                                  − │
        │                                      │
        ├─► ESP32-C6 Super Mini «5V» (VIN)     ├─► ESP32-C6 «GND»
        │                                      │
        └─ 200 kΩ ─┬─ 200 kΩ ──────────────────┘
                   │     └ 100 nF ─ GND
                   └────► GPIO2  (ADC1_CH2, battery sense)

        ESP32-C6 3V3  ──► BME680 VCC        GND ──► BME680 GND
        ESP32-C6 GPIO22 ─► BME680 SDA       GPIO23 ─► BME680 SCL
        (BME680 SDO→GND = addr 0x76; SDO→VDD = 0x77 — firmware probes both)
```

Keep the I²C wires short (<20 cm); the breakout's onboard pull-ups plus the C6's
internal ones are plenty at 100 kHz.

⚠️ While USB is plugged in for flashing, the board is powered from USB — that's fine
(the LDO arbitrates), but **don't feed 5 V USB and >4.2 V into VIN from elsewhere
simultaneously**, and never feed the battery into the 3V3 pin directly (4.2 V exceeds
the chip's absolute max).

## Power budget (measured assumptions, honest math)

Per wake cycle at the default settings:

| Phase | Time | Current (approx) |
|---|---|---|
| Boot (skip-validate) + config | ~0.2 s | 25 mA |
| BME680 forced T/P/H + gas (300 °C/100 ms heater) | ~0.25 s | 15 mA (heater ~12 mA peak) |
| Zigbee NVRAM restore + parent re-attach | ~0.5–1.5 s | 20–80 mA bursts |
| Report flush window | 2.0 s (Kconfig) | ~20 mA |
| **Total awake** | **~3 s** | **~25 mA avg** |
| Deep sleep (board-level, WS2812 on board) | — | ~0.1–0.4 mA |

Battery life on a 2000 mAh cell (no sun), by `report_interval_s`:

| Interval | Duty cycle | Avg current | Runtime |
|---|---|---|---|
| **3 s** (default) | ~50 % | ~13 mA | **~6 days** |
| 30 s | ~9 % | ~2.5 mA | ~1 month |
| 60 s | ~5 % | ~1.4 mA | ~2 months |
| 300 s | ~1 % | ~0.5 mA | ~5 months |
| 3600 s | ~0.1 % | ~0.15 mA* | ~1.5 года* |

\* dominated by board sleep leakage — desolder the WS2812 to hit these numbers.

**Conclusion:** the 3-second cadence is a solar-panel cadence — a few hours of decent
sun a day comfortably refills ~300 mAh/day of draw with the Waveshare manager. For
battery-only deployments write `report_interval_s: 60+` from HA (persisted on the
device). `gas_enabled: OFF` shaves the heater burst if you don't need air quality.
