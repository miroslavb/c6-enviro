idf_component_register(
    SRCS
        "main.c"
        "app_config.c"
        "battery.c"
        "buttons.c"
        "cycle.c"
        "led.c"
        "sensor.c"
        "zb_device.c"
    INCLUDE_DIRS "."
    REQUIRES
        nvs_flash
        esp_timer
        esp_adc
        esp_driver_i2c
        bme68x
)
