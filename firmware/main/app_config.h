// app_config.h — NVS-persisted device configuration + shared cycle state.
//
// Two writable settings arrive from HA over the custom cluster (zb_device.c
// SET_ATTR handler) and must survive deep sleep AND power loss, so they live
// in the main NVS partition:
//   report_interval_s — deep-sleep measurement/report period
//   gas_enabled       — run the BME680 gas heater each cycle
//
// The measurement snapshot produced each wake is plain shared state between
// the cycle task (writer) and the Zigbee stack task (reader). A mutex-free
// hand-off is safe here: the writer fills it BEFORE kicking the Zigbee push,
// and nothing mutates it until the next cycle.
#pragma once

#include <stdint.h>
#include <stdbool.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    // BME680
    bool     sensor_ok;        // probe + measure succeeded
    bool     heater_stable;    // gas heater stability bit
    int32_t  temp_c100;        // °C × 100
    uint32_t hum_c100;         // % × 100
    uint32_t press_pa;         // Pa
    uint32_t gas_ohm;          // gas resistance, Ω (0 when gas disabled/invalid)
    // Battery
    bool     vbat_ok;
    uint16_t vbat_mv;
    // Cycle metadata
    uint32_t wake_count;
    uint16_t awake_ms;         // previous cycle's awake duration (RTC-carried)
    bool     first_boot;       // cold boot (power-on/reset), not deep-sleep wake
} enviro_measurement_t;

// ---- persisted settings ----
typedef struct {
    uint16_t report_interval_s;
    bool     gas_enabled;
} enviro_config_t;

// Load settings from NVS (falling back to contract defaults). Call once per
// boot after nvs_flash_init().
esp_err_t app_config_load(enviro_config_t *out);

// Persist settings to NVS (called from the Zigbee SET_ATTR handler).
esp_err_t app_config_save(const enviro_config_t *cfg);

// Global accessors (single-writer patterns; see header comment).
extern enviro_config_t      g_config;
extern enviro_measurement_t g_measurement;

#ifdef __cplusplus
}
#endif
