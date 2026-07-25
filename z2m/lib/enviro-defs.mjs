// Deployable C6-ENVIRO definitions. Both imports are namespaced so this module
// remains correct when Zigbee2MQTT external_converters/lib also hosts siblings.
import {CONTRACT, Zcl_DataType} from "./enviro-contract.generated.mjs";
import {createDefinitions} from "./enviro-defs.factory.mjs";

const definitions = createDefinitions(CONTRACT);

export {CONTRACT, Zcl_DataType};
export const STATUS_FLAGS_ATTR = definitions.STATUS_FLAGS_ATTR;
export const attributes = definitions.attributes;
export const downAttributes = definitions.downAttributes;
export const upAttributes = definitions.upAttributes;
export const exposeName = definitions.exposeName;
export const builderKind = definitions.builderKind;
export const buildStandardControls = definitions.buildStandardControls;
export const buildStatusFlagsDescriptor = definitions.buildStatusFlagsDescriptor;
export const buildAnalogChannels = definitions.buildAnalogChannels;
export const buildDeviceIdentity = definitions.buildDeviceIdentity;
