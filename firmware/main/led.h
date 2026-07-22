// led.h — single WS2812 RGB LED on GPIO8 (RMT backend via led_strip).
//
// GPIO8 is a strapping pin on the C6 (must be high at boot for normal flash
// boot). We therefore initialise the LED AFTER boot (from app_main), never drive
// it during reset, and the WS2812 data line idles low harmlessly meanwhile.
#pragma once

#include <stdint.h>
#include <stdbool.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

// Status colours used when the LED is acting as a commissioning/diagnostic
// indicator (i.e. while HA has not taken control / LED is off from HA's view).
typedef enum {
    LED_STATUS_OFF = 0,
    LED_STATUS_BOOT,        // white  — booting
    LED_STATUS_JOINING,     // blue   — network steering
    LED_STATUS_JOINED,      // green  — on network
    LED_STATUS_ERROR,       // red    — steering/stack error
    LED_STATUS_IDENTIFY,    // magenta blink — Identify cluster
} led_status_t;

esp_err_t led_init(void);

// HA light control (driven from the Zigbee On/Off + Level + Color callbacks).
// set_on toggles output; set_level sets brightness 0..255; set_color_xy converts
// a ZCL ColorControl CurrentX/CurrentY pair (each 0..65535) to RGB.
void led_set_on(bool on);
void led_set_level(uint8_t level);          // 0..255
void led_set_color_xy(uint16_t x, uint16_t y);

// Apply the current HA light state (on/level/color) to the hardware. Call after
// any of the setters, or to re-assert state.
void led_apply(void);

// Drive a status colour (overrides HA colour until led_apply() is called again).
// Used while idle/unjoined for at-a-glance diagnostics.
void led_show_status(led_status_t status);

// Blank the pixel before deep sleep (the WS2812 IC itself still draws some
// quiescent current — hardware-level note in docs/HARDWARE.md).
void led_off(void);

#ifdef __cplusplus
}
#endif
