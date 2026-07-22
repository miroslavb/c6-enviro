# Vendored Bosch BME68x Sensor API (BSD-3-Clause, see LICENSE).
# Source: https://github.com/boschsensortec/BME68x_SensorAPI (v4.4.8, 2023-02-07).
# BME68X_DO_NOT_USE_FPU: integer compensation outputs (T °C×100, P Pa, RH %×1000,
# gas Ω) — the C6 has no hardware FPU and the ZCL encodings are integers.
idf_component_register(
    SRCS "bme68x.c"
    INCLUDE_DIRS "."
)
target_compile_definitions(${COMPONENT_LIB} PUBLIC BME68X_DO_NOT_USE_FPU)
