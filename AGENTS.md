# C6 Enviro engineering rules

- Preserve the product role: ESP32-C6 **sleepy end device** powered from a solar-charged Li-ion cell. `rx_on_when_idle` must remain false; do not copy permanent-router behavior from the mains-powered sibling projects.
- Use `/root/c6-lcd-zigbee` and `/root/c6-radiometer` as differential controls for shared ESP32-C6 / ESP-IDF 5.4 / esp-zigbee-lib behavior, while treating router-vs-ZED power semantics as an intentional difference.
- Keep the arena acceptance oracle live: build/tests are supporting evidence only. Interview success requires Z2M `interviewCompleted:true`, `epList:[1,2,3,4,5]`, current `swBuildId`, and no active-endpoint timeout.
- v0.1.9 recovery identity is `0x8efd49fffe1a3d8c`; hardware acceptance must use this IEEE and must first show device-side `JOINED`, not merely Z2M `device_joined`.
- Routine browser flashes must preserve `zb_storage`: the erase-first checkbox defaults OFF and missing checkbox state fails safe to `eraseAll=false`; whole-flash erase is an explicit confirmed factory-new recovery step, never a default.
- Never force-remove, factory-reset, or erase the live device/network state without explicit user approval.
- Follow TDD for firmware behavior changes, then run host tests, contract parity, Z2M tests, Docker ESP-IDF 5.4 build, final manifest/version checks, and fresh final-file verification.
- A delayed reporting callback belongs to exactly one join attempt: cancel it on replacement or `LEAVE`, and treat `LEFT` as higher priority than a concurrently set `REPORTING_READY` bit.
- Commissioning fast polling is bounded: 200 ms parent polls only during the 60 s quiet interview phase, then restore the normal 1000 ms interval before reporting. This is not permission for always-on RX.
- After any code change, update this file and the affected architecture/integration/lessons documentation before committing and pushing.