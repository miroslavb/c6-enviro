// buttons.h — BOOT/user button (GPIO9, active-low) handling.
//   short press      -> cycle UI page
//   long press >3s   -> Zigbee factory reset (esp_zb_factory_reset + reboot)
// Debouncing is provided by the espressif/button component.
#pragma once

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

// Callback invoked on a short press (UI page cycle). Runs in the button task
// context — keep it light and only touch app_state / lvgl_port_lock.
typedef void (*button_short_press_cb_t)(void);

// Initialise the BOOT button. `short_cb` is called on a single short press; a
// long press (>3s) triggers the Zigbee factory reset directly (see buttons.c).
esp_err_t buttons_init(button_short_press_cb_t short_cb);

#ifdef __cplusplus
}
#endif
