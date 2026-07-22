// buttons.c — BOOT button (GPIO9) via the espressif/button component.
#include "buttons.h"

#include "iot_button.h"
#include "button_gpio.h"
#include "esp_log.h"

#include "zb_device.h"   // for zb_device_factory_reset()

static const char *TAG = "buttons";

#define BTN_GPIO        9      // BOOT/user button, active-low with internal pull-up
#define BTN_ACTIVE_LVL  0      // pressed = low
#define LONG_PRESS_MS   3000   // >3s hold = factory reset

static button_short_press_cb_t s_short_cb = NULL;

static void on_single_click(void *arg, void *usr)
{
    (void)arg; (void)usr;
    ESP_LOGI(TAG, "short press -> stay-awake window");
    if (s_short_cb) s_short_cb();
}

static void on_long_press(void *arg, void *usr)
{
    (void)arg; (void)usr;
    ESP_LOGW(TAG, "long press (>%dms) -> Zigbee factory reset", LONG_PRESS_MS);
    // This erases Zigbee NVRAM and reboots the device factory-new so it re-runs
    // network steering on next boot. Does not return.
    zb_device_factory_reset();
}

esp_err_t buttons_init(button_short_press_cb_t short_cb)
{
    s_short_cb = short_cb;

    const button_config_t btn_cfg = {
        .long_press_time = LONG_PRESS_MS,
        .short_press_time = 0,  // 0 = component default debounce
    };
    const button_gpio_config_t gpio_cfg = {
        .gpio_num     = BTN_GPIO,
        .active_level = BTN_ACTIVE_LVL,
        .enable_power_save = false,
        .disable_pull = false,  // use internal pull-up (BOOT idles high)
    };

    button_handle_t btn = NULL;
    esp_err_t err = iot_button_new_gpio_device(&btn_cfg, &gpio_cfg, &btn);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "button create failed: %s", esp_err_to_name(err));
        return err;
    }

    iot_button_register_cb(btn, BUTTON_SINGLE_CLICK, NULL, on_single_click, NULL);
    iot_button_register_cb(btn, BUTTON_LONG_PRESS_START, NULL, on_long_press, NULL);

    ESP_LOGI(TAG, "BOOT button ready (GPIO%d): short=stay awake, long(%dms)=factory reset",
             BTN_GPIO, LONG_PRESS_MS);
    return ESP_OK;
}
