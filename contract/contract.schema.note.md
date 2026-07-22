# contract.json — informal schema

Not a JSON Schema — a human note (the `$schema` key just points here so readers find it).

- `device` — Basic-cluster identity: `manufacturerName`, `modelId` (== Z2M zigbeeModel),
  `vendor`, `description`, `powerSource` (0x03 = battery).
- `manufacturerCode` — ZCL manufacturer code used for the custom cluster (0x131B Espressif).
- `customCluster` — `{name, id}`; id in the manufacturer range 0xFC00–0xFFFF.
- `attributes[]` — custom-cluster attrs: `name` (camelCase, C/JS identifier),
  `expose` (snake_case HA property), `id`, `type` (BOOLEAN|UINT8|UINT16|UINT32|INT16|ENUM8|SINGLE|CHAR_STR),
  `dir` (`up` = device→HA readable, `down` = HA→device writable),
  optional `unit`, `default`, `min`, `max`, `desc`.
- `analogEndpoints[]` — `{ep, attr, description}`: standard genAnalogInput endpoint per
  reported channel; `attr` must reference an `attributes[].name`.
- `standardClusters[]` — documentation of the fixed-semantics EP1 clusters (not codegen'd
  into firmware — informational for docs/CONTRACT.md).
- `statusBits[]` — `{name, bit, desc}` for the statusFlags bitmask.
- `batteryLowMv`, `awakeWindowS` — scalar constants surfaced as C defines.

Change anything → `node contract/codegen.mjs` → commit the three regenerated files.
`contract/contract.test.mjs` fails CI on drift.
