// AUTO-GENERATED from contract/contract.json by contract/codegen.mjs — DO NOT EDIT.
// Regenerate with: node contract/codegen.mjs
#pragma once

#define ZB_CONTRACT_VERSION 2

// ---- Device identity (Basic cluster 0x0000) ----
#define ZB_MANUF_NAME   "Biometal"
#define ZB_MODEL_ID     "C6-ENVIRO"
#define ZB_POWER_SOURCE 0x03  // 0x03 = Battery
#define ZB_MANUF_CODE   0x131B  // Espressif Systems — MUST match converter

// ---- Custom manufacturer cluster (DOWN config writes only) ----
#define ENVIRO_CLUSTER_ID 0xFC00  // biometalEnviro

// ---- Custom-cluster attributes: id / zcl type / min / max / default ----
// statusFlags (up): Sensor + power status bitmask (see statusBits); mirrored on AI EP4
#define ATTR_STATUS_FLAGS      0x0000
#define ATTRTYPE_STATUS_FLAGS  0x21  // ESP_ZB_ZCL_ATTR_TYPE_U16
// wakeCount (up): Deep-sleep wake counter since power-on; increments every cycle, so HA sees one report per wake
#define ATTR_WAKE_COUNT      0x0001
#define ATTRTYPE_WAKE_COUNT  0x23  // ESP_ZB_ZCL_ATTR_TYPE_U32
// vbatMv (up, mV): Battery voltage, millivolts (precise; PowerConfig 0x0020 only has 100 mV steps)
#define ATTR_VBAT_MV      0x0002
#define ATTRTYPE_VBAT_MV  0x21  // ESP_ZB_ZCL_ATTR_TYPE_U16
// awakeMs (up, ms): Duration of the previous wake cycle, ms (deep-sleep duty-cycle diagnostic)
#define ATTR_AWAKE_MS      0x0003
#define ATTRTYPE_AWAKE_MS  0x21  // ESP_ZB_ZCL_ATTR_TYPE_U16
// gasResistance (up, Ω): BME680 gas sensor resistance, ohms (higher = cleaner air); mirrored on AI EP2
#define ATTR_GAS_RESISTANCE      0x0004
#define ATTRTYPE_GAS_RESISTANCE  0x39  // ESP_ZB_ZCL_ATTR_TYPE_SINGLE
// reportIntervalS (down, s): Deep-sleep measurement/report period, seconds (3 s default; raise to 60+ for battery-only operation)
#define ATTR_REPORT_INTERVAL_S      0x0010
#define ATTRTYPE_REPORT_INTERVAL_S  0x21  // ESP_ZB_ZCL_ATTR_TYPE_U16
#define DEFAULT_REPORT_INTERVAL_S   3
#define MIN_REPORT_INTERVAL_S       3
#define MAX_REPORT_INTERVAL_S       3600
// gasEnabled (down): Run the BME680 gas heater each cycle (heater burns ~12 mA for 150 ms; disable to save battery)
#define ATTR_GAS_ENABLED      0x0011
#define ATTRTYPE_GAS_ENABLED  0x10  // ESP_ZB_ZCL_ATTR_TYPE_BOOL
#define DEFAULT_GAS_ENABLED   1

// ---- Sensor + power status bitmask (statusFlags attribute) ----
#define ST_BIT_SENSOR_ERROR   0      // BME680 not detected or measurement failed this cycle
#define ST_FLAG_SENSOR_ERROR  (1u << 0)
#define ST_BIT_HEATER_UNSTABLE   1      // Gas heater did not reach stability — gas_resistance unreliable this cycle
#define ST_FLAG_HEATER_UNSTABLE  (1u << 1)
#define ST_BIT_BATTERY_LOW   2      // Battery below the low-voltage threshold
#define ST_FLAG_BATTERY_LOW  (1u << 2)
#define ST_BIT_VBAT_INVALID   3      // Battery ADC read failed (check the divider wiring)
#define ST_FLAG_VBAT_INVALID  (1u << 3)
#define ST_BIT_GAS_DISABLED   4      // Gas heater disabled via HA (gas_enabled = OFF)
#define ST_FLAG_GAS_DISABLED  (1u << 4)
#define ST_BIT_FIRST_BOOT   5      // This cycle is a cold boot / reset, not a deep-sleep wake
#define ST_FLAG_FIRST_BOOT  (1u << 5)
#define ST_FLAG_COUNT   6

// ---- UP-path: standard Analog Input endpoints (genAnalogInput 0x000C) ----
// One endpoint per non-standard telemetry channel; value reported via
// presentValue (SINGLE). See _upPathNote in contract.json for the WHY
// (the Z2M addon cannot decode incoming custom-cluster frames).
#define AI_EP_GAS_RESISTANCE   2   // gas ohm
#define AI_EP_VBAT_MV   3   // vbat mV
#define AI_EP_STATUS_FLAGS   4   // status flags
#define AI_EP_WAKE_COUNT   5   // wake count
#define AI_EP_FIRST   2
#define AI_EP_LAST    5
#define AI_EP_COUNT   4
// {endpoint, description} rows for cluster-construction loops.
#define AI_CHANNELS_INIT { \
    { AI_EP_GAS_RESISTANCE, "gas ohm" }, \
    { AI_EP_VBAT_MV, "vbat mV" }, \
    { AI_EP_STATUS_FLAGS, "status flags" }, \
    { AI_EP_WAKE_COUNT, "wake count" }, \
}

// ---- Power / commissioning constants ----
#define BATTERY_LOW_MV   3400  // below this -> battery_low status bit
#define AWAKE_WINDOW_S   300  // interview window: first join / BOOT / restored-network cold boot
