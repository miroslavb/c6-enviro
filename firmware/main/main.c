// main.c — wake-cycle orchestrator for the C6 enviro sensor.
//
// The device lives in deep sleep. Each cycle:
//   1. Wake (RTC timer) → measure BME680 + battery BEFORE the radio starts
//      (sensor conversion overlaps nothing; data is ready when the network is).
//   2. Start Zigbee: deep-sleep wake restores the network from zb_storage
//      NVRAM (DEVICE_REBOOT); a factory-new device steers (permit-join must be
//      open in Z2M).
//   3. On join, push the snapshot; the stack reporting engine transmits; after
//      the flush window → deep sleep for (interval − time awake).
//
// Stay-awake rules (a sleepy device that naps mid-interview never finishes
// pairing — Z2M FAQ):
//   * first (factory-new) join OR a cold boot with restored network NVRAM →
//     stay awake AWAKE_WINDOW_S (300 s), measuring and reporting every interval,
//     THEN start sleeping. The restored-network case covers firmware updates
//     while Z2M is retrying an incomplete interview.
//   * BOOT short press while awake → extend the window by AWAKE_WINDOW_S
//     (the device is awake ~2.5 s of every cycle — hold the button briefly).
//   * BOOT long press (3 s) → Zigbee factory reset (buttons.c).
//
// Battery protection: an unjoined device burns ~80 mA scanning. If there is
// no network after ENVIRO_JOIN_TIMEOUT_S, sleep ENVIRO_RETRY_SLEEP_S and try
// again on the next wake.
#include <inttypes.h>

#include "esp_log.h"
#include "esp_sleep.h"
#include "esp_timer.h"
#include "nvs_flash.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"
#include "sdkconfig.h"

#include "app_config.h"
#include "battery.h"
#include "buttons.h"
#include "cycle.h"
#include "led.h"
#include "sensor.h"
#include "version.h"
#include "zb_contract.h"
#include "zb_device.h"

static const char *TAG = "main";

// Wake counter: survives deep sleep, resets on power-on/reset — exactly the
// "cycles since power-up" semantic the wake_count telemetry wants.
static RTC_DATA_ATTR uint32_t s_rtc_wake_count = 0;
// Previous cycle's awake duration (RTC-carried so the value survives the deep
// sleep between measurement and report).
static RTC_DATA_ATTR uint16_t s_rtc_prev_awake_ms = 0;

// Event bits (set from the Zigbee stack task via zb_event_cb).
#define EVT_JOINED      BIT0
#define EVT_FIRST_JOIN  BIT1
#define EVT_FLUSHED     BIT2
#define EVT_LEFT        BIT3
static EventGroupHandle_t s_events;

// Awake-window end, µs since boot (0 = no window: sleep after first flush).
static volatile int64_t s_awake_until_us = 0;

static void zb_event_handler(zb_event_t evt)
{
    switch (evt) {
    case ZB_EVT_JOINED:         xEventGroupSetBits(s_events, EVT_JOINED); break;
    case ZB_EVT_FIRST_JOIN:     xEventGroupSetBits(s_events, EVT_FIRST_JOIN); break;
    case ZB_EVT_REPORT_FLUSHED: xEventGroupSetBits(s_events, EVT_FLUSHED); break;
    case ZB_EVT_LEFT:           xEventGroupSetBits(s_events, EVT_LEFT); break;
    case ZB_EVT_JOIN_FAILED:    /* main polls the timeout budget */ break;
    }
}

static void on_button_short_press(void)
{
    // Z2M FAQ pattern: a button press keeps the battery device awake — used
    // during pairing/interview and for on-demand debugging.
    zb_device_enable_interview_rx();
    s_awake_until_us = esp_timer_get_time() + (int64_t)AWAKE_WINDOW_S * 1000000;
    ESP_LOGI(TAG, "BOOT press: staying awake %d s", AWAKE_WINDOW_S);
    led_show_status(LED_STATUS_JOINING);
}

static void do_measure(bool first_boot)
{
    enviro_measurement_t *m = &g_measurement;
    m->first_boot = first_boot;
    m->wake_count = s_rtc_wake_count;
    m->awake_ms   = s_rtc_prev_awake_ms;

    uint16_t mv = 0;
    m->vbat_ok = battery_read_mv(&mv) == ESP_OK;
    m->vbat_mv = m->vbat_ok ? mv : 0;

    sensor_reading_t r;
    m->sensor_ok = sensor_measure(g_config.gas_enabled, &r) == ESP_OK;
    if (m->sensor_ok) {
        m->temp_c100     = r.temp_c100;
        m->hum_c100      = r.hum_c100;
        m->press_pa      = r.press_pa;
        m->gas_ohm       = r.gas_ohm;
        m->heater_stable = r.heater_stable;
    } else {
        m->gas_ohm = 0;
        m->heater_stable = false;
    }
}

static void go_to_sleep(uint32_t sleep_ms) __attribute__((noreturn));
static void go_to_sleep(uint32_t sleep_ms)
{
    const uint32_t awake = (uint32_t)(esp_timer_get_time() / 1000);
    s_rtc_prev_awake_ms = (uint16_t)(awake > 0xFFFF ? 0xFFFF : awake);
    led_off();
    ESP_LOGI(TAG, "deep sleep %" PRIu32 " ms (cycle %" PRIu32 " took %" PRIu32 " ms awake)",
             sleep_ms, s_rtc_wake_count,
             (uint32_t)(esp_timer_get_time() / 1000));
    esp_sleep_enable_timer_wakeup((uint64_t)sleep_ms * 1000ULL);
    esp_deep_sleep_start();
}

void app_main(void)
{
    const esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();
    const bool first_boot = (cause != ESP_SLEEP_WAKEUP_TIMER);
    s_rtc_wake_count++;

    ESP_LOGI(TAG, "C6-ENVIRO v%s starting (wake #%" PRIu32 ", %s)",
             FW_VERSION, s_rtc_wake_count,
             first_boot ? "cold boot" : "deep-sleep wake");

    // 1. NVS + persisted config.
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    } else {
        ESP_ERROR_CHECK(err);
    }
    app_config_load(&g_config);

    // 2. Status LED: only on a cold boot (deep-sleep wakes stay dark — the
    //    WS2812 costs real battery; see docs/HARDWARE.md on its parasitic
    //    draw and the desolder option).
    if (led_init() == ESP_OK && first_boot) {
        led_show_status(LED_STATUS_BOOT);
    }

    // 3. BOOT button (short = stay awake, long = factory reset).
    if (buttons_init(on_button_short_press) != ESP_OK) {
        ESP_LOGW(TAG, "button init failed (factory reset via button unavailable)");
    }

    // 4. Measure FIRST — the sensor + ADC are ready before the network is.
    do_measure(first_boot);

    // 5. Zigbee.
    s_events = xEventGroupCreate();
    ESP_ERROR_CHECK(zb_device_start(zb_event_handler));

    // 6. Wait for the network (NVRAM restore is fast; steering can take a
    //    while and only succeeds with permit-join open).
    const int64_t t_start = esp_timer_get_time();
    bool joined = false;
    while (!joined) {
        EventBits_t bits = xEventGroupWaitBits(
            s_events, EVT_JOINED | EVT_FIRST_JOIN, pdTRUE, pdFALSE,
            pdMS_TO_TICKS(1000));
        if (bits & EVT_FIRST_JOIN) {
            joined = true;
            s_awake_until_us = esp_timer_get_time() + (int64_t)AWAKE_WINDOW_S * 1000000;
            ESP_LOGI(TAG, "first join — staying awake %d s for the Z2M interview",
                     AWAKE_WINDOW_S);
        } else if (bits & EVT_JOINED) {
            joined = true;
            // A firmware flash/power reset preserves zb_storage, so the stack
            // reports a normal NVRAM restore rather than fresh steering. Z2M
            // may still be retrying an incomplete interview from the previous
            // build; reopen the commissioning window on cold boots only. Timer
            // deep-sleep wakes remain battery-efficient and go straight back
            // to the normal short report cycle.
            if (first_boot) {
                zb_device_enable_interview_rx();
                s_awake_until_us = esp_timer_get_time() +
                                   (int64_t)AWAKE_WINDOW_S * 1000000;
                ESP_LOGI(TAG,
                         "cold boot with restored network — staying awake %d s for Z2M re-interview",
                         AWAKE_WINDOW_S);
            }
        } else if (s_awake_until_us == 0 &&
                   esp_timer_get_time() - t_start >
                       (int64_t)CONFIG_ENVIRO_JOIN_TIMEOUT_S * 1000000) {
            ESP_LOGW(TAG, "no network after %d s — sleeping %d s before retry",
                     CONFIG_ENVIRO_JOIN_TIMEOUT_S, CONFIG_ENVIRO_RETRY_SLEEP_S);
            go_to_sleep((uint32_t)CONFIG_ENVIRO_RETRY_SLEEP_S * 1000u);
        }
    }

    // 7. Cycle loop: push → flush → (sleep | stay awake and re-measure).
    for (;;) {
        const int64_t cycle_start = esp_timer_get_time();
        zb_device_push_measurement();

        EventBits_t bits = xEventGroupWaitBits(
            s_events, EVT_FLUSHED | EVT_LEFT, pdTRUE, pdFALSE,
            pdMS_TO_TICKS(CONFIG_ENVIRO_REPORT_FLUSH_MS + 8000));
        if (bits & EVT_LEFT) {
            // Kicked off the network: steering restarted in zb_device. Give it
            // the join-timeout budget, then power-protect.
            ESP_LOGW(TAG, "left network mid-cycle — waiting to rejoin");
            bits = xEventGroupWaitBits(s_events, EVT_JOINED | EVT_FIRST_JOIN,
                                       pdTRUE, pdFALSE,
                                       pdMS_TO_TICKS(CONFIG_ENVIRO_JOIN_TIMEOUT_S * 1000));
            if (!(bits & (EVT_JOINED | EVT_FIRST_JOIN))) {
                go_to_sleep((uint32_t)CONFIG_ENVIRO_RETRY_SLEEP_S * 1000u);
            }
            continue;   // re-push the same measurement after rejoin
        }

        const uint32_t awake_ms = (uint32_t)(esp_timer_get_time() / 1000);
        const uint16_t interval = g_config.report_interval_s;

        if (esp_timer_get_time() < s_awake_until_us) {
            // Awake window (pairing/interview/debug): keep the interval
            // cadence without sleeping.
            const int64_t next = cycle_start + (int64_t)interval * 1000000;
            int64_t wait_us = next - esp_timer_get_time();
            if (wait_us > 0) vTaskDelay(pdMS_TO_TICKS((uint32_t)(wait_us / 1000)));
            do_measure(false);
            g_measurement.wake_count = ++s_rtc_wake_count;  // count logical cycles
            continue;
        }

        go_to_sleep(cycle_sleep_ms(interval, awake_ms, CONFIG_ENVIRO_MIN_SLEEP_MS));
    }
}
