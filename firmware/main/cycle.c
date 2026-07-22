// cycle.c — PURE wake-cycle logic. See cycle.h. NO ESP-IDF includes here.
#include "cycle.h"

// ---- Battery ---------------------------------------------------------------
// Piecewise-linear single-cell Li-ion SoC curve (resting voltage → %).
// Anchors chosen from the canonical 1S discharge curve; conservative at the
// bottom so "battery_low" automations fire while there is real charge left.
typedef struct { uint16_t mv; uint8_t pct; } soc_point_t;
static const soc_point_t SOC_CURVE[] = {
    {4200, 100},
    {4100,  94},
    {4000,  85},
    {3900,  74},
    {3800,  60},
    {3700,  45},
    {3600,  28},
    {3500,  15},
    {3400,   8},
    {3300,   4},
    {3200,   2},
    {3000,   0},
};
#define SOC_N (sizeof(SOC_CURVE) / sizeof(SOC_CURVE[0]))

uint8_t cycle_battery_percent(uint16_t mv)
{
    if (mv >= SOC_CURVE[0].mv) return 100;
    if (mv <= SOC_CURVE[SOC_N - 1].mv) return 0;
    for (unsigned i = 1; i < SOC_N; i++) {
        if (mv >= SOC_CURVE[i].mv) {
            // Linear interpolation between anchor i (lower V) and i-1 (higher V).
            const uint16_t v_hi = SOC_CURVE[i - 1].mv, v_lo = SOC_CURVE[i].mv;
            const uint8_t  p_hi = SOC_CURVE[i - 1].pct, p_lo = SOC_CURVE[i].pct;
            return (uint8_t)(p_lo + (uint32_t)(mv - v_lo) * (p_hi - p_lo) / (v_hi - v_lo));
        }
    }
    return 0; // unreachable
}

uint8_t cycle_battery_voltage_zcl(uint16_t mv)
{
    uint32_t dv = (mv + 50) / 100;      // round to 100 mV units
    if (dv > 0xFE) dv = 0xFE;           // 0xFF = "invalid" per ZCL
    return (uint8_t)dv;
}

uint8_t cycle_battery_percent_zcl(uint16_t mv)
{
    return (uint8_t)(cycle_battery_percent(mv) * 2); // 0.5 % units, 0..200
}

// ---- Interval / sleep budgeting ---------------------------------------------

uint16_t cycle_clamp_interval_s(uint32_t requested_s, uint16_t min_s, uint16_t max_s)
{
    if (requested_s < min_s) return min_s;
    if (requested_s > max_s) return max_s;
    return (uint16_t)requested_s;
}

uint32_t cycle_sleep_ms(uint16_t interval_s, uint32_t awake_ms, uint32_t min_sleep_ms)
{
    const uint32_t period_ms = (uint32_t)interval_s * 1000u;
    uint32_t sleep_ms = (awake_ms >= period_ms) ? 0 : (period_ms - awake_ms);
    if (sleep_ms < min_sleep_ms) sleep_ms = min_sleep_ms;
    return sleep_ms;
}

// ---- Status flags -----------------------------------------------------------

uint16_t cycle_status_flags(const cycle_status_t *st,
                            uint8_t bit_sensor_error,
                            uint8_t bit_heater_unstable,
                            uint8_t bit_battery_low,
                            uint8_t bit_vbat_invalid,
                            uint8_t bit_gas_disabled,
                            uint8_t bit_first_boot)
{
    uint16_t f = 0;
    if (st->sensor_error)    f |= (uint16_t)(1u << bit_sensor_error);
    if (st->heater_unstable) f |= (uint16_t)(1u << bit_heater_unstable);
    if (st->battery_low)     f |= (uint16_t)(1u << bit_battery_low);
    if (st->vbat_invalid)    f |= (uint16_t)(1u << bit_vbat_invalid);
    if (st->gas_disabled)    f |= (uint16_t)(1u << bit_gas_disabled);
    if (st->first_boot)      f |= (uint16_t)(1u << bit_first_boot);
    return f;
}
