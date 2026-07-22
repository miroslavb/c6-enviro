// sensor.c — BME680 forced-mode measurement via the vendored Bosch BME68x API.
// See sensor.h. Compiled with BME68X_DO_NOT_USE_FPU (integer outputs) — the
// C6 has no hardware FPU and the ZCL encodings are integers anyway.
#include "sensor.h"

#include <string.h>

#include "esp_log.h"
#include "esp_rom_sys.h"
#include "driver/i2c_master.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#include "bme68x.h"

static const char *TAG = "sensor";

#define I2C_TIMEOUT_MS  100
#define I2C_FREQ_HZ     100000   // 100 kHz: relaxed timing, long-wire tolerant

// ---- I2C HAL for the Bosch API ---------------------------------------------
static i2c_master_dev_handle_t s_dev = NULL;

static BME68X_INTF_RET_TYPE hal_read(uint8_t reg, uint8_t *data, uint32_t len, void *intf_ptr)
{
    (void)intf_ptr;
    esp_err_t err = i2c_master_transmit_receive(s_dev, &reg, 1, data, len, I2C_TIMEOUT_MS);
    return err == ESP_OK ? BME68X_OK : BME68X_E_COM_FAIL;
}

static BME68X_INTF_RET_TYPE hal_write(uint8_t reg, const uint8_t *data, uint32_t len, void *intf_ptr)
{
    (void)intf_ptr;
    uint8_t buf[1 + 16];
    if (len > sizeof(buf) - 1) return BME68X_E_COM_FAIL;
    buf[0] = reg;
    memcpy(&buf[1], data, len);
    esp_err_t err = i2c_master_transmit(s_dev, buf, 1 + len, I2C_TIMEOUT_MS);
    return err == ESP_OK ? BME68X_OK : BME68X_E_COM_FAIL;
}

static void hal_delay_us(uint32_t us, void *intf_ptr)
{
    (void)intf_ptr;
    if (us >= 2000) {
        vTaskDelay(pdMS_TO_TICKS((us + 999) / 1000)); // long waits: yield
    } else {
        esp_rom_delay_us(us);
    }
}

// ---- Public entry point ------------------------------------------------------

esp_err_t sensor_measure(bool with_gas, sensor_reading_t *out)
{
    esp_err_t ret = ESP_FAIL;
    i2c_master_bus_handle_t bus = NULL;

    const i2c_master_bus_config_t bus_cfg = {
        .i2c_port = -1,   // auto-select
        .sda_io_num = CONFIG_ENVIRO_I2C_SDA_GPIO,
        .scl_io_num = CONFIG_ENVIRO_I2C_SCL_GPIO,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true, // breakout has its own pull-ups; belt & braces
    };
    if (i2c_new_master_bus(&bus_cfg, &bus) != ESP_OK) {
        ESP_LOGE(TAG, "I2C bus init failed (SDA=%d SCL=%d)",
                 CONFIG_ENVIRO_I2C_SDA_GPIO, CONFIG_ENVIRO_I2C_SCL_GPIO);
        return ESP_FAIL;
    }

    // Probe 0x76 (GY-BME680 default, SDO->GND) then 0x77 (SDO->VDD).
    const uint8_t addrs[] = {0x76, 0x77};
    uint8_t addr = 0;
    for (unsigned i = 0; i < sizeof(addrs); i++) {
        if (i2c_master_probe(bus, addrs[i], I2C_TIMEOUT_MS) == ESP_OK) {
            addr = addrs[i];
            break;
        }
    }
    if (addr == 0) {
        ESP_LOGE(TAG, "BME680 not found at 0x76/0x77 — check wiring");
        goto out_bus;
    }

    const i2c_device_config_t dev_cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = addr,
        .scl_speed_hz = I2C_FREQ_HZ,
    };
    if (i2c_master_bus_add_device(bus, &dev_cfg, &s_dev) != ESP_OK) goto out_bus;

    // ---- Bosch API: init + one forced T/P/H(+gas) conversion ----
    struct bme68x_dev dev = {
        .intf     = BME68X_I2C_INTF,
        .read     = hal_read,
        .write    = hal_write,
        .delay_us = hal_delay_us,
        .intf_ptr = NULL,
        .amb_temp = 25,
    };
    int8_t rc = bme68x_init(&dev);
    if (rc != BME68X_OK) {
        ESP_LOGE(TAG, "bme68x_init failed (%d) at 0x%02X", rc, addr);
        goto out_dev;
    }
    // v0.1.1 field diagnosis: genuine BME680/688 parts NEVER have zero T-calib
    // words (factory NVM). All-zero calib => T/H/P compensate to exactly 0 and
    // the heater setpoint is garbage (heater_unstable forever) while gas ADC
    // still returns plausible ohms — seen live 2026-07-23. Retry the init once
    // (covers slow NVM copy after power-up); if still zero, scream.
    if (dev.calib.par_t1 == 0 && dev.calib.par_t2 == 0) {
        ESP_LOGW(TAG, "calib reads zero (par_t1=par_t2=0) — re-initialising");
        hal_delay_us(50000, NULL);
        rc = bme68x_init(&dev);
        if (rc != BME68X_OK) {
            ESP_LOGE(TAG, "bme68x re-init failed (%d)", rc);
            goto out_dev;
        }
    }
    ESP_LOGI(TAG, "calib: par_t1=%u par_t2=%d par_h1=%u par_p1=%u variant=%u",
             (unsigned)dev.calib.par_t1, (int)dev.calib.par_t2,
             (unsigned)dev.calib.par_h1, (unsigned)dev.calib.par_p1,
             (unsigned)dev.variant_id);
    if (dev.calib.par_t1 == 0 && dev.calib.par_t2 == 0) {
        ESP_LOGE(TAG, "CALIBRATION STILL ZERO — T/RH/P will read 0.00; "
                      "suspect counterfeit sensor or wiring; gas ohms unreliable");
    }

    struct bme68x_conf conf = {
        .os_hum  = BME68X_OS_2X,
        .os_temp = BME68X_OS_2X,
        .os_pres = BME68X_OS_4X,
        .filter  = BME68X_FILTER_OFF,  // fresh conversion each deep-sleep wake
        .odr     = BME68X_ODR_NONE,
    };
    rc = bme68x_set_conf(&conf, &dev);
    if (rc != BME68X_OK) goto out_rc;

    struct bme68x_heatr_conf heatr = {
        .enable     = with_gas ? BME68X_ENABLE : BME68X_DISABLE,
        .heatr_temp = CONFIG_ENVIRO_GAS_HEATER_TEMP_C,
        .heatr_dur  = CONFIG_ENVIRO_GAS_HEATER_DUR_MS,
    };
    rc = bme68x_set_heatr_conf(BME68X_FORCED_MODE, &heatr, &dev);
    if (rc != BME68X_OK) goto out_rc;

    rc = bme68x_set_op_mode(BME68X_FORCED_MODE, &dev);
    if (rc != BME68X_OK) goto out_rc;

    // TPH conversion time + heater dwell, then read.
    uint32_t wait_us = bme68x_get_meas_dur(BME68X_FORCED_MODE, &conf, &dev);
    if (with_gas) wait_us += (uint32_t)heatr.heatr_dur * 1000u;
    hal_delay_us(wait_us + 5000, NULL);

    struct bme68x_data data;
    uint8_t n = 0;
    rc = bme68x_get_data(BME68X_FORCED_MODE, &data, &n, &dev);
    if (rc != BME68X_OK || n == 0) {
        ESP_LOGE(TAG, "bme68x_get_data failed (rc=%d n=%u)", rc, n);
        goto out_dev;
    }

    out->temp_c100     = data.temperature;            // already °C × 100 (int mode)
    out->hum_c100      = data.humidity / 10;          // % × 1000 → % × 100
    out->press_pa      = data.pressure;               // Pa
    out->gas_valid     = with_gas && (data.status & BME68X_GASM_VALID_MSK) != 0;
    out->heater_stable = with_gas && (data.status & BME68X_HEAT_STAB_MSK) != 0;
    out->gas_ohm       = out->gas_valid ? data.gas_resistance : 0;

    ESP_LOGI(TAG, "BME680@0x%02X: T=%d.%02u°C RH=%u.%02u%% P=%upa gas=%uΩ%s",
             addr,
             (int)(out->temp_c100 / 100), (unsigned)(out->temp_c100 < 0 ? (-out->temp_c100) % 100 : out->temp_c100 % 100),
             (unsigned)(out->hum_c100 / 100), (unsigned)(out->hum_c100 % 100),
             (unsigned)out->press_pa, (unsigned)out->gas_ohm,
             out->gas_valid ? (out->heater_stable ? "" : " (heater unstable)") : " (no gas)");
    ret = ESP_OK;
    goto out_dev;

out_rc:
    ESP_LOGE(TAG, "bme68x configure failed (%d)", rc);
out_dev:
    if (s_dev) { i2c_master_bus_rm_device(s_dev); s_dev = NULL; }
out_bus:
    i2c_del_master_bus(bus);
    return ret;
}
