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
# in your Z2M data dir
mkdir -p external_converters
cp z2m/biometal_enviro.mjs external_converters/
cp -r z2m/lib external_converters/lib
```

> **Shared `external_converters/` with sibling projects** (c6-radiometer /
> c6-lcd-zigbee): the `lib/` filenames collide. Install the lib files with a
> project prefix instead — `lib/enviro-defs.mjs` + `lib/enviro-contract.generated.mjs` —
> and patch the three relative imports accordingly (this is how the home
> installation is deployed; the `c6lcd-*` prefix pattern is the precedent).

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
   For v0.1.10 the expected IEEE is **`0x8efd49fffe1a3d8c`**.
3. **Leave it alone for the next few minutes**: after the first join the device stays
   awake **5 minutes** but remains a sleepy end device. The first **60 seconds are
   intentionally quiet** (no telemetry/reporting) while the sleepy device polls its
   parent every 200 ms so Z2M can finish ZDO discovery. Normal 1 s polling returns
   automatically before telemetry starts.
   If the interview stalls, press **BOOT** briefly to extend the bounded MCU-awake
   window and hit "Reconfigure" in Z2M.
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
Flash **v0.1.10 or newer**, pair IEEE `0x8efd49fffe1a3d8c`, keep Permit join open until
the serial console prints `JOINED`, and then let the interview continue. v0.1.10
exposes `[1,2,3,4,5]`, keeps `rx_on_when_idle=false`, and
starts 200 ms parent polling before factory-new BDB steering so the trust-center key
can reach the sleepy child. It keeps that interval for the first 60 seconds after
fresh steering or a firmware-update cold boot for interview responses before enabling bind/report
traffic and restoring 1000 ms polling. Do not enable **Erase whole flash first**
merely to reopen interview mode. Do not repeatedly force-remove/rejoin a
half-interviewed entry: that creates overlapping interview attempts and
network-address churn. Acceptance is the Z2M database showing
`interviewCompleted:true`, `interviewState:"SUCCESSFUL"`, and `epList:[1,2,3,4,5]`.

No network after 60 s (permit-join was closed)? The device sleeps 60 s and retries —
just open permit-join and wait, or tap RESET.

## 4. Zigbee network notes

- Primary channel is **11** (the home coordinator's); all channels are scanned as
  fallback.
- The device is a **sleepy end device**: it needs a parent (coordinator or any
  router) in range. `ed_timeout` is 64 min — if the device misses check-ins that
  long, the parent forgets it and the next wake triggers a rejoin.
- Config writes from HA land on the next wake (the device polls its parent every
  cycle) — at a 3 s interval that's effectively instant; at 1 h it takes up to 1 h
  (or press BOOT to wake it now).

## 5. Home Assistant

Entities auto-discover via MQTT. Optional extras (battery-low push + gone-silent
watchdog): copy [`homeassistant/packages/c6_enviro.yaml`](../homeassistant/packages/c6_enviro.yaml)
into your `packages/` and adjust entity ids to your friendly name.

## 6. Debugging

- **Web console**: https://c6.miroslav.diy/flash/enviro/console/ — auto-reconnects
  across deep-sleep cycles, so you see every wake's log without touching anything.
- A healthy cycle logs:
  `C6-ENVIRO v0.1.10 starting (wake #N, deep-sleep wake)` →
  `vbat: …` → `BME680@0x76: T=…` → `network restored from NVRAM` →
  `deep sleep 2… ms`.
- `factory-new → network steering` in every cycle = the join never succeeded:
  check permit-join / channel / coordinator range.
- v0.1.10 additionally logs `Zigbee EUI-64 override: 0x8efd49fffe1a3d8c`
  and `steering: parent poll every 200 ms`
  before stack startup. Acceptance requires that same IEEE in Z2M.
- Re-pair from scratch: hold **BOOT ≥3 s** (factory reset) with permit-join open.
