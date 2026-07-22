// app_config.c — NVS-persisted settings. See app_config.h.
#include "app_config.h"

#include "nvs_flash.h"
#include "nvs.h"
#include "esp_log.h"

#include "zb_contract.h"
#include "cycle.h"

static const char *TAG = "app_config";

#define NS       "enviro"
#define K_INTERVAL "rep_int_s"
#define K_GAS      "gas_en"

enviro_config_t      g_config;
enviro_measurement_t g_measurement;

esp_err_t app_config_load(enviro_config_t *out)
{
    out->report_interval_s = DEFAULT_REPORT_INTERVAL_S;
    out->gas_enabled       = DEFAULT_GAS_ENABLED != 0;

    nvs_handle_t h;
    esp_err_t err = nvs_open(NS, NVS_READONLY, &h);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        ESP_LOGI(TAG, "no saved config — using defaults (%us, gas %d)",
                 out->report_interval_s, out->gas_enabled);
        return ESP_OK;
    }
    if (err != ESP_OK) return err;

    uint16_t iv = out->report_interval_s;
    uint8_t  gas = out->gas_enabled ? 1 : 0;
    if (nvs_get_u16(h, K_INTERVAL, &iv) == ESP_OK) {
        out->report_interval_s =
            cycle_clamp_interval_s(iv, MIN_REPORT_INTERVAL_S, MAX_REPORT_INTERVAL_S);
    }
    if (nvs_get_u8(h, K_GAS, &gas) == ESP_OK) {
        out->gas_enabled = gas != 0;
    }
    nvs_close(h);
    ESP_LOGI(TAG, "config: interval=%us gas=%d", out->report_interval_s, out->gas_enabled);
    return ESP_OK;
}

esp_err_t app_config_save(const enviro_config_t *cfg)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NS, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    err = nvs_set_u16(h, K_INTERVAL, cfg->report_interval_s);
    if (err == ESP_OK) err = nvs_set_u8(h, K_GAS, cfg->gas_enabled ? 1 : 0);
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "config saved: interval=%us gas=%d",
                 cfg->report_interval_s, cfg->gas_enabled);
    }
    return err;
}
