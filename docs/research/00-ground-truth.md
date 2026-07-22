# C6 Enviro Node — ground-truth research (2026-07-22)

## 1. ESP32-C6 Super Mini board

**Board:** ~22.5 × 18 mm "stamp", ESP32-C6FH4 (4 MB in-package flash, QIO), USB-C with native USB (no UART bridge), 25 header pins at 2.54 mm.
Sources: https://www.espboards.dev/esp32/esp32-c6-super-mini/ , https://mischianti.org/esp32-c6-supermini-high-resolution-pinout-datasheet-schema-and-specs/

**Exposed pins (silkscreen → GPIO), per espboards.dev full table (25 pins):**

| Silkscreen | GPIO | Notes |
|---|---|---|
| 5V | – | USB 5V / power in |
| GND | – | ground |
| 3V3 | – | LDO output (~400 mA usable) |
| TX | GPIO16 | UART0 TX |
| RX | GPIO17 | UART0 RX |
| 0–6 (IO0–IO6) | GPIO0–6 | **ADC1_CH0–CH6** (the 7 ADC pins) |
| 7 (IO7) | GPIO7 | MTDO/JTAG |
| 8 (IO8) | GPIO8 | **WS2812 RGB LED**, strapping |
| 9 (IO9) | GPIO9 | **BOOT button**, strapping |
| 12, 13 | GPIO12, GPIO13 | USB D– / D+ (avoid if using USB) |
| 14 | GPIO14 | free |
| 15 (IO15) | GPIO15 | **blue status LED**, JTAG_SEL strapping |
| 18, 19 | GPIO18, GPIO19 | FSPIQ/FSPID – tied to flash on internal-flash parts, avoid |
| 20–23 | GPIO20–23 | free |

"Safe first picks": GPIO0,1,2,3,14,20,21,22,23. (espboards.dev)

**LEDs:** WS2812 addressable RGB on **GPIO8** (data in); plain **blue LED on GPIO15**, reported **active-high** (mischianti); plus a green charge LED (not GPIO-controlled) on variants with battery charger. CONFLICT NOTE: some C6 SuperMini clones omit the blue LED or the charger — the GPIO8-WS2812 + GPIO15-LED combination is the most common variant (espboards.dev, mischianti.org, studiopieters.nl all agree on 8/15).

**Buttons/flash:** BOOT = GPIO9 (pulled up; low at reset → download mode). RESET button = chip EN/reset. Flash = 4 MB (ESP32-C6FH4).

**Power:** USB-C 5V → onboard 3.3 V LDO (~400 mA usable; exact LDO part is not consistently documented across clones). Some variants have battery pads + LTH7R linear Li-charger on the back (espboards.dev). **Deep sleep current — sources conflict:** espboards.dev claims ~52 µA @3.7 V battery / 392 µA @3.3 V pin; mischianti measured ~300–400 µA real-world vs <7 µA chip-theoretical, blaming LDO quiescent + **WS2812 parasitic draw (its internal IC draws current even when "off"; desolder it for true low power)**. Plan for ~0.3–0.4 mA unless you cut the WS2812/LED.

**ADC:** ADC1 channels = **GPIO0–GPIO6** (7 channels). No ADC2 on C6.

**Strapping pins (C6):** GPIO4 (MTMS), GPIO5 (MTDI), GPIO8, GPIO9, GPIO15 (JTAG_SEL). Boot rules: GPIO9 low at reset → serial bootloader; GPIO8 must be 1 for the serial bootloader to work reliably; GPIO8=0 & GPIO9=0 is invalid; in normal boot GPIO8 is ignored. GPIO15 selects JTAG signal source at boot — don't load it at reset.
Sources: https://docs.espressif.com/projects/esptool/en/latest/esp32c6/advanced-topics/boot-mode-selection.html , https://www.espboards.dev/blog/esp32-strapping-pins/

## 2. Waveshare Solar Power Manager family

Shared spec table on every wiki page (all: 6–24 V solar input, MPPT, 4.2 V charge cutoff):

| Model | Solar in | Battery | Outputs | Battery tap for ADC? | Quiescent (max) | Wiki |
|---|---|---|---|---|---|---|
| **Solar Power Manager** (plain) | 6–24 V (MPPT SET switch) | 1× 14500 holder **+ PH2.0 connector** (any 3.7 V Li) | USB-A 5V/1A, pin header 5V, **pin header 3.3V/1A** | **YES** — battery at PH2.0 / holder terminals | **<2 mA** | https://www.waveshare.com/wiki/Solar_Power_Manager |
| **(B)** | 6–24 V | embedded 10000 mAh LiPo, metal case | 5V USB-A (product page: 5V/1A; current shared wiki table groups B+C at 5V/3A — conflicting), SW6106 chip | NO (battery inside case) | <80 mA | https://www.waveshare.com/wiki/Solar_Power_Manager_(B) |
| **(C)** | 6–24 V | 3× 18650 (7800 mAh), metal case | 5V/3A USB-A + Type-C (PD/QC…) | NO (inside case) | <80 mA | https://www.waveshare.com/wiki/Solar_Power_Manager_(C) |
| **(D)** | 6–24 V self-adaptive | 1× 3.7 V Li-ion, **via screw terminal or PH2.0 4-pin connector** (battery holder optional accessory) | **5V/3A screw terminal** + Type-C; chips: CN3791 (MPPT charge) + SW6201S (5V boost) + XB8089D0 (protection) | **YES** — battery screw terminal / PH2.0 pads directly expose cell voltage | <30 mA | https://www.waveshare.com/wiki/Solar_Power_Manager_(D) |
| **Module (D)** | same board family: product page titles the 45×40 mm (D) as "Solar Power Manager Module (D)"; sold as bare module or module+battery-holder kit ("Acce A"). Wiki page is an empty placeholder ("under production"). | | | | | https://www.waveshare.com/wiki/Solar_Power_Manager_Module_(D) ; product: https://www.waveshare.com/solar-power-manager-d.htm |

**For a single 18650/LiPo powering a 3.3 V MCU:** the **plain Solar Power Manager** is the only one with a 3.3 V/1A header AND the lowest quiescent (<2 mA), battery on PH2.0 → easy ADC tap. The **(D)** (45×40×10 mm) is the compact modern single-cell choice with exposed battery terminals (screw/PH2.0), but outputs only 5 V and lists <30 mA quiescent — for a µA-class sleeper you'd power the MCU straight from the cell (tap at the battery terminals) and ignore the 5 V boost.

## 3. BME680 breakout (GY-BME680 style)

- **I2C addresses:** 0x76 (SDO=GND) / 0x77 (SDO=VDD) — `BME68X_I2C_ADDR_LOW/HIGH` in `bme68x_defs.h` (lines 107/110). SDO must not float. Chinese GY-BME680/CJMCU-680 boards typically default **0x76** (SDO strapped low); Adafruit defaults 0x77. Verify with i2cdetect. Sources: https://github.com/boschsensortec/BME68x_SensorAPI/blob/master/bme68x_defs.h , https://learn.adafruit.com/adafruit-bme680-humidity-temperature-barometic-pressure-voc-gas/arduino-wiring-test
- **Supply:** sensor VDD 1.71–3.6 V, VDDIO 1.2–3.6 V (Bosch). Many GY-style breakouts carry an XC6206 ("662K") LDO for 5 V tolerance (e.g. Watterott board docs: https://learn.watterott.com/sensors/bme680/); the smallest purple CJMCU-680 boards are often 3.3 V-only with no level shifter — check your specific board.
- **Current (Bosch product page https://www.bosch-sensortec.com/products/environmental-sensors/gas-sensors/bme680/):** 2.1 µA @1 Hz H+T; 3.1 µA @1 Hz P+T; 3.7 µA @1 Hz H+P+T; **0.09–12 mA for p/h/T/gas depending on mode** (gas heater peaks ~12 mA); sleep mode 0.15 µA (datasheet BST-BME680-DS001).
- **Bosch API:** https://github.com/boschsensortec/BME68x_SensorAPI — license **BSD-3-Clause** (repo license + SPDX headers). Vendor exactly **`bme68x.c`, `bme68x.h`, `bme68x_defs.h`** from repo root. Current tag: **v4.4.8**.
- **Forced-mode + gas flow** (examples/forced_mode/forced_mode.c): `bme68x_init` → `bme68x_set_conf` (`os_hum=BME68X_OS_16X`, `os_pres=BME68X_OS_1X`, `os_temp=BME68X_OS_2X`, `filter=OFF`, `odr=NONE`) → `bme68x_set_heatr_conf(BME68X_FORCED_MODE, {enable=BME68X_ENABLE, heatr_temp=300 /*°C*/, heatr_dur=100 /*ms*/})` → per sample: `bme68x_set_op_mode(BME68X_FORCED_MODE)` → wait `bme68x_get_meas_dur(FORCED, &conf, &bme) + heatr_dur*1000` µs → `bme68x_get_data(BME68X_FORCED_MODE, &data, &n_fields, &bme)`.
- **Fields/status:** gas value is **`data.gas_resistance`** (Ω; uint32 int-API / float FPU-API). `data.status` masks: `BME68X_NEW_DATA_MSK` 0x80, `BME68X_GASM_VALID_MSK` 0x20, **`BME68X_HEAT_STAB_MSK` 0x10** — gas reading is only trustworthy when both GASM_VALID and HEAT_STAB are set (heater reached stable temperature).
- **"BME860" does not exist** — Bosch's gas-sensor parts are BME680 and BME688 only.

## 4. esp-zigbee-sdk: sleepy end device + deep sleep (ESP32-C6, IDF 5.4)

**Example locations.** Main branch (SDK/lib 2.x, new `ezb_*` API): `examples/sleepy_devices/deep_sleep_end_device/`. The 1.x-API version referenced everywhere (`esp_zb_*`) lived at `examples/esp_zigbee_sleep/deep_sleep/` — last 1.x-layout commit `e6f0fde` (2025-05-22): https://github.com/espressif/esp-zigbee-sdk/tree/e6f0fde5ca87/examples/esp_zigbee_sleep/deep_sleep . The 2.x lib keeps the 1.x API under `components/esp-zigbee-lib/include/compat/`.

**Kconfig (sdkconfig.defaults of deep_sleep example):**
- `CONFIG_ZB_ENABLED=y`, `CONFIG_ZB_ZED=y`
- custom partition table incl. `zb_storage` (fat, 16K) + `zb_fct` (1K) — network state persists here
- deep-sleep extras: `CONFIG_NEWLIB_TIME_SYSCALL_USE_RTC_HRT=y`, `CONFIG_RTC_CLK_SRC_INT_RC=y`, `CONFIG_BOOTLOADER_SKIP_VALIDATE_IN_DEEP_SLEEP=y`
- **CONFIRMED: no `CONFIG_PM_ENABLE`, no tickless idle, no `CONFIG_IEEE802154_SLEEP_ENABLE` for pure deep sleep.** Those (`CONFIG_PM_ENABLE=y`, `CONFIG_FREERTOS_USE_TICKLESS_IDLE=y`, `CONFIG_PM_POWER_DOWN_PERIPHERAL_IN_LIGHT_SLEEP=y`, `CONFIG_IEEE802154_SLEEP_ENABLE=y`, `CONFIG_FREERTOS_HZ=1000`, `CONFIG_ESP_SLEEP_POWER_DOWN_FLASH=y`) belong to the **light_sleep** example only.
- Likewise **`esp_zb_sleep_enable(true)` + `esp_zb_sleep_now()` (on `ESP_ZB_COMMON_SIGNAL_CAN_SLEEP`) are light-sleep APIs — NOT called in the deep-sleep example.**

**ZED config (1.x):** `ESP_ZB_ZED_CONFIG()` → `esp_zb_cfg_t{ .esp_zb_role=ESP_ZB_DEVICE_TYPE_ED, .nwk_cfg.zed_cfg={ .ed_timeout=ESP_ZB_ED_AGING_TIMEOUT_64MIN, .keep_alive=4000 /*ms*/ } }`; plus `esp_zb_set_rx_on_when_idle(false)` semantics (2.x: `ezb_nwk_set_rx_on_when_idle(false)`).

**Flow (1.x example, deep_sleep/main/esp_zb_sleepy_end_device.c):**
1. `app_main`: `nvs_flash_init` → `esp_zb_platform_config` → `zb_deep_sleep_init()`: create esp_timer one-shot; print wake cause; `esp_sleep_enable_timer_wakeup(20 s)`; `esp_sleep_enable_ext1_wakeup(BIT(BOOT_GPIO), ESP_EXT1_WAKEUP_ANY_LOW)` + `rtc_gpio_pullup_en` (mismatched pull config costs 3–4× sleep current via GPIO hold, per code comment).
2. Zigbee task: `esp_zb_init(&zb_nwk_cfg)` → create endpoint → `esp_zb_device_register` → `esp_zb_start(false)` → `esp_zb_stack_main_loop()`.
3. Signals: `ESP_ZB_ZDO_SIGNAL_SKIP_STARTUP` → `esp_zb_bdb_start_top_level_commissioning(ESP_ZB_BDB_MODE_INITIALIZATION)`. `DEVICE_FIRST_START/DEVICE_REBOOT` OK: if `esp_zb_bdb_is_factory_new()` → NETWORK_STEERING; **else (rebooted, incl. every deep-sleep wake) → `zb_deep_sleep_start()`** = start 5 s one-shot whose callback does `esp_deep_sleep_start()`. `ESP_ZB_BDB_SIGNAL_STEERING` OK (first join) → same 5 s → sleep. Failures → retry via `esp_zb_scheduler_alarm(cb, mode, 1000 ms)`.
4. **State restore:** `esp_zb_start(false)` = no autostart; after the app kicks BDB INITIALIZATION the stack loads network parameters from the `zb_storage` NVRAM partition and emits `DEVICE_REBOOT` (non-factory-new) — **no full steering/joining repeats after wake**. README: every deep-sleep wake is a reboot and the device "needs to undergo a re-attach process" (parent poll/rejoin handshake — extra packets vs light sleep); Espressif recommends deep sleep when sleep periods are long (>~30 min), light sleep for a spec-compliant always-attached SED.
Sources: https://github.com/espressif/esp-zigbee-sdk/tree/main/examples/sleepy_devices/deep_sleep_end_device , old layout: https://github.com/espressif/esp-zigbee-sdk/blob/e6f0fde5ca87/examples/esp_zigbee_sleep/deep_sleep/main/esp_zb_sleepy_end_device.c , FAQ: https://docs.espressif.com/projects/esp-zigbee-sdk/en/latest/esp32c6/faq.html

**Power Configuration cluster 0x0001 (1.x compat API):**
- `esp_zb_power_config_cluster_create(esp_zb_power_config_cluster_cfg_t*)` creates **only mains voltage + frequency attributes by default** — the cfg struct has only mains fields; battery attrs are NOT included ("No mandatory attributes are requested by the ZCL specs", header comment).
- Add battery attrs to the returned list with `esp_zb_power_config_cluster_add_attr(attr_list, attr_id, value_p)` (compat/esp_zigbee_attribute.h:136):
  - `ESP_ZB_ZCL_ATTR_POWER_CONFIG_BATTERY_VOLTAGE_ID` = **0x0020**, uint8, unit **100 mV** (e.g. 4.1 V → 41)
  - `ESP_ZB_ZCL_ATTR_POWER_CONFIG_BATTERY_PERCENTAGE_REMAINING_ID` = **0x0021**, uint8, unit **0.5 %** → store `percent * 2` (0–200)
  then `esp_zb_cluster_list_add_power_config_cluster(cluster_list, attr_list, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE)`.
- **Gotchas:** BatteryVoltage (0x0020) is not reportable in the stack — read/poll it, only 0x0021 is practical for reporting (Espressif answer in https://github.com/espressif/esp-zigbee-sdk/issues/463 ; also #194, #728 for attribute update/reporting pitfalls). **Z2M divides `batteryPercentageRemaining` by 2 by default** (zigbee-herdsman-converters `fz.battery`: `percentage = dontDividePercentage ? percentage : percentage / 2`, src/converters/fromZigbee.ts) — a device that reports 0–100 shows halved battery in Z2M unless its converter sets `meta.battery.dontDividePercentage`. Report 0–200 to be ZCL-compliant.
- Headers: https://github.com/espressif/esp-zigbee-sdk/blob/main/components/esp-zigbee-lib/include/compat/zcl/esp_zigbee_zcl_power_config.h

**Zigbee2MQTT + sleepy device interview:**
- The device must be awake and answering during the whole interview. Z2M FAQ: keep a battery device awake while pairing by pressing its button every ~3 s ( https://www.zigbee2mqtt.io/guide/faq/ ). For DIY firmware the standard pattern is: after first join (STEERING success while factory-new) **delay the first sleep long enough for the interview to finish** (the example's 5 s is usually too short; 30–60 s+ or "stay awake until button press/interview traffic stops" is common practice in DIY sleepy builds, cf. https://bikerglen.com/blog/building-battery-powered-zigbee-buttons/ , https://github.com/espressif/arduino-esp32/discussions/12247 ).
- **Availability:** Z2M treats battery devices as *passive* — never pinged; default they must check in every **25 hours** or get marked offline; any received message resets the timer ( https://www.zigbee2mqtt.io/guide/configuration/device-availability.html ).

## 5. ESP32-C6 ADC calibration (IDF 5.4)

- Driver: `adc_oneshot` (`adc_oneshot_new_unit`, `adc_oneshot_config_channel`, `adc_oneshot_read`). ADC1 channels = GPIO0–6.
- Calibration: ESP32-C6 supports **`ADC_CALI_SCHEME_VER_CURVE_FITTING`** — create with `adc_cali_create_scheme_curve_fitting(&(adc_cali_curve_fitting_config_t){ .unit_id, .chan, .atten, .bitwidth=ADC_BITWIDTH_12 }, &handle)`, convert with `adc_cali_raw_to_voltage`. Docs: https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c6/api-reference/peripherals/adc_calibration.html
- Attenuation ranges on C6 (datasheet "ADC Characteristics"; community summary https://blog.cyril.by/en/free-speech/esp32-c6-adc-references ): 0 dB ≈ 0–1.0 V, 2.5 dB ≈ 0–1.3 V, 6 dB ≈ 0–1.9 V, **12 dB ≈ 0–3.3 V**. Datasheet: https://www.espressif.com/sites/default/files/documentation/esp32-c6_datasheet_en.pdf
- **For a 4.2 V max cell behind a /2 divider (≤2.1–2.2 V at the pin): use `ADC_ATTEN_DB_12`** — DB_6 tops out ~1.9 V, too low; 2.2 V sits comfortably inside the DB_12 calibrated range.
