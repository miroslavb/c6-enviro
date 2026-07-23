// zb_device.h — sleepy Zigbee end device (ZED) for the C6 enviro sensor.
//
// Lifecycle per wake cycle (see ARCHITECTURE.md):
//   main.c measures (BME680 + battery) into g_measurement, then calls
//   zb_device_start(). The stack restores the network from zb_storage NVRAM
//   (deep-sleep wake) or steers (factory-new). Once on the network the device
//   pushes the snapshot into the ZCL attributes; the STACK reporting engine
//   transmits the changed values; after a flush window zb_device signals main
//   through the callback and main deep-sleeps.
#pragma once

#include <stdbool.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    ZB_EVT_JOINED,          // on the network (fresh join or NVRAM restore)
    ZB_EVT_FIRST_JOIN,      // factory-new join succeeded — hold the awake window
    ZB_EVT_REPORT_FLUSHED,  // attributes set + flush window elapsed — safe to sleep
    ZB_EVT_JOIN_FAILED,     // steering failed / no network — main decides backoff
    ZB_EVT_LEFT,            // coordinator removed us — NVRAM erased, will re-steer
} zb_event_t;

typedef void (*zb_event_cb_t)(zb_event_t evt);

// Start the Zigbee stack task. `cb` is invoked from the stack task context —
// keep handlers short (set event bits, no blocking I/O).
esp_err_t zb_device_start(zb_event_cb_t cb);

// Push the current g_measurement + g_config into the ZCL attribute store and
// arm the flush timer. Safe to call from any task (marshalled onto the stack
// task via the Zigbee scheduler).
void zb_device_push_measurement(void);

// Keep the Zigbee receiver continuously on for a commissioning/re-interview
// window. Safe from any task: marshalled onto the Zigbee stack task. The next
// deep-sleep boot restores the normal sleepy rx_on_when_idle=false policy.
void zb_device_enable_interview_rx(void);

// Erase the Zigbee NVRAM and reboot factory-new (BOOT long-press).
void zb_device_factory_reset(void);

// True once the device is on a network this boot.
bool zb_device_joined(void);

#ifdef __cplusplus
}
#endif
