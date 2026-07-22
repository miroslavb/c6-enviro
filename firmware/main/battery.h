// battery.h — battery voltage via ADC1 oneshot + calibration.
//
// The Waveshare Solar Power Manager's battery positive terminal reaches an
// ADC1 pin (GPIO0..6) through a resistive divider (see docs/WIRING.md). One
// averaged, calibrated reading per wake cycle; the divider ratio is
// compile-time (Kconfig: ENVIRO_VBAT_DIV_NUM / _DEN).
#pragma once

#include <stdint.h>
#include <stdbool.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

// One-shot battery read. Initialises the ADC, samples, converts through the
// calibration scheme and the divider ratio, then releases the unit.
// Returns ESP_OK and the battery voltage in mV, or an error (out untouched).
esp_err_t battery_read_mv(uint16_t *out_mv);

#ifdef __cplusplus
}
#endif
