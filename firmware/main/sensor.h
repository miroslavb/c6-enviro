// sensor.h — BME680 over I2C via the vendored Bosch BME68x Sensor API.
//
// One forced-mode T/P/H(+gas) measurement per wake cycle. The Bosch API does
// all compensation math; this module provides the I2C HAL underneath it and a
// single blocking entry point sized for the deep-sleep duty cycle
// (~250 ms including the gas heater; ~140 ms without).
#pragma once

#include <stdint.h>
#include <stdbool.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    int32_t  temp_c100;    // °C × 100
    uint32_t hum_c100;     // % × 100
    uint32_t press_pa;     // Pa
    uint32_t gas_ohm;      // gas resistance, Ω (0 if gas disabled or invalid)
    bool     gas_valid;    // gas measurement valid this cycle
    bool     heater_stable;// gas heater reached stability
} sensor_reading_t;

// Probe the BME680 (tries I2C addresses 0x76 then 0x77) and run one forced
// measurement. `with_gas` runs the heater profile from Kconfig.
// Blocking; returns ESP_OK on success.
esp_err_t sensor_measure(bool with_gas, sensor_reading_t *out);

#ifdef __cplusplus
}
#endif
