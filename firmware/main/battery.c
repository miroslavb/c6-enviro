// battery.c — ADC1 oneshot battery sense. See battery.h.
#include "battery.h"

#include "esp_log.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "soc/adc_channel.h"
#include "sdkconfig.h"

static const char *TAG = "battery";

// GPIO -> ADC1 channel on the ESP32-C6: GPIOn == ADC1_CHn for n = 0..6.
#define VBAT_GPIO     CONFIG_ENVIRO_VBAT_ADC_GPIO
#define VBAT_CHANNEL  ((adc_channel_t)VBAT_GPIO)
// 12 dB attenuation measures up to ~3.3 V at the pin — covers 4.2 V / 2
// (= 2.1 V) from the divider with margin.
#define VBAT_ATTEN    ADC_ATTEN_DB_12

esp_err_t battery_read_mv(uint16_t *out_mv)
{
    adc_oneshot_unit_handle_t unit = NULL;
    adc_cali_handle_t cali = NULL;
    esp_err_t err;

    const adc_oneshot_unit_init_cfg_t unit_cfg = {
        .unit_id = ADC_UNIT_1,
        .ulp_mode = ADC_ULP_MODE_DISABLE,
    };
    err = adc_oneshot_new_unit(&unit_cfg, &unit);
    if (err != ESP_OK) return err;

    const adc_oneshot_chan_cfg_t chan_cfg = {
        .atten    = VBAT_ATTEN,
        .bitwidth = ADC_BITWIDTH_DEFAULT,
    };
    err = adc_oneshot_config_channel(unit, VBAT_CHANNEL, &chan_cfg);
    if (err != ESP_OK) goto out;

    // The C6 supports the curve-fitting calibration scheme.
    const adc_cali_curve_fitting_config_t cali_cfg = {
        .unit_id  = ADC_UNIT_1,
        .chan     = VBAT_CHANNEL,
        .atten    = VBAT_ATTEN,
        .bitwidth = ADC_BITWIDTH_DEFAULT,
    };
    bool calibrated = adc_cali_create_scheme_curve_fitting(&cali_cfg, &cali) == ESP_OK;
    if (!calibrated) {
        ESP_LOGW(TAG, "no ADC calibration — using raw*3300/4095 fallback");
    }

    // Average N samples (cheap noise filter; the solar manager's switcher
    // puts some ripple on the rail).
    int64_t sum_mv = 0;
    int good = 0;
    for (int i = 0; i < CONFIG_ENVIRO_VBAT_SAMPLES; i++) {
        int raw = 0;
        if (adc_oneshot_read(unit, VBAT_CHANNEL, &raw) != ESP_OK) continue;
        int mv = 0;
        if (calibrated && adc_cali_raw_to_voltage(cali, raw, &mv) == ESP_OK) {
            sum_mv += mv;
        } else {
            sum_mv += (int64_t)raw * 3300 / 4095;
        }
        good++;
    }
    if (good == 0) { err = ESP_FAIL; goto out; }

    const uint32_t pin_mv = (uint32_t)(sum_mv / good);
    const uint32_t bat_mv =
        pin_mv * CONFIG_ENVIRO_VBAT_DIV_NUM / CONFIG_ENVIRO_VBAT_DIV_DEN;
    *out_mv = (uint16_t)(bat_mv > 0xFFFF ? 0xFFFF : bat_mv);
    ESP_LOGI(TAG, "vbat: pin=%umV bat=%umV (%d samples%s)",
             (unsigned)pin_mv, (unsigned)bat_mv, good,
             calibrated ? ", calibrated" : "");
    err = ESP_OK;

out:
    if (cali) adc_cali_delete_scheme_curve_fitting(cali);
    if (unit) adc_oneshot_del_unit(unit);
    return err;
}
