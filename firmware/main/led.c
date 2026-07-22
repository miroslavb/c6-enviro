// led.c — WS2812 single LED via led_strip (RMT). See led.h for the strapping-pin
// caveat (init after boot).
#include "led.h"

#include "led_strip.h"
#include "esp_log.h"
#include "sdkconfig.h"

static const char *TAG = "led";

#define LED_GPIO        CONFIG_ENVIRO_LED_GPIO   // WS2812 data (Super Mini: GPIO8)
#define LED_COUNT       1
#define RMT_RES_HZ      (10 * 1000 * 1000)  // 10 MHz → 0.1us tick, fine for WS2812

static led_strip_handle_t s_strip = NULL;

// HA light state mirror (separate from app_state so led.c is self-contained and
// can be driven directly from the Zigbee callback).
static bool     s_on    = false;
static uint8_t  s_level = 128;            // 0..255
static uint8_t  s_r = 255, s_g = 255, s_b = 255;  // base colour (full-scale)

esp_err_t led_init(void)
{
    const led_strip_config_t strip_cfg = {
        .strip_gpio_num = LED_GPIO,
        .max_leds       = LED_COUNT,
        .led_model      = LED_MODEL_WS2812,
        .color_component_format = LED_STRIP_COLOR_COMPONENT_FMT_GRB,  // WS2812 = GRB
        .flags = { .invert_out = false },
    };
    const led_strip_rmt_config_t rmt_cfg = {
        .clk_src       = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = RMT_RES_HZ,
        .flags         = { .with_dma = false },  // 1 LED → DMA unnecessary
    };
    esp_err_t err = led_strip_new_rmt_device(&strip_cfg, &rmt_cfg, &s_strip);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "led_strip init failed: %s", esp_err_to_name(err));
        return err;
    }
    led_strip_clear(s_strip);
    ESP_LOGI(TAG, "WS2812 ready on GPIO%d", LED_GPIO);
    return ESP_OK;
}

// ---- HA setters ----
void led_set_on(bool on)        { s_on = on; }
void led_set_level(uint8_t lvl) { s_level = lvl; }

// Convert ZCL ColorControl CurrentX/CurrentY (CIE 1931 xyY, each 0..65535) to
// sRGB. This is an integer approximation good enough for a single status LED;
// exact colorimetry is unnecessary. We assume full luminance (Y=1) and apply the
// Level cluster brightness separately in led_apply().
void led_set_color_xy(uint16_t x16, uint16_t y16)
{
    // Normalise to 0..1.
    float x = (float)x16 / 65536.0f;
    float y = (float)y16 / 65536.0f;
    if (y < 0.0001f) y = 0.0001f;  // avoid divide-by-zero on degenerate input

    // xyY -> XYZ with Y = 1.0
    float Y = 1.0f;
    float X = (Y / y) * x;
    float Z = (Y / y) * (1.0f - x - y);

    // XYZ -> linear sRGB (sRGB D65 matrix)
    float r =  3.2406f * X - 1.5372f * Y - 0.4986f * Z;
    float g = -0.9689f * X + 1.8758f * Y + 0.0415f * Z;
    float b =  0.0557f * X - 0.2040f * Y + 1.0570f * Z;

    // Clamp negatives.
    if (r < 0) r = 0;
    if (g < 0) g = 0;
    if (b < 0) b = 0;

    // Normalise so the brightest channel is 1.0 (preserve hue, drop absolute Y).
    float maxc = r;
    if (g > maxc) maxc = g;
    if (b > maxc) maxc = b;
    if (maxc > 0.0001f) { r /= maxc; g /= maxc; b /= maxc; }

    // Gamma (linear -> sRGB ~ pow(.,1/2.2)); cheap approximation via sqrt-ish.
    // A single sqrt gives 1/2.0 which is close enough for an indicator LED.
    r = r > 0 ? __builtin_sqrtf(r) : 0;
    g = g > 0 ? __builtin_sqrtf(g) : 0;
    b = b > 0 ? __builtin_sqrtf(b) : 0;

    s_r = (uint8_t)(r * 255.0f);
    s_g = (uint8_t)(g * 255.0f);
    s_b = (uint8_t)(b * 255.0f);
}

void led_apply(void)
{
    if (s_strip == NULL) return;
    if (!s_on) {
        led_strip_clear(s_strip);
        return;
    }
    // Scale base colour by the Level brightness (0..255).
    uint8_t r = (uint8_t)((uint16_t)s_r * s_level / 255);
    uint8_t g = (uint8_t)((uint16_t)s_g * s_level / 255);
    uint8_t b = (uint8_t)((uint16_t)s_b * s_level / 255);
    led_strip_set_pixel(s_strip, 0, r, g, b);
    led_strip_refresh(s_strip);
}

// Hard-off before deep sleep. NOTE: the WS2812's control IC still draws
// parasitic current from the 3V3 rail even with the pixel dark — desolder it
// (or cut its supply trace) for true µA-class sleep; see docs/HARDWARE.md.
void led_off(void)
{
    if (s_strip == NULL) return;
    led_strip_clear(s_strip);
}

void led_show_status(led_status_t status)
{
    if (s_strip == NULL) return;
    uint8_t r = 0, g = 0, b = 0;
    switch (status) {
        case LED_STATUS_OFF:                                  break;
        case LED_STATUS_BOOT:     r = 40; g = 40; b = 40;     break;  // dim white
        case LED_STATUS_JOINING:  r = 0;  g = 0;  b = 60;     break;  // blue
        case LED_STATUS_JOINED:   r = 0;  g = 60; b = 0;      break;  // green
        case LED_STATUS_ERROR:    r = 80; g = 0;  b = 0;      break;  // red
        case LED_STATUS_IDENTIFY: r = 80; g = 0;  b = 80;     break;  // magenta
    }
    led_strip_set_pixel(s_strip, 0, r, g, b);
    led_strip_refresh(s_strip);
}
