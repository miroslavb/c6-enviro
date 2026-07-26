# contract.json — informal schema

Not a JSON Schema — a human note (the `$schema` key points here so readers find it).

- `device` — Basic-cluster identity: `manufacturerName`, `modelId` (== Z2M
  `zigbeeModel`), `vendor`, `description`, `powerSource` (0x03 = battery).
- `attributes[]` — domain fields: `name` (camelCase C/JS identifier), `expose`
  (snake_case HA property), historical `id`, type
  (`BOOLEAN|UINT8|UINT16|UINT32|INT16|ENUM8|SINGLE|CHAR_STR`), direction
  (`up` / `down`), optional `unit`, `default`, `min`, `max`, `desc`.
- `standardControls[]` — standard-ZCL mapping for every writable field:
  `{attr,name,ep,cluster,clusterId,attribute,attributeId,transport}` plus
  `onCommand` / `offCommand` for command-based boolean controls. Controls must
  reference a `down` attribute and live on existing endpoint(s); Enviro keeps
  both at EP1 to preserve the EP1…EP5 sleepy interview budget.
- `pollControl` — standard EP1 `genPollCtrl` transport and timing:
  `{ep,cluster,clusterId,coordinatorShortAddress,coordinatorEndpoint,
  checkInIntervalQs,longPollIntervalQs,shortPollIntervalQs,fastPollTimeoutQs}`.
  `Qs` values are quarter-seconds. The automatic interval serves the bounded
  awake window; normal timer wakes also send one explicit CheckIn.
- `analogEndpoints[]` — `{ep, attr, description}`: standard `genAnalogInput`
  endpoint per reported non-standard field; `attr` must reference an attribute.
- `standardClusters[]` — documentation of fixed-semantics EP1 telemetry clusters.
- `statusBits[]` — `{name, bit, desc}` for the statusFlags bitmask.
- `batteryLowMv`, `awakeWindowS` — scalar constants surfaced as C defines.

**Wire rule:** v4 does not register a manufacturer-specific custom cluster.
ESP-Zigbee compat rejects custom `READ_WRITE` attributes with `NOT_AUTHORIZED`;
use only the declared standard control mapping.

Change anything → `node contract/codegen.mjs` → commit the four regenerated files.
`contract/contract.test.mjs` fails CI on drift.
