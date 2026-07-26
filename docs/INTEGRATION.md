# Integration — flash → pair → Home Assistant

## 1. Flash (browser, no IDE)

1. Open **https://c6.miroslav.diy/flash/enviro/** in Chrome/Edge (desktop, HTTPS).
2. Plug the ESP32-C6 Super Mini in with a **data** USB-C cable.
3. **Connect & Flash** → pick "USB JTAG/serial debug unit".
4. If the port doesn't show up: unplug → hold **BOOT** → plug in → release after ~2 s.
5. Keep 115200 baud. For routine updates, **leave "Erase whole flash first" OFF**
   so `zb_storage` and Zigbee security state survive. Use **Recover device (erase
   flash only)** only for a genuinely broken half-write; a full erase makes the
   device factory-new and requires a clean re-pair.

Local build instead: `bash scripts/build-firmware.sh` (Docker, ESP-IDF 5.4) and serve
`web/` over HTTPS.

## 2. Zigbee2MQTT converter (do this BEFORE pairing)

```bash
# in your Z2M data dir; lib/ is shared with sibling external converters
mkdir -p external_converters/lib
cp z2m/biometal_enviro.mjs external_converters/
cp z2m/lib/enviro-contract.generated.mjs \
   z2m/lib/enviro-defs.mjs \
   z2m/lib/enviro-defs.factory.mjs \
   external_converters/lib/
```

> **Shared `external_converters/` with sibling projects:** the Enviro converter
> imports only the three `enviro-*` library files above. Do **not** overwrite a
> generic `lib/contract.generated.mjs` or `lib/defs.mjs`; those may belong to a
> sibling converter.

`configuration.yaml`:

```yaml
advanced:
  enable_external_js: true   # Z2M ≥ 2.11
homeassistant: true
```

Restart Z2M.

## 3. Pair (sleepy-device rules)

1. Z2M → **Permit join (all)**.
2. Power or reset the board. Factory-new firmware steers immediately; the LED goes
   blue (steering) → green (joined).
   For v0.1.13 the expected IEEE is **`0x8efd49fffe1a3d8c`**.
3. **Leave it alone for the next few minutes**: after the first join the device stays
   awake **5 minutes** and v0.1.13 temporarily enables continuous RX only for that
   bounded window. The first **60 seconds are intentionally quiet** (no
   telemetry/reporting) while it also polls its parent every 200 ms so Z2M can finish
   ZDO discovery. RX is explicitly switched off before reporting; normal timer wakes
   stay sleepy but reserve a 1 s 200 ms-poll control receive slot before telemetry.
   If the interview stalls, press **BOOT** briefly to reopen the same bounded window
   and hit "Reconfigure" in Z2M.
4. Result: device `C6-ENVIRO` / `Biometal`, type **EndDevice**, entities for
   temperature, humidity, pressure, gas_resistance, battery, voltage, vbat_mv,
   status bits, wake_count + config `report_interval_s`, `gas_enabled`.

### Recovery from the v0.1.2–v0.1.4 interview regression

Those builds exposed eight endpoints and can repeatedly fail with
`Interview failed because can not get active endpoints`. v0.1.5 returned to five
endpoints; v0.1.6/v0.1.7 then tested continuous RX, but v0.1.7 still failed live
despite strong uplink telemetry. v0.1.8 also exposed a separate factory-new security
failure after a full-flash erase: Z2M saw transient joins, but device-side BDB never
reached `STEERING=ESP_OK` because the coordinator retained the old EUI/link-key state.
Flash **v0.1.13 or newer**, pair IEEE `0x8efd49fffe1a3d8c`, keep Permit join open until
the serial console prints `JOINED`, and then let the interview continue. v0.1.10
exposes `[1,2,3,4,5]`, keeps `rx_on_when_idle=false` by default, and starts 200 ms
parent polling before factory-new BDB steering so the trust-center key can reach the
sleepy child. v0.1.12 additionally keeps RX on only for the 5-minute cold-boot/BOOT
window because live 2026-07-25 re-interviews still received announces but timed out
on Active Endpoints after the 60 s sleepy-only phase. v0.1.13 adds a one-second,
200 ms parent-poll control slot before every normal-wake telemetry burst, so queued
standard ZCL commands can be processed before deep sleep. Do not enable **Erase whole
flash first** merely to reopen interview mode. Do not repeatedly force-remove/rejoin
a half-interviewed entry: that creates overlapping interview attempts and
network-address churn. Acceptance is the Z2M database showing `interviewCompleted:true`,
`interviewState:"SUCCESSFUL"`, and `epList:[1,2,3,4,5]`.

### v0.1.13 standard controls + sleepy downlink window

ESP-Zigbee compat rejects writable manufacturer-specific attributes with
`NOT_AUTHORIZED`, even when the attribute list uses `READ_WRITE`. v0.1.12
therefore retained the successful five endpoint descriptors but added two **standard
clusters on EP1**; v0.1.13 keeps them and gives each normal deep-sleep wake a short
parent-polled control receive phase before reporting:

- `report_interval_s` → `genAnalogOutput.presentValue`, rounded and clamped to
  **3…3600 seconds** by converter and firmware;
- `gas_enabled` → `genOnOff` `on` / `off` commands.

Both values are persisted in NVS and apply on the next measurement cycle. The browser
installer's **Power settings** panel generates the exact Z2M payload; it deliberately
does not write through USB or replace NVS during a routine flash.

No network after 60 s (permit-join was closed)? The device sleeps 60 s and retries —
just open permit-join and wait, or tap RESET.

## 4. Zigbee network notes

- Primary channel is **11** (the home coordinator's); all channels are scanned as
  fallback.
- The device is a **sleepy end device**: it needs a parent (coordinator or any
  router) in range. `ed_timeout` is 64 min — if the device misses check-ins that
  long, the parent forgets it and the next wake triggers a rejoin.
- Config writes from HA are queued at the device's parent. v0.1.13 first gives
  every normal wake a **1 s** control receive phase at **200 ms** parent polls;
  only then does it restore the 1 s poll interval and emit telemetry. The converter
  also uses a cadence-aware ZCL timeout: **at least 30 s**, current interval + 10 s
  when larger, capped at **120 s**. At intervals above the cap, press RESET (or
  short-press BOOT while awake) to reopen the bounded RX window before saving a setting.

## 5. Home Assistant

Entities auto-discover via MQTT. Optional extras (battery-low push + gone-silent
watchdog): copy [`homeassistant/packages/c6_enviro.yaml`](../homeassistant/packages/c6_enviro.yaml)
into your `packages/` and adjust entity ids to your friendly name.

## 6. Debugging

- **Web console**: https://c6.miroslav.diy/flash/enviro/console/ — auto-reconnects
  across deep-sleep cycles, so you see every wake's log without touching anything.
  A normal console URL stays local-only. For durable server capture, open an operator-issued
  short-lived `#capture=…` link: the capability remains in the browser fragment, is removed
  from the address bar immediately, and serial chunks append server-side with `archive: active`.
- A healthy cycle logs:
  `C6-ENVIRO v0.1.13 starting (wake #N, deep-sleep wake)` →
  `vbat: …` → `BME680@0x76: T=…` → `network restored from NVRAM` →
  `deep sleep 2… ms`.
- `factory-new → network steering` in every cycle = the join never succeeded:
  check permit-join / channel / coordinator range.
- v0.1.13 additionally logs `Zigbee EUI-64 override: 0x8efd49fffe1a3d8c`,
  `steering: parent poll every 200 ms`, `normal wake: 1000 ms control receive phase`,
  and on a cold boot/BOOT press `interview window: continuous Zigbee RX for 300 s`.
  Acceptance requires that same IEEE in Z2M and the subsequent `interviewCompleted:true` state.
- A white/red commissioning LED alone is not a failure verdict: confirm Z2M is still
  advancing `wake_count` and that `first_boot`/`status_flags` are healthy first.
  v0.1.13 also gates WS2812/RMT initialization behind `first_boot`, so timer wakes
  never initialize the RGB driver.
- Re-pair from scratch: hold **BOOT ≥3 s** (factory reset) with permit-join open.
