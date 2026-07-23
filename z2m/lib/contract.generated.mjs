// AUTO-GENERATED from contract/contract.json by contract/codegen.mjs — DO NOT EDIT.
// Regenerate with: node contract/codegen.mjs

export const Zcl_DataType = {
  "BOOLEAN": 16,
  "UINT8": 32,
  "UINT16": 33,
  "UINT32": 35,
  "INT16": 41,
  "ENUM8": 48,
  "SINGLE": 57,
  "CHAR_STR": 66
};

export const CONTRACT = {
  "version": 1,
  "manufacturerCode": 4891,
  "device": {
    "manufacturerName": "Biometal",
    "modelId": "C6-ENVIRO",
    "vendor": "Biometal",
    "description": "ESP32-C6 solar environment sensor: BME680 (T/RH/P/gas) + battery telemetry, deep-sleep Zigbee end device",
    "powerSource": 3,
    "_powerSourceNote": "0x03 = Battery. Solar-charged Li-ion behind the Waveshare Solar Power Manager. Sleepy-end-device role comes from the ZED build + rx_on_when_idle=false, not from this cosmetic field."
  },
  "cluster": {
    "name": "biometalEnviro",
    "id": 64512
  },
  "attributes": [
    {
      "name": "statusFlags",
      "expose": "status_flags",
      "id": 0,
      "type": "UINT16",
      "zclType": 33,
      "dir": "up",
      "unit": null,
      "min": null,
      "max": null,
      "default": null,
      "optional": false,
      "report": false,
      "desc": "Sensor + power status bitmask (see statusBits); mirrored on AI EP4"
    },
    {
      "name": "wakeCount",
      "expose": "wake_count",
      "id": 1,
      "type": "UINT32",
      "zclType": 35,
      "dir": "up",
      "unit": null,
      "min": null,
      "max": null,
      "default": null,
      "optional": false,
      "report": false,
      "desc": "Deep-sleep wake counter since power-on; increments every cycle, so HA sees one report per wake"
    },
    {
      "name": "vbatMv",
      "expose": "vbat_mv",
      "id": 2,
      "type": "UINT16",
      "zclType": 33,
      "dir": "up",
      "unit": "mV",
      "min": null,
      "max": null,
      "default": null,
      "optional": false,
      "report": false,
      "desc": "Battery voltage, millivolts (precise; PowerConfig 0x0020 only has 100 mV steps)"
    },
    {
      "name": "awakeMs",
      "expose": "awake_ms",
      "id": 3,
      "type": "UINT16",
      "zclType": 33,
      "dir": "up",
      "unit": "ms",
      "min": null,
      "max": null,
      "default": null,
      "optional": false,
      "report": false,
      "desc": "Duration of the previous wake cycle, ms (deep-sleep duty-cycle diagnostic)"
    },
    {
      "name": "gasResistance",
      "expose": "gas_resistance",
      "id": 4,
      "type": "SINGLE",
      "zclType": 57,
      "dir": "up",
      "unit": "Ω",
      "min": null,
      "max": null,
      "default": null,
      "optional": false,
      "report": false,
      "desc": "BME680 gas sensor resistance, ohms (higher = cleaner air); mirrored on AI EP2"
    },
    {
      "name": "tempC",
      "expose": "temperature",
      "id": 5,
      "type": "SINGLE",
      "zclType": 57,
      "dir": "up",
      "unit": "°C",
      "min": null,
      "max": null,
      "default": null,
      "optional": false,
      "report": false,
      "desc": "Temperature mirror, °C float (AI EP6 — belt-and-braces beside the standard 0x0402 cluster)"
    },
    {
      "name": "humidityPct",
      "expose": "humidity",
      "id": 6,
      "type": "SINGLE",
      "zclType": 57,
      "dir": "up",
      "unit": "%",
      "min": null,
      "max": null,
      "default": null,
      "optional": false,
      "report": false,
      "desc": "Relative-humidity mirror, %% float (AI EP7 — beside the standard 0x0405 cluster)"
    },
    {
      "name": "pressureKpa",
      "expose": "pressure",
      "id": 7,
      "type": "SINGLE",
      "zclType": 57,
      "dir": "up",
      "unit": "kPa",
      "min": null,
      "max": null,
      "default": null,
      "optional": false,
      "report": false,
      "desc": "Pressure mirror, kPa float (AI EP8 — beside the standard 0x0403 cluster)"
    },
    {
      "name": "reportIntervalS",
      "expose": "report_interval_s",
      "id": 16,
      "type": "UINT16",
      "zclType": 33,
      "dir": "down",
      "unit": "s",
      "min": 3,
      "max": 3600,
      "default": 3,
      "optional": false,
      "report": false,
      "desc": "Deep-sleep measurement/report period, seconds (3 s default; raise to 60+ for battery-only operation)"
    },
    {
      "name": "gasEnabled",
      "expose": "gas_enabled",
      "id": 17,
      "type": "BOOLEAN",
      "zclType": 16,
      "dir": "down",
      "unit": null,
      "min": null,
      "max": null,
      "default": 1,
      "optional": false,
      "report": false,
      "desc": "Run the BME680 gas heater each cycle (heater burns ~12 mA for 150 ms; disable to save battery)"
    }
  ],
  "analogEndpoints": [
    {
      "ep": 2,
      "attr": "gasResistance",
      "description": "gas ohm"
    },
    {
      "ep": 3,
      "attr": "vbatMv",
      "description": "vbat mV"
    },
    {
      "ep": 4,
      "attr": "statusFlags",
      "description": "status flags"
    },
    {
      "ep": 5,
      "attr": "wakeCount",
      "description": "wake count"
    },
    {
      "ep": 6,
      "attr": "tempC",
      "description": "temp C"
    },
    {
      "ep": 7,
      "attr": "humidityPct",
      "description": "humidity pct"
    },
    {
      "ep": 8,
      "attr": "pressureKpa",
      "description": "pressure kPa"
    }
  ],
  "standardClusters": [
    {
      "cluster": "Temperature Measurement",
      "id": 1026,
      "ep": 1,
      "attr": "measuredValue",
      "encoding": "int16, °C × 100",
      "source": "BME680 temperature"
    },
    {
      "cluster": "Pressure Measurement",
      "id": 1027,
      "ep": 1,
      "attr": "measuredValue",
      "encoding": "int16, hPa (0.1 kPa)",
      "source": "BME680 pressure"
    },
    {
      "cluster": "Relative Humidity",
      "id": 1029,
      "ep": 1,
      "attr": "measuredValue",
      "encoding": "uint16, % × 100",
      "source": "BME680 humidity"
    },
    {
      "cluster": "Power Configuration",
      "id": 1,
      "ep": 1,
      "attr": "batteryVoltage 0x0020 / batteryPercentageRemaining 0x0021",
      "encoding": "uint8 100 mV / uint8 0.5 %",
      "source": "battery ADC via divider"
    }
  ],
  "statusBits": {
    "sensor_error": {
      "bit": 0,
      "desc": "BME680 not detected or measurement failed this cycle"
    },
    "heater_unstable": {
      "bit": 1,
      "desc": "Gas heater did not reach stability — gas_resistance unreliable this cycle"
    },
    "battery_low": {
      "bit": 2,
      "desc": "Battery below the low-voltage threshold"
    },
    "vbat_invalid": {
      "bit": 3,
      "desc": "Battery ADC read failed (check the divider wiring)"
    },
    "gas_disabled": {
      "bit": 4,
      "desc": "Gas heater disabled via HA (gas_enabled = OFF)"
    },
    "first_boot": {
      "bit": 5,
      "desc": "This cycle is a cold boot / reset, not a deep-sleep wake"
    }
  },
  "batteryLowMv": 3400,
  "awakeWindowS": 300
};

export default CONTRACT;
