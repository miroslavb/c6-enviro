// zb_device.c — sleepy Zigbee END DEVICE brain (enviro edition).
//
// Inherits every on-hardware lesson from the sibling c6-radiometer (router):
//   * UP telemetry rides STANDARD clusters only — the Z2M addon cannot decode
//     incoming custom-cluster frames (proven live 2026-07-11). Standard
//     Temperature/Humidity/Pressure/PowerConfig on EP1 + one genAnalogInput
//     endpoint per extra channel (gas Ω, vbat mV, status flags, wake count).
//   * NO manual esp_zb_zcl_report_attr_cmd_req — across five variants on this
//     hardware+lib a manual report never emitted a frame (and correlated with
//     reboot loops). The STACK reporting engine (update_reporting_info slots +
//     self-binding to the coordinator) is the one proven transmit path.
//   * TX power 20 dBm — the stack default is low; ZDO replies barely made it
//     back to the coordinator (asymmetric link, interview timeouts).
//   * Primary channel = the home coordinator's channel 11 for a fast quiet
//     join; secondary = all channels.
//   * ONE guarded steering retry chain; LEAVE during commissioning is cleanup
//     of a failed attempt and must NOT spawn another chain.
//   * zb_storage NVS partition: subtype must be `nvs` and is initialised
//     defensively (a corrupted partition is erased, not abort()ed on).
//
// New for the sleepy end device:
//   * role = ESP_ZB_DEVICE_TYPE_ED with rx_on_when_idle = false, keep_alive
//     1 s (each short wake also picks up queued HA writes), ed_timeout 64 min.
//   * After deep sleep the stack restores the network from zb_storage NVRAM —
//     the DEVICE_REBOOT signal arrives with the network up, no steering.
//   * The wake cycle is sequenced by events back to main.c, which owns the
//     deep-sleep decision (see zb_device.h).
//
// ALL IDs/types/defaults come from zb_contract.h — never hardcoded here.
#include "zb_device.h"

#include <string.h>

#include "esp_zigbee_core.h"
#include "esp_check.h"
#include "esp_log.h"
#include "nvs_flash.h"

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "zb_contract.h"
#include "app_config.h"
#include "cycle.h"
#include "led.h"
#include "version.h"

static const char *TAG = "zb_device";

// ---- Endpoint / profile ----
#define HA_ENDPOINT                  1
#define ESP_ZB_PRIMARY_CHANNEL_MASK  ESP_ZB_TRANSCEIVER_ALL_CHANNELS_MASK
#define INSTALLCODE_POLICY_ENABLE    false
// Keep-alive (parent poll period) while awake, ms. 1 s: every 3 s wake cycle
// polls the parent at least twice, so queued HA writes (report_interval_s,
// gas_enabled) reach the device promptly.
#define ED_KEEP_ALIVE_MS             1000
#define STEER_RETRY_MS               5000

static zb_event_cb_t s_event_cb = NULL;
static bool s_joined = false;
static bool s_factory_new_boot = false;

static void emit(zb_event_t evt)
{
    if (s_event_cb) s_event_cb(evt);
}

bool zb_device_joined(void) { return s_joined; }

// ---- Attribute backing store (the stack reads/writes these addresses) ----
// EP1 standard measurement clusters.
static int16_t  s_temp_c100    = 0;            // 0x0402 measuredValue, °C×100
static uint16_t s_hum_c100     = 0;            // 0x0405 measuredValue, %×100
static int16_t  s_press_hpa    = 0;            // 0x0403 measuredValue, hPa (0.1 kPa)
static uint8_t  s_batt_voltage = 0xFF;         // 0x0001/0x0020, 100 mV units
static uint8_t  s_batt_pct     = 0;            // 0x0001/0x0021, 0.5 % units
// Custom cluster (diagnostics, readable; down attrs mirrored).
static uint16_t s_status       = 0;
static uint32_t s_wake_count   = 0;
static uint16_t s_vbat_mv      = 0;
static uint16_t s_awake_ms     = 0;
static float    s_gas_ohm      = 0.0f;
static uint16_t s_interval_s   = DEFAULT_REPORT_INTERVAL_S;
static bool     s_gas_enabled  = DEFAULT_GAS_ENABLED != 0;
// Analog Input presentValue storage (ZCL attribute memory — must be static).
static float    s_ai_value[AI_EP_COUNT] = {0};
static bool     s_ai_oos    = false;
static uint8_t  s_ai_status = 0;
static char     s_ai_desc[AI_EP_COUNT][1 + 24];

// ===========================================================================
// Cluster / endpoint construction
// ===========================================================================
static esp_zb_attribute_list_t *build_custom_cluster(void)
{
    esp_zb_attribute_list_t *cl = esp_zb_zcl_attr_list_create(ENVIRO_CLUSTER_ID);

    // Diagnostics: readable, NOT reported (incoming custom-cluster frames are
    // undecodable in the Z2M addon — reports would only produce log noise).
    const uint8_t ro = ESP_ZB_ZCL_ATTR_ACCESS_READ_ONLY;
    esp_zb_custom_cluster_add_custom_attr(cl, ATTR_STATUS_FLAGS,   ATTRTYPE_STATUS_FLAGS,   ro, &s_status);
    esp_zb_custom_cluster_add_custom_attr(cl, ATTR_WAKE_COUNT,     ATTRTYPE_WAKE_COUNT,     ro, &s_wake_count);
    esp_zb_custom_cluster_add_custom_attr(cl, ATTR_VBAT_MV,        ATTRTYPE_VBAT_MV,        ro, &s_vbat_mv);
    esp_zb_custom_cluster_add_custom_attr(cl, ATTR_AWAKE_MS,       ATTRTYPE_AWAKE_MS,       ro, &s_awake_ms);
    esp_zb_custom_cluster_add_custom_attr(cl, ATTR_GAS_RESISTANCE, ATTRTYPE_GAS_RESISTANCE, ro, &s_gas_ohm);

    // Config: coordinator writes → READ | WRITE. Persisted to NVS on write.
    const uint8_t rw = ESP_ZB_ZCL_ATTR_ACCESS_READ_WRITE;
    esp_zb_custom_cluster_add_custom_attr(cl, ATTR_REPORT_INTERVAL_S, ATTRTYPE_REPORT_INTERVAL_S, rw, &s_interval_s);
    esp_zb_custom_cluster_add_custom_attr(cl, ATTR_GAS_ENABLED,       ATTRTYPE_GAS_ENABLED,       rw, &s_gas_enabled);

    return cl;
}

static esp_zb_ep_list_t *build_endpoint(void)
{
    esp_zb_ep_list_t *ep_list = esp_zb_ep_list_create();

    // ---- EP1: Basic + Identify + PowerConfig + T/H/P + custom config ----
    esp_zb_cluster_list_t *clusters = esp_zb_zcl_cluster_list_create();

    // Basic identity from the contract (so Z2M matches the converter).
    esp_zb_basic_cluster_cfg_t basic_cfg = {
        .zcl_version  = ESP_ZB_ZCL_BASIC_ZCL_VERSION_DEFAULT_VALUE,
        .power_source = ZB_POWER_SOURCE,          // 0x03 = battery
    };
    esp_zb_attribute_list_t *basic = esp_zb_basic_cluster_create(&basic_cfg);
    static char mfr[1 + sizeof(ZB_MANUF_NAME)] = {0};
    static char mdl[1 + sizeof(ZB_MODEL_ID)]  = {0};
    static char swb[1 + sizeof(FW_VERSION)]   = {0};
    mfr[0] = (char)strlen(ZB_MANUF_NAME); memcpy(&mfr[1], ZB_MANUF_NAME, strlen(ZB_MANUF_NAME));
    mdl[0] = (char)strlen(ZB_MODEL_ID);   memcpy(&mdl[1], ZB_MODEL_ID, strlen(ZB_MODEL_ID));
    swb[0] = (char)strlen(FW_VERSION);    memcpy(&swb[1], FW_VERSION, strlen(FW_VERSION));
    esp_zb_basic_cluster_add_attr(basic, ESP_ZB_ZCL_ATTR_BASIC_MANUFACTURER_NAME_ID, mfr);
    esp_zb_basic_cluster_add_attr(basic, ESP_ZB_ZCL_ATTR_BASIC_MODEL_IDENTIFIER_ID, mdl);
    esp_zb_basic_cluster_add_attr(basic, ESP_ZB_ZCL_ATTR_BASIC_SW_BUILD_ID, swb);
    esp_zb_cluster_list_add_basic_cluster(clusters, basic, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);

    esp_zb_identify_cluster_cfg_t ident_cfg = { .identify_time = 0 };
    esp_zb_cluster_list_add_identify_cluster(clusters,
        esp_zb_identify_cluster_create(&ident_cfg), ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);

    // Power Configuration: batteryVoltage (100 mV) + batteryPercentageRemaining
    // (0.5 %), both REPORTING so the stack engine can transmit them.
    esp_zb_attribute_list_t *power =
        esp_zb_zcl_attr_list_create(ESP_ZB_ZCL_CLUSTER_ID_POWER_CONFIG);
    esp_zb_custom_cluster_add_custom_attr(power,
        ESP_ZB_ZCL_ATTR_POWER_CONFIG_BATTERY_VOLTAGE_ID,
        ESP_ZB_ZCL_ATTR_TYPE_U8,
        ESP_ZB_ZCL_ATTR_ACCESS_READ_ONLY | ESP_ZB_ZCL_ATTR_ACCESS_REPORTING,
        &s_batt_voltage);
    esp_zb_custom_cluster_add_custom_attr(power,
        ESP_ZB_ZCL_ATTR_POWER_CONFIG_BATTERY_PERCENTAGE_REMAINING_ID,
        ESP_ZB_ZCL_ATTR_TYPE_U8,
        ESP_ZB_ZCL_ATTR_ACCESS_READ_ONLY | ESP_ZB_ZCL_ATTR_ACCESS_REPORTING,
        &s_batt_pct);
    esp_zb_cluster_list_add_power_config_cluster(clusters, power, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);

    // Temperature / Humidity / Pressure measurement clusters. Hand-built attr
    // lists (same mechanism as the AI endpoints) so measuredValue provably
    // carries the REPORTING access flag — the proven transmit path.
    esp_zb_attribute_list_t *temp =
        esp_zb_zcl_attr_list_create(ESP_ZB_ZCL_CLUSTER_ID_TEMP_MEASUREMENT);
    static int16_t temp_min = -4000, temp_max = 8500;  // -40..85 °C ×100
    esp_zb_custom_cluster_add_custom_attr(temp,
        ESP_ZB_ZCL_ATTR_TEMP_MEASUREMENT_VALUE_ID, ESP_ZB_ZCL_ATTR_TYPE_S16,
        ESP_ZB_ZCL_ATTR_ACCESS_READ_ONLY | ESP_ZB_ZCL_ATTR_ACCESS_REPORTING, &s_temp_c100);
    esp_zb_custom_cluster_add_custom_attr(temp,
        ESP_ZB_ZCL_ATTR_TEMP_MEASUREMENT_MIN_VALUE_ID, ESP_ZB_ZCL_ATTR_TYPE_S16,
        ESP_ZB_ZCL_ATTR_ACCESS_READ_ONLY, &temp_min);
    esp_zb_custom_cluster_add_custom_attr(temp,
        ESP_ZB_ZCL_ATTR_TEMP_MEASUREMENT_MAX_VALUE_ID, ESP_ZB_ZCL_ATTR_TYPE_S16,
        ESP_ZB_ZCL_ATTR_ACCESS_READ_ONLY, &temp_max);
    esp_zb_cluster_list_add_temperature_meas_cluster(clusters, temp, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);

    esp_zb_attribute_list_t *hum =
        esp_zb_zcl_attr_list_create(ESP_ZB_ZCL_CLUSTER_ID_REL_HUMIDITY_MEASUREMENT);
    static uint16_t hum_min = 0, hum_max = 10000;      // 0..100 % ×100
    esp_zb_custom_cluster_add_custom_attr(hum,
        ESP_ZB_ZCL_ATTR_REL_HUMIDITY_MEASUREMENT_VALUE_ID, ESP_ZB_ZCL_ATTR_TYPE_U16,
        ESP_ZB_ZCL_ATTR_ACCESS_READ_ONLY | ESP_ZB_ZCL_ATTR_ACCESS_REPORTING, &s_hum_c100);
    esp_zb_custom_cluster_add_custom_attr(hum,
        ESP_ZB_ZCL_ATTR_REL_HUMIDITY_MEASUREMENT_MIN_VALUE_ID, ESP_ZB_ZCL_ATTR_TYPE_U16,
        ESP_ZB_ZCL_ATTR_ACCESS_READ_ONLY, &hum_min);
    esp_zb_custom_cluster_add_custom_attr(hum,
        ESP_ZB_ZCL_ATTR_REL_HUMIDITY_MEASUREMENT_MAX_VALUE_ID, ESP_ZB_ZCL_ATTR_TYPE_U16,
        ESP_ZB_ZCL_ATTR_ACCESS_READ_ONLY, &hum_max);
    esp_zb_cluster_list_add_humidity_meas_cluster(clusters, hum, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);

    esp_zb_attribute_list_t *press =
        esp_zb_zcl_attr_list_create(ESP_ZB_ZCL_CLUSTER_ID_PRESSURE_MEASUREMENT);
    static int16_t press_min = 300, press_max = 1100;  // hPa
    esp_zb_custom_cluster_add_custom_attr(press,
        ESP_ZB_ZCL_ATTR_PRESSURE_MEASUREMENT_VALUE_ID, ESP_ZB_ZCL_ATTR_TYPE_S16,
        ESP_ZB_ZCL_ATTR_ACCESS_READ_ONLY | ESP_ZB_ZCL_ATTR_ACCESS_REPORTING, &s_press_hpa);
    esp_zb_custom_cluster_add_custom_attr(press,
        ESP_ZB_ZCL_ATTR_PRESSURE_MEASUREMENT_MIN_VALUE_ID, ESP_ZB_ZCL_ATTR_TYPE_S16,
        ESP_ZB_ZCL_ATTR_ACCESS_READ_ONLY, &press_min);
    esp_zb_custom_cluster_add_custom_attr(press,
        ESP_ZB_ZCL_ATTR_PRESSURE_MEASUREMENT_MAX_VALUE_ID, ESP_ZB_ZCL_ATTR_TYPE_S16,
        ESP_ZB_ZCL_ATTR_ACCESS_READ_ONLY, &press_max);
    esp_zb_cluster_list_add_pressure_meas_cluster(clusters, press, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);

    // Custom enviro cluster (config writes + diagnostics reads).
    esp_zb_cluster_list_add_custom_cluster(clusters, build_custom_cluster(),
                                           ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);

    esp_zb_endpoint_config_t ep_cfg = {
        .endpoint           = HA_ENDPOINT,
        .app_profile_id     = ESP_ZB_AF_HA_PROFILE_ID,
        .app_device_id      = ESP_ZB_HA_TEMPERATURE_SENSOR_DEVICE_ID,
        .app_device_version = 0,
    };
    esp_zb_ep_list_add_ep(ep_list, clusters, ep_cfg);

    // ---- EP2..EP5: standard Analog Input channels ----
    static const struct { uint8_t ep; const char *desc; } AI_CHANNELS[] = AI_CHANNELS_INIT;
    for (size_t i = 0; i < AI_EP_COUNT; i++) {
        esp_zb_attribute_list_t *ai =
            esp_zb_zcl_attr_list_create(ESP_ZB_ZCL_CLUSTER_ID_ANALOG_INPUT);
        esp_zb_custom_cluster_add_custom_attr(ai,
            ESP_ZB_ZCL_ATTR_ANALOG_INPUT_OUT_OF_SERVICE_ID,
            ESP_ZB_ZCL_ATTR_TYPE_BOOL,
            ESP_ZB_ZCL_ATTR_ACCESS_READ_ONLY, &s_ai_oos);
        esp_zb_custom_cluster_add_custom_attr(ai,
            ESP_ZB_ZCL_ATTR_ANALOG_INPUT_PRESENT_VALUE_ID,
            ESP_ZB_ZCL_ATTR_TYPE_SINGLE,
            ESP_ZB_ZCL_ATTR_ACCESS_READ_ONLY | ESP_ZB_ZCL_ATTR_ACCESS_REPORTING,
            &s_ai_value[i]);
        esp_zb_custom_cluster_add_custom_attr(ai,
            ESP_ZB_ZCL_ATTR_ANALOG_INPUT_STATUS_FLAGS_ID,
            ESP_ZB_ZCL_ATTR_TYPE_8BITMAP,
            ESP_ZB_ZCL_ATTR_ACCESS_READ_ONLY, &s_ai_status);

        size_t dl = strlen(AI_CHANNELS[i].desc);
        if (dl > 24) dl = 24;
        s_ai_desc[i][0] = (char)dl;
        memcpy(&s_ai_desc[i][1], AI_CHANNELS[i].desc, dl);
        esp_zb_custom_cluster_add_custom_attr(ai,
            ESP_ZB_ZCL_ATTR_ANALOG_INPUT_DESCRIPTION_ID,
            ESP_ZB_ZCL_ATTR_TYPE_CHAR_STRING,
            ESP_ZB_ZCL_ATTR_ACCESS_READ_ONLY, s_ai_desc[i]);

        esp_zb_cluster_list_t *ai_clusters = esp_zb_zcl_cluster_list_create();
        esp_zb_cluster_list_add_analog_input_cluster(ai_clusters, ai,
                                                     ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);
        esp_zb_endpoint_config_t ai_ep_cfg = {
            .endpoint           = AI_CHANNELS[i].ep,
            .app_profile_id     = ESP_ZB_AF_HA_PROFILE_ID,
            .app_device_id      = ESP_ZB_HA_SIMPLE_SENSOR_DEVICE_ID,
            .app_device_version = 0,
        };
        esp_zb_ep_list_add_ep(ep_list, ai_clusters, ai_ep_cfg);
    }
    return ep_list;
}

// ===========================================================================
// Device-side binding + stack reporting configuration
// ===========================================================================
// The one transmit path proven on this hardware+lib: bind each reported
// cluster to the coordinator, register stack reporting slots, mirror values
// into the attribute store — the STACK emits the attributeReport frames.
// min_interval = 0 → an attribute change reports immediately (crucial for the
// 3 s deep-sleep cadence: the report must go out inside the flush window).
typedef struct { uint8_t ep; uint16_t cluster; uint16_t attr; bool analog; } rep_slot_t;
static const rep_slot_t REPORT_SLOTS[] = {
    { HA_ENDPOINT, ESP_ZB_ZCL_CLUSTER_ID_TEMP_MEASUREMENT,
      ESP_ZB_ZCL_ATTR_TEMP_MEASUREMENT_VALUE_ID, false },
    { HA_ENDPOINT, ESP_ZB_ZCL_CLUSTER_ID_REL_HUMIDITY_MEASUREMENT,
      ESP_ZB_ZCL_ATTR_REL_HUMIDITY_MEASUREMENT_VALUE_ID, false },
    { HA_ENDPOINT, ESP_ZB_ZCL_CLUSTER_ID_PRESSURE_MEASUREMENT,
      ESP_ZB_ZCL_ATTR_PRESSURE_MEASUREMENT_VALUE_ID, false },
    // NOTE: batteryVoltage (0x0020) is NOT in this table — the stack refuses
    // reporting on it (esp-zigbee-sdk issue #463); it stays readable, and the
    // precise vbat rides the AI_EP_VBAT_MV channel below anyway.
    { HA_ENDPOINT, ESP_ZB_ZCL_CLUSTER_ID_POWER_CONFIG,
      ESP_ZB_ZCL_ATTR_POWER_CONFIG_BATTERY_PERCENTAGE_REMAINING_ID, false },
    { AI_EP_GAS_RESISTANCE, ESP_ZB_ZCL_CLUSTER_ID_ANALOG_INPUT,
      ESP_ZB_ZCL_ATTR_ANALOG_INPUT_PRESENT_VALUE_ID, true },
    { AI_EP_VBAT_MV, ESP_ZB_ZCL_CLUSTER_ID_ANALOG_INPUT,
      ESP_ZB_ZCL_ATTR_ANALOG_INPUT_PRESENT_VALUE_ID, true },
    { AI_EP_STATUS_FLAGS, ESP_ZB_ZCL_CLUSTER_ID_ANALOG_INPUT,
      ESP_ZB_ZCL_ATTR_ANALOG_INPUT_PRESENT_VALUE_ID, true },
    { AI_EP_WAKE_COUNT, ESP_ZB_ZCL_CLUSTER_ID_ANALOG_INPUT,
      ESP_ZB_ZCL_ATTR_ANALOG_INPUT_PRESENT_VALUE_ID, true },
    // v0.1.2: T/RH/P mirrors — live pairing 2026-07-23 showed the standard
    // measurement-cluster values never reaching HA while every AI channel did.
    { AI_EP_TEMP_C, ESP_ZB_ZCL_CLUSTER_ID_ANALOG_INPUT,
      ESP_ZB_ZCL_ATTR_ANALOG_INPUT_PRESENT_VALUE_ID, true },
    { AI_EP_HUMIDITY_PCT, ESP_ZB_ZCL_CLUSTER_ID_ANALOG_INPUT,
      ESP_ZB_ZCL_ATTR_ANALOG_INPUT_PRESENT_VALUE_ID, true },
    { AI_EP_PRESSURE_KPA, ESP_ZB_ZCL_CLUSTER_ID_ANALOG_INPUT,
      ESP_ZB_ZCL_ATTR_ANALOG_INPUT_PRESENT_VALUE_ID, true },
};
#define REPORT_SLOT_COUNT (sizeof(REPORT_SLOTS) / sizeof(REPORT_SLOTS[0]))

static void bind_done_cb(esp_zb_zdp_status_t status, void *user_ctx)
{
    ESP_LOGD(TAG, "self-bind EP%u: %s", (unsigned)(uintptr_t)user_ctx,
             status == ESP_ZB_ZDP_STATUS_SUCCESS ? "OK" : "FAILED");
}

static void setup_self_reporting(void)
{
    esp_zb_ieee_addr_t tc_addr;
    esp_zb_aps_get_trust_center_address(tc_addr);

    for (size_t i = 0; i < REPORT_SLOT_COUNT; i++) {
        const rep_slot_t *s = &REPORT_SLOTS[i];

        // 1. Bind the cluster to the coordinator so the reporting engine has a
        //    destination. ZBOSS dedups identical entries; runs locally.
        esp_zb_zdo_bind_req_param_t bind = {0};
        esp_zb_get_long_address(bind.src_address);
        bind.src_endp      = s->ep;
        bind.cluster_id    = s->cluster;
        bind.dst_addr_mode = ESP_ZB_ZDO_BIND_DST_ADDR_MODE_64_BIT_EXTENDED;
        memcpy(bind.dst_address_u.addr_long, tc_addr, sizeof(esp_zb_ieee_addr_t));
        bind.dst_endp      = 1;                          // Z2M coordinator EP1
        bind.req_dst_addr  = esp_zb_get_short_address(); // process locally
        esp_zb_zdo_device_bind_req(&bind, bind_done_cb, (void *)(uintptr_t)s->ep);

        // 2. Stack-level reporting slot. min 0 = report immediately on change;
        //    max = heartbeat backstop while awake (the device usually sleeps
        //    long before it fires).
        esp_zb_zcl_reporting_info_t info = {0};
        info.direction    = ESP_ZB_ZCL_REPORT_DIRECTION_SEND;
        info.ep           = s->ep;
        info.cluster_id   = s->cluster;
        info.cluster_role = ESP_ZB_ZCL_CLUSTER_SERVER_ROLE;
        info.attr_id      = s->attr;
        info.u.send_info.min_interval     = 0;
        info.u.send_info.max_interval     = 3600;
        info.u.send_info.def_min_interval = 0;
        info.u.send_info.def_max_interval = 3600;
        if (s->analog) info.u.send_info.delta.f32 = 0.0f;  // any change
        else           info.u.send_info.delta.u16 = 0;
        info.dst.short_addr = 0x0000;                    // coordinator
        info.dst.endpoint   = 1;
        info.dst.profile_id = ESP_ZB_AF_HA_PROFILE_ID;
        info.manuf_code     = 0;                         // standard ZCL
        esp_err_t err = esp_zb_zcl_update_reporting_info(&info);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "reporting info EP%u cl 0x%04X attr 0x%04X: %s",
                     s->ep, s->cluster, s->attr, esp_err_to_name(err));
        }
    }
    ESP_LOGI(TAG, "device-side reporting configured (%u slots)", (unsigned)REPORT_SLOT_COUNT);
}

// ===========================================================================
// Measurement push (runs on the stack task via the Zigbee scheduler)
// ===========================================================================
static void set_ai_present_value(uint8_t ep, float value)
{
    esp_zb_zcl_set_attribute_val(ep, ESP_ZB_ZCL_CLUSTER_ID_ANALOG_INPUT,
                                 ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,
                                 ESP_ZB_ZCL_ATTR_ANALOG_INPUT_PRESENT_VALUE_ID,
                                 &value, false);
}

static void flush_done_cb(uint8_t param)
{
    (void)param;
    emit(ZB_EVT_REPORT_FLUSHED);
}

static void push_cb(uint8_t param)
{
    (void)param;
    const enviro_measurement_t *m = &g_measurement;

    // ---- EP1 standard clusters ----
    // v0.1.2: capture + log every set status — the field mystery is WHY these
    // values never reach HA while the AI channels do.
    esp_zb_zcl_status_t zst;
    if (m->sensor_ok) {
        s_temp_c100 = (int16_t)m->temp_c100;
        s_hum_c100  = (uint16_t)m->hum_c100;
        s_press_hpa = (int16_t)((m->press_pa + 50) / 100);   // Pa → hPa (0.1 kPa)
        zst = esp_zb_zcl_set_attribute_val(HA_ENDPOINT, ESP_ZB_ZCL_CLUSTER_ID_TEMP_MEASUREMENT,
            ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,
            ESP_ZB_ZCL_ATTR_TEMP_MEASUREMENT_VALUE_ID, &s_temp_c100, false);
        if (zst != ESP_ZB_ZCL_STATUS_SUCCESS) ESP_LOGW(TAG, "set temp(0x0402)=%d -> zcl status 0x%02x", s_temp_c100, zst);
        zst = esp_zb_zcl_set_attribute_val(HA_ENDPOINT, ESP_ZB_ZCL_CLUSTER_ID_REL_HUMIDITY_MEASUREMENT,
            ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,
            ESP_ZB_ZCL_ATTR_REL_HUMIDITY_MEASUREMENT_VALUE_ID, &s_hum_c100, false);
        if (zst != ESP_ZB_ZCL_STATUS_SUCCESS) ESP_LOGW(TAG, "set hum(0x0405)=%u -> zcl status 0x%02x", s_hum_c100, zst);
        zst = esp_zb_zcl_set_attribute_val(HA_ENDPOINT, ESP_ZB_ZCL_CLUSTER_ID_PRESSURE_MEASUREMENT,
            ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,
            ESP_ZB_ZCL_ATTR_PRESSURE_MEASUREMENT_VALUE_ID, &s_press_hpa, false);
        if (zst != ESP_ZB_ZCL_STATUS_SUCCESS) ESP_LOGW(TAG, "set press(0x0403)=%d -> zcl status 0x%02x", s_press_hpa, zst);
    }
    if (m->vbat_ok) {
        s_batt_voltage = cycle_battery_voltage_zcl(m->vbat_mv);
        s_batt_pct     = cycle_battery_percent_zcl(m->vbat_mv);
        zst = esp_zb_zcl_set_attribute_val(HA_ENDPOINT, ESP_ZB_ZCL_CLUSTER_ID_POWER_CONFIG,
            ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,
            ESP_ZB_ZCL_ATTR_POWER_CONFIG_BATTERY_VOLTAGE_ID, &s_batt_voltage, false);
        if (zst != ESP_ZB_ZCL_STATUS_SUCCESS) ESP_LOGW(TAG, "set batt V -> zcl status 0x%02x", zst);
        zst = esp_zb_zcl_set_attribute_val(HA_ENDPOINT, ESP_ZB_ZCL_CLUSTER_ID_POWER_CONFIG,
            ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,
            ESP_ZB_ZCL_ATTR_POWER_CONFIG_BATTERY_PERCENTAGE_REMAINING_ID, &s_batt_pct, false);
        if (zst != ESP_ZB_ZCL_STATUS_SUCCESS) ESP_LOGW(TAG, "set batt %% -> zcl status 0x%02x", zst);
    }

    // ---- Status bitmask + custom diagnostics ----
    const cycle_status_t st = {
        .sensor_error    = !m->sensor_ok,
        .heater_unstable = m->sensor_ok && g_config.gas_enabled && !m->heater_stable,
        .battery_low     = m->vbat_ok && m->vbat_mv < BATTERY_LOW_MV,
        .vbat_invalid    = !m->vbat_ok,
        .gas_disabled    = !g_config.gas_enabled,
        .first_boot      = m->first_boot,
    };
    s_status = cycle_status_flags(&st,
        ST_BIT_SENSOR_ERROR, ST_BIT_HEATER_UNSTABLE, ST_BIT_BATTERY_LOW,
        ST_BIT_VBAT_INVALID, ST_BIT_GAS_DISABLED, ST_BIT_FIRST_BOOT);
    s_wake_count = m->wake_count;
    s_vbat_mv    = m->vbat_mv;
    s_awake_ms   = m->awake_ms;
    s_gas_ohm    = (float)m->gas_ohm;

    esp_zb_zcl_set_attribute_val(HA_ENDPOINT, ENVIRO_CLUSTER_ID, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,
                                 ATTR_STATUS_FLAGS, &s_status, false);
    esp_zb_zcl_set_attribute_val(HA_ENDPOINT, ENVIRO_CLUSTER_ID, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,
                                 ATTR_WAKE_COUNT, &s_wake_count, false);
    esp_zb_zcl_set_attribute_val(HA_ENDPOINT, ENVIRO_CLUSTER_ID, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,
                                 ATTR_VBAT_MV, &s_vbat_mv, false);
    esp_zb_zcl_set_attribute_val(HA_ENDPOINT, ENVIRO_CLUSTER_ID, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,
                                 ATTR_AWAKE_MS, &s_awake_ms, false);

    // ---- Analog Input mirrors (the reported UP-path) ----
    set_ai_present_value(AI_EP_GAS_RESISTANCE, (float)m->gas_ohm);
    set_ai_present_value(AI_EP_VBAT_MV,        (float)m->vbat_mv);
    set_ai_present_value(AI_EP_STATUS_FLAGS,   (float)s_status);
    set_ai_present_value(AI_EP_WAKE_COUNT,     (float)m->wake_count);
    if (m->sensor_ok) {
        // v0.1.2 T/RH/P mirrors, already in human units: °C / % / kPa.
        set_ai_present_value(AI_EP_TEMP_C,       (float)m->temp_c100 / 100.0f);
        set_ai_present_value(AI_EP_HUMIDITY_PCT, (float)m->hum_c100 / 100.0f);
        set_ai_present_value(AI_EP_PRESSURE_KPA, (float)m->press_pa / 1000.0f);
    }

    // Give the stack engine + parent polling a window to move the frames out,
    // then let main decide (sleep / stay awake).
    esp_zb_scheduler_alarm(flush_done_cb, 0, CONFIG_ENVIRO_REPORT_FLUSH_MS);
}

void zb_device_push_measurement(void)
{
    // Marshal onto the Zigbee stack task; 1 ms ≈ "next scheduler iteration".
    esp_zb_scheduler_alarm(push_cb, 0, 1);
}

// ===========================================================================
// SET_ATTR write router (HA config writes)
// ===========================================================================
static esp_err_t handle_set_attr(const esp_zb_zcl_set_attr_value_message_t *m)
{
    if (m == NULL || m->info.status != ESP_ZB_ZCL_STATUS_SUCCESS) return ESP_OK;
    if (m->info.cluster != ENVIRO_CLUSTER_ID) return ESP_OK;

    const uint16_t attr_id = m->attribute.id;
    const void    *val     = m->attribute.data.value;
    if (!val) return ESP_OK;

    bool changed = false;
    if (attr_id == ATTR_REPORT_INTERVAL_S) {
        uint16_t v = cycle_clamp_interval_s(*(uint16_t *)val,
                                            MIN_REPORT_INTERVAL_S, MAX_REPORT_INTERVAL_S);
        s_interval_s = v;
        g_config.report_interval_s = v;
        changed = true;
        ESP_LOGI(TAG, "report interval -> %u s", (unsigned)v);
    } else if (attr_id == ATTR_GAS_ENABLED) {
        bool v = *(bool *)val;
        s_gas_enabled = v;
        g_config.gas_enabled = v;
        changed = true;
        ESP_LOGI(TAG, "gas heater -> %s", v ? "enabled" : "disabled");
    }
    if (changed) app_config_save(&g_config);
    return ESP_OK;
}

static esp_err_t zb_action_handler(esp_zb_core_action_callback_id_t cb_id,
                                   const void *message)
{
    switch (cb_id) {
    case ESP_ZB_CORE_SET_ATTR_VALUE_CB_ID:
        return handle_set_attr((const esp_zb_zcl_set_attr_value_message_t *)message);
    default:
        ESP_LOGD(TAG, "unhandled action cb id 0x%x", cb_id);
        return ESP_OK;
    }
}

// ===========================================================================
// Commissioning / BDB signal handler
// ===========================================================================
// Single guarded steering retry chain — the "great rejoin saga of 2026-07-10"
// fix carried over verbatim: LEAVE after a FAILED association is cleanup, not
// a real leave, and must never spawn a second retry chain.
static bool s_retry_pending = false;

static void bdb_commissioning_cb(uint8_t mode_mask)
{
    esp_zb_bdb_start_top_level_commissioning(mode_mask);
}

static void start_steering(void)
{
    if (s_joined) return;
    esp_zb_bdb_start_top_level_commissioning(ESP_ZB_BDB_MODE_NETWORK_STEERING);
    led_show_status(LED_STATUS_JOINING);
}

static void steering_retry_cb(uint8_t param)
{
    (void)param;
    s_retry_pending = false;
    start_steering();
}

static void schedule_steering_retry(uint32_t delay_ms)
{
    if (s_retry_pending || s_joined) return;
    s_retry_pending = true;
    esp_zb_scheduler_alarm(steering_retry_cb, 0, delay_ms);
}

void esp_zb_app_signal_handler(esp_zb_app_signal_t *signal_struct)
{
    uint32_t *p_sg_p = signal_struct->p_app_signal;
    esp_err_t err_status = signal_struct->esp_err_status;
    esp_zb_app_signal_type_t sig_type = (esp_zb_app_signal_type_t)*p_sg_p;

    switch (sig_type) {
    case ESP_ZB_ZDO_SIGNAL_SKIP_STARTUP:
        ESP_LOGI(TAG, "Zigbee stack initialised");
        esp_zb_bdb_start_top_level_commissioning(ESP_ZB_BDB_MODE_INITIALIZATION);
        break;

    case ESP_ZB_BDB_SIGNAL_DEVICE_FIRST_START:
    case ESP_ZB_BDB_SIGNAL_DEVICE_REBOOT:
        if (err_status == ESP_OK) {
            if (esp_zb_bdb_is_factory_new()) {
                s_factory_new_boot = true;
                ESP_LOGI(TAG, "factory-new → network steering (open permit-join in Z2M)");
                start_steering();
            } else {
                // Deep-sleep wake: network restored from zb_storage NVRAM.
                ESP_LOGI(TAG, "network restored from NVRAM (PAN 0x%04hx ch %d short 0x%04hx)",
                         esp_zb_get_pan_id(), esp_zb_get_current_channel(),
                         esp_zb_get_short_address());
                s_joined = true;
                setup_self_reporting();
                emit(ZB_EVT_JOINED);
            }
        } else {
            ESP_LOGW(TAG, "stack start failed (%s), retry in 1s", esp_err_to_name(err_status));
            led_show_status(LED_STATUS_ERROR);
            esp_zb_scheduler_alarm(bdb_commissioning_cb,
                                   ESP_ZB_BDB_MODE_INITIALIZATION, 1000);
        }
        break;

    case ESP_ZB_BDB_SIGNAL_STEERING:
        if (err_status == ESP_OK) {
            ESP_LOGI(TAG, "JOINED: PAN 0x%04hx ch %d short 0x%04hx",
                     esp_zb_get_pan_id(), esp_zb_get_current_channel(),
                     esp_zb_get_short_address());
            s_joined = true;
            led_show_status(LED_STATUS_JOINED);
            setup_self_reporting();
            emit(s_factory_new_boot ? ZB_EVT_FIRST_JOIN : ZB_EVT_JOINED);
        } else if (!s_joined) {
            ESP_LOGW(TAG, "steering failed (%s), retry in %d ms",
                     esp_err_to_name(err_status), STEER_RETRY_MS);
            schedule_steering_retry(STEER_RETRY_MS);
            emit(ZB_EVT_JOIN_FAILED);   // main tracks the join timeout budget
        } else {
            ESP_LOGD(TAG, "steering result (%s) while joined — ignored",
                     esp_err_to_name(err_status));
        }
        break;

    case ESP_ZB_ZDO_SIGNAL_LEAVE:
        if (s_joined) {
            ESP_LOGW(TAG, "left the network — restarting steering");
            s_joined = false;
            schedule_steering_retry(1000);
            emit(ZB_EVT_LEFT);
        } else {
            ESP_LOGI(TAG, "leave during commissioning — ignored (retry pending)");
        }
        break;

    default:
        ESP_LOGI(TAG, "zb signal 0x%x (%s) status %s",
                 sig_type, esp_zb_zdo_signal_to_string(sig_type),
                 esp_err_to_name(err_status));
        break;
    }
}

// ===========================================================================
// Stack task
// ===========================================================================
static void zb_task(void *arg)
{
    (void)arg;

    esp_zb_platform_config_t platform = {
        .radio_config = { .radio_mode = ZB_RADIO_MODE_NATIVE },
        .host_config  = { .host_connection_mode = ZB_HOST_CONNECTION_MODE_NONE },
    };
    ESP_ERROR_CHECK(esp_zb_platform_config(&platform));

    esp_zb_cfg_t zb_cfg = {
        .esp_zb_role         = ESP_ZB_DEVICE_TYPE_ED,
        .install_code_policy = INSTALLCODE_POLICY_ENABLE,
        .nwk_cfg.zed_cfg     = {
            .ed_timeout = ESP_ZB_ED_AGING_TIMEOUT_64MIN,
            .keep_alive = ED_KEEP_ALIVE_MS,
        },
    };
    esp_zb_init(&zb_cfg);
    // Sleepy end device: the radio is OFF between parent polls, and the parent
    // buffers our downlink traffic. This (not the Basic powerSource byte) is
    // what makes Z2M classify the device as battery/EndDevice.
    esp_zb_set_rx_on_when_idle(false);

    esp_zb_device_register(build_endpoint());
    esp_zb_core_action_handler_register(zb_action_handler);
    // Max TX power — the asymmetric-link lesson (default is low; our replies
    // barely reached the coordinator, interviews timed out).
    esp_zb_set_tx_power(20);
    // Primary = home coordinator channel (11); secondary = everything.
    esp_zb_set_primary_network_channel_set(1u << 11);
    esp_zb_set_secondary_network_channel_set(ESP_ZB_PRIMARY_CHANNEL_MASK);

    ESP_ERROR_CHECK(esp_zb_start(false));
    esp_zb_stack_main_loop();  // never returns
}

esp_err_t zb_device_start(zb_event_cb_t cb)
{
    s_event_cb = cb;

    // zb_storage: esp-zigbee-lib 2.x datasets live in this NVS partition
    // (subtype MUST be nvs — the 1.x-era `fat` subtype makes
    // nvs_open_from_partition fail and esp_zb_init abort()s).
    esp_err_t err = nvs_flash_init_partition("zb_storage");
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGW(TAG, "zb_storage NVS needs erase (%s) — reformatting", esp_err_to_name(err));
        ESP_ERROR_CHECK(nvs_flash_erase_partition("zb_storage"));
        ESP_ERROR_CHECK(nvs_flash_init_partition("zb_storage"));
    } else if (err != ESP_OK) {
        ESP_LOGE(TAG, "zb_storage NVS init failed: %s", esp_err_to_name(err));
        return err;
    }

    // Mirror the persisted config into the ZCL attribute store before the
    // endpoint is registered, so HA reads back the live values.
    s_interval_s  = g_config.report_interval_s;
    s_gas_enabled = g_config.gas_enabled;

    BaseType_t ok = xTaskCreate(zb_task, "zb_main", 8192, NULL, 5, NULL);
    return (ok == pdPASS) ? ESP_OK : ESP_FAIL;
}

void zb_device_factory_reset(void)
{
    ESP_LOGW(TAG, "factory reset: erasing Zigbee NVRAM + reboot");
    esp_zb_factory_reset();
}
