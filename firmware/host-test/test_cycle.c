// test_cycle.c — host unit tests for the pure wake-cycle logic (cycle.c).
// Build & run: make -C firmware/host-test
#include <stdio.h>
#include <stdlib.h>

#include "cycle.h"

static int g_fail = 0, g_pass = 0;

#define CHECK(cond, ...) do { \
    if (cond) { g_pass++; } \
    else { g_fail++; printf("FAIL %s:%d: ", __FILE__, __LINE__); printf(__VA_ARGS__); printf("\n"); } \
} while (0)

static void test_battery_percent(void)
{
    // Anchors.
    CHECK(cycle_battery_percent(4300) == 100, "4300mV -> 100 (got %u)", cycle_battery_percent(4300));
    CHECK(cycle_battery_percent(4200) == 100, "4200mV -> 100");
    CHECK(cycle_battery_percent(3000) == 0,   "3000mV -> 0");
    CHECK(cycle_battery_percent(2500) == 0,   "2500mV -> 0");
    // Curve anchor points.
    CHECK(cycle_battery_percent(3700) == 45,  "3700mV -> 45 (got %u)", cycle_battery_percent(3700));
    CHECK(cycle_battery_percent(3500) == 15,  "3500mV -> 15 (got %u)", cycle_battery_percent(3500));
    // Interpolation is monotone and in-range between anchors.
    unsigned prev = 0;
    for (uint16_t mv = 3000; mv <= 4200; mv += 10) {
        unsigned p = cycle_battery_percent(mv);
        CHECK(p <= 100, "pct in range at %umV", mv);
        CHECK(p >= prev, "monotone at %umV (%u < %u)", mv, p, prev);
        prev = p;
    }
    // Midpoint interpolation: 3750 is halfway 3700(45)..3800(60) -> ~52.
    unsigned mid = cycle_battery_percent(3750);
    CHECK(mid >= 51 && mid <= 53, "3750mV -> ~52 (got %u)", mid);
}

static void test_battery_zcl(void)
{
    // batteryVoltage: 100 mV units, rounded; 0xFF reserved for "invalid".
    CHECK(cycle_battery_voltage_zcl(4200) == 42, "4200mV -> 42 (got %u)", cycle_battery_voltage_zcl(4200));
    CHECK(cycle_battery_voltage_zcl(3649) == 36, "3649mV -> 36");
    CHECK(cycle_battery_voltage_zcl(3650) == 37, "3650mV rounds to 37");
    CHECK(cycle_battery_voltage_zcl(65535) == 0xFE, "saturates at 0xFE");
    // batteryPercentageRemaining: 0.5 % units (Z2M divides by 2).
    CHECK(cycle_battery_percent_zcl(4200) == 200, "4200mV -> 200 half-percent");
    CHECK(cycle_battery_percent_zcl(3000) == 0,   "3000mV -> 0");
    CHECK(cycle_battery_percent_zcl(3700) == 90,  "3700mV -> 45%% = 90 (got %u)", cycle_battery_percent_zcl(3700));
}

static void test_clamp_interval(void)
{
    CHECK(cycle_clamp_interval_s(0, 3, 3600) == 3,      "0 clamps to min");
    CHECK(cycle_clamp_interval_s(3, 3, 3600) == 3,      "min passes");
    CHECK(cycle_clamp_interval_s(60, 3, 3600) == 60,    "in-range passes");
    CHECK(cycle_clamp_interval_s(3600, 3, 3600) == 3600,"max passes");
    CHECK(cycle_clamp_interval_s(999999, 3, 3600) == 3600, "huge clamps to max");
}

static void test_sleep_ms(void)
{
    // 3 s interval, 800 ms awake -> 2200 ms sleep (interval-compensated cadence).
    CHECK(cycle_sleep_ms(3, 800, 500) == 2200, "3s/800ms -> 2200 (got %u)",
          (unsigned)cycle_sleep_ms(3, 800, 500));
    // Awake longer than the period -> floor at min_sleep.
    CHECK(cycle_sleep_ms(3, 3000, 500) == 500, "awake == period -> min");
    CHECK(cycle_sleep_ms(3, 300000, 500) == 500, "awake >> period -> min (post-window)");
    // Long interval.
    CHECK(cycle_sleep_ms(3600, 2500, 500) == 3600000 - 2500, "1h interval compensated");
    // Zero-awake pathological input.
    CHECK(cycle_sleep_ms(3, 0, 500) == 3000, "0 awake -> full period");
}

// New normal-wake guard contract: with a strict whole-second reporting clock,
// release the sole wake-cycle write only after the NEXT full tick plus margin.
// Declared locally so this RED test links only once production implements it.
extern uint32_t cycle_reporting_settle_ms(uint16_t min_interval_s,
                                          uint16_t tick_guard_ms);
extern uint16_t cycle_reporting_max_interval_s(uint16_t report_interval_s,
                                                uint16_t min_interval_s);

static void test_reporting_settle_guard(void)
{
    CHECK(cycle_reporting_settle_ms(1, 0) == 2000,
          "1s strict reporting minimum needs the next whole second");
    CHECK(cycle_reporting_settle_ms(1, 200) == 2200,
          "1s strict reporting minimum plus 200ms guard -> 2200ms");
    CHECK(cycle_reporting_settle_ms(3, 200) == 4200,
          "settle preserves a full extra reporting tick at larger minima");
}

static void test_reporting_max_interval(void)
{
    CHECK(cycle_reporting_max_interval_s(3, 1) == 3,
          "minimum supported 3s cadence must not emit a faster heartbeat");
    CHECK(cycle_reporting_max_interval_s(30, 1) == 30,
          "30s configuration is the reporting maximum heartbeat");
    CHECK(cycle_reporting_max_interval_s(1, 1) == 1,
          "max interval must never fall below the reporting minimum");
    CHECK(cycle_reporting_max_interval_s(0, 1) == 1,
          "invalid zero requested max clamps to the reporting minimum");
}

static void test_reporting_wait_action(void)
{
    CHECK(cycle_report_action(false, false) == CYCLE_REPORT_TIMEOUT,
          "no READY/LEFT event -> timeout");
    CHECK(cycle_report_action(true, false) == CYCLE_REPORT_READY,
          "READY alone -> push");
    CHECK(cycle_report_action(false, true) == CYCLE_REPORT_REJOIN,
          "LEFT during reporting settle -> rejoin");
    CHECK(cycle_report_action(true, true) == CYCLE_REPORT_REJOIN,
          "LEFT wins over simultaneous stale READY");
}

static void test_join_awake_window(void)
{
    CHECK(cycle_join_opens_awake_window(true, false),
          "fresh steering join after a timer wake reopens commissioning window");
    CHECK(cycle_join_opens_awake_window(true, true),
          "fresh steering join on cold boot opens commissioning window");
    CHECK(cycle_join_opens_awake_window(false, true),
          "cold-boot NVRAM restore reopens commissioning window");
    CHECK(!cycle_join_opens_awake_window(false, false),
          "normal timer NVRAM restore remains a short battery wake");
}

static void test_join_wait_deadline(void)
{
    const int64_t start = 1000000;
    const int64_t commissioning_end = start + 300000000;

    CHECK(!cycle_join_wait_expired(start + 59000000, start, 60, 0),
          "normal join remains awake inside its 60 s budget");
    CHECK(cycle_join_wait_expired(start + 60000000, start, 60, 0),
          "normal failed join expires at 60 s");
    CHECK(!cycle_join_wait_expired(start + 299000000, start, 60,
                                   commissioning_end),
          "active commissioning window may outlive the join timeout");
    CHECK(cycle_join_wait_expired(commissioning_end, start, 60,
                                  commissioning_end),
          "failed rejoin expires when the longer commissioning window ends");
    CHECK(!cycle_join_wait_expired(start + 59000000, start, 60, start - 1),
          "stale awake timestamp cannot shorten a new join budget");
    CHECK(cycle_join_wait_expired(start + 60000000, start, 60, start - 1),
          "stale nonzero awake timestamp cannot disable the battery timeout");
}

static void test_status_flags(void)
{
    // Bit numbers mirror the generated contract (contract.json statusBits).
    enum { B_SENS = 0, B_HEAT = 1, B_BATT = 2, B_VBAT = 3, B_GAS = 4, B_BOOT = 5 };

    cycle_status_t st = {0};
    CHECK(cycle_status_flags(&st, B_SENS, B_HEAT, B_BATT, B_VBAT, B_GAS, B_BOOT) == 0,
          "all-clear -> 0");

    st.sensor_error = true;
    st.battery_low = true;
    uint16_t f = cycle_status_flags(&st, B_SENS, B_HEAT, B_BATT, B_VBAT, B_GAS, B_BOOT);
    CHECK(f == ((1u << B_SENS) | (1u << B_BATT)), "sensor+battery -> 0x%04X", f);

    cycle_status_t all = {true, true, true, true, true, true};
    f = cycle_status_flags(&all, B_SENS, B_HEAT, B_BATT, B_VBAT, B_GAS, B_BOOT);
    CHECK(f == 0x3F, "all set -> 0x3F (got 0x%04X)", f);
}

int main(void)
{
    test_battery_percent();
    test_battery_zcl();
    test_clamp_interval();
    test_sleep_ms();
    test_reporting_settle_guard();
    test_reporting_max_interval();
    test_reporting_wait_action();
    test_join_awake_window();
    test_join_wait_deadline();
    test_status_flags();

    printf("%s: %d passed, %d failed\n", g_fail ? "FAIL" : "OK", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
