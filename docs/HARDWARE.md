# Hardware

## Bill of materials

| Part | Notes |
|---|---|
| **ESP32-C6 Super Mini** | ~22.5×18 mm stamp board, ESP32-C6FH4 (4 MB flash), USB-C, native USB-Serial/JTAG (no bridge chip). WS2812 on GPIO8, blue LED on GPIO15, BOOT on GPIO9. |
| **BME680 breakout** (GY-BME680 / CJMCU-680 / Adafruit) | I²C addr 0x76 (SDO→GND, китайский дефолт) or 0x77 (Adafruit) — firmware probes both. 3.3 V supply. |
| **Waveshare Solar Power Manager** (plain or **D**) | MPPT charge from a 6–24 V panel into a 1S Li-ion cell, 4.2 V cutoff, protection. Both expose the battery terminals (PH2.0 / screw) — that's where we tap. |
| Li-ion cell | 18650 or LiPo, 1S (2000 mAh+ recommended) |
| 2 × 200 kΩ resistors + 100 nF | battery voltage divider into GPIO2 |

## Pin map (defaults; all changeable in `idf.py menuconfig` → *C6 Enviro Sensor*)

| Signal | GPIO | Why this pin |
|---|---|---|
| I²C SDA | **22** | GPIO20–23 are the "safe picks" on the Super Mini: no strapping, no flash, no USB. |
| I²C SCL | **23** | — |
| VBAT sense | **2** (ADC1_CH2) | ADC1 = GPIO0–6 only on the C6 (no ADC2). High-impedance divider → no boot-strap effect. |
| WS2812 LED | 8 | onboard (strapping pin — output-after-boot is safe) |
| BOOT button | 9 | onboard (strapping: LOW at reset = bootloader — that's the flasher's recovery path) |
| USB D−/D+ | 12/13 | native USB — never reconfigure |
| Blue LED | 15 | onboard, active-high (unused by firmware; JTAG_SEL strapping) |

Avoid GPIO4/5 (MTMS/MTDI strapping) and GPIO18/19 (flash) for extensions.

## Power topology

**The battery powers the C6 directly; the Solar Power Manager only charges the cell.**

- `BAT+ → 5V/VIN pin` of the Super Mini. Its LDO regulates 3.0–4.2 V → 3.3 V happily
  (dropout at 3.3 V input leaves ~3.1–3.2 V — the C6 and BME680 run fine down to that).
- The manager's 5 V boost output stays **unused**: boosting 3.7 V → 5 V → LDO → 3.3 V
  would waste two conversions and its boost quiescent current (up to tens of mA on the
  (D)) dwarfs the whole sensor budget.
- BME680 VCC ← the Super Mini's **3V3** pin.

## Battery sensing

`BAT+ ── 200k ──┬── 200k ── GND`, midpoint → GPIO2, 100 nF across the lower leg.
400 kΩ total draws max 10.5 µA — negligible. ADC: 12 dB attenuation (0–3.3 V range;
the divider tops out at 2.1 V), curve-fitting calibration, 8-sample average, ×2
divider ratio (`ENVIRO_VBAT_DIV_NUM/DEN` in menuconfig if you use different values).

## Deep-sleep current — the fine print

The C6 chip itself sleeps at ~7 µA, **but the Super Mini board doesn't**:

- the **WS2812** control IC leaks ~0.2–0.5 mA from 3V3 even with the pixel dark;
- the onboard LDO adds its quiescent (varies by clone).

Community measurements put the board at **~50–400 µA** in deep sleep depending on the
clone and whether the WS2812 is removed. For true µA-class sleep: **desolder the
WS2812** (the firmware only uses it for commissioning status — you lose nothing but
the colors) and, if you're fanatical, the blue power/status LED too. At the default
3 s cadence none of this matters (the awake cycles dominate); at 30+ min intervals it
becomes the main consumer.

## Buttons

- **BOOT short press** (device awake — it is, ~2.5 s of every cycle; just hold it a
  beat): opens/extends the 5-minute stay-awake window (pairing, interview, debugging).
- **BOOT hold ≥3 s**: Zigbee factory reset (erases NVRAM, device re-steers).
- **BOOT held while plugging USB**: ROM bootloader (the flasher's recovery path).
- **RESET**: normal reboot; wake counter restarts (the `first_boot` status bit is set
  on the next report).

Note: GPIO9 is *not* an LP pin on the C6 (LP = GPIO0–7), so BOOT **cannot wake the
chip from deep sleep** — press it during a wake slice, or tap RESET.
