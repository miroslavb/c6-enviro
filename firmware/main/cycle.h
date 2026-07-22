// cycle.h — PURE wake-cycle logic (no ESP-IDF dependencies).
//
// Everything here is deterministic C compiled both into the firmware and the
// host test-suite (firmware/host-test) — battery curve, sleep-time budgeting,
// interval clamping, status-flag composition. Keep it free of FreeRTOS/IDF
// headers so `make -C firmware/host-test` keeps passing on any host.
#pragma once

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

// ---- Battery ---------------------------------------------------------------

// Single-cell Li-ion state-of-charge estimate from open-circuit-ish voltage.
// Piecewise-linear over the standard discharge curve; returns 0..100.
// (The Waveshare Solar Power Manager charges to 4.2 V; the protection cutoff
// is ~3.0 V. Voltage under light load ≈ OCV for our duty cycle.)
uint8_t cycle_battery_percent(uint16_t mv);

// ZCL PowerConfig encodings.
// batteryVoltage (0x0020): units of 100 mV, saturating at 0xFE ("invalid" is 0xFF).
uint8_t cycle_battery_voltage_zcl(uint16_t mv);
// batteryPercentageRemaining (0x0021): units of 0.5 % (0..200).
uint8_t cycle_battery_percent_zcl(uint16_t mv);

// ---- Interval / sleep budgeting ---------------------------------------------

// Clamp the HA-written report interval to the contract range [min..max].
uint16_t cycle_clamp_interval_s(uint32_t requested_s, uint16_t min_s, uint16_t max_s);

// Deep-sleep duration for this cycle, in ms. The awake time already spent is
// subtracted from the configured period so the wake-to-wake cadence tracks
// `interval_s` (the user asked for an update every N seconds, not N seconds of
// sleep *plus* the awake time). Never returns less than `min_sleep_ms`.
uint32_t cycle_sleep_ms(uint16_t interval_s, uint32_t awake_ms, uint32_t min_sleep_ms);

// ---- Status flags -----------------------------------------------------------

typedef struct {
    bool sensor_error;     // BME680 probe/measure failed
    bool heater_unstable;  // gas heater stability bit not set
    bool battery_low;      // vbat < BATTERY_LOW_MV
    bool vbat_invalid;     // ADC read failed
    bool gas_disabled;     // gas heater off via HA
    bool first_boot;       // cold boot (not a deep-sleep wake)
} cycle_status_t;

// Compose the contract statusFlags bitmask from individual conditions.
// Bit positions come from zb_contract.h at the firmware call-site; the host
// test passes them explicitly so the pure code needs no generated header.
uint16_t cycle_status_flags(const cycle_status_t *st,
                            uint8_t bit_sensor_error,
                            uint8_t bit_heater_unstable,
                            uint8_t bit_battery_low,
                            uint8_t bit_vbat_invalid,
                            uint8_t bit_gas_disabled,
                            uint8_t bit_first_boot);

#ifdef __cplusplus
}
#endif
