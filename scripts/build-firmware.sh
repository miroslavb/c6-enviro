#!/usr/bin/env bash
# build-firmware.sh — build the ESP32-C6 firmware reproducibly via the official
# ESP-IDF Docker image, then collect the flashable binaries + regenerate the
# web/firmware/manifest.json the browser installer serves.
#
# Why Docker: it pins the exact IDF toolchain (== CI) so the committed bins are
# reproducible regardless of the host's local IDF install.
#
# Usage:
#   scripts/build-firmware.sh              # full build in Docker, then gen-manifest
#   scripts/build-firmware.sh --no-build   # skip the build, just (re)collect + manifest
#   IDF_IMAGE=espressif/idf:release-v5.5 scripts/build-firmware.sh   # override image tag
#   DOCKER=podman scripts/build-firmware.sh                          # use podman
#
# Env:
#   IDF_IMAGE   ESP-IDF Docker image tag (default: espressif/idf:release-v5.4)
#   DOCKER      container runtime (default: docker)
#   TARGET      idf target (default: esp32c6)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FW="$ROOT/firmware"
IDF_IMAGE="${IDF_IMAGE:-espressif/idf:release-v5.4}"
DOCKER="${DOCKER:-docker}"
TARGET="${TARGET:-esp32c6}"

if [[ "${1:-}" != "--no-build" ]]; then
  echo "==> Building firmware in $IDF_IMAGE (target $TARGET)"
  # Mount the whole repo so the build dir + sdkconfig land back on the host. Run as
  # the invoking UID/GID so the produced files aren't root-owned. set-target is
  # idempotent (a no-op when sdkconfig already targets esp32c6).
  "$DOCKER" run --rm \
    -u "$(id -u):$(id -g)" \
    -e HOME=/tmp \
    -v "$ROOT":"$ROOT" \
    -w "$FW" \
    "$IDF_IMAGE" \
    idf.py set-target "$TARGET" build
else
  echo "==> Skipping build (--no-build); reusing existing $FW/build"
fi

if [[ ! -f "$FW/build/flasher_args.json" ]]; then
  echo "ERROR: $FW/build/flasher_args.json not found — did the build succeed?" >&2
  exit 1
fi

echo "==> Collecting binaries + regenerating manifest"
# node is needed only for the tiny manifest generator. CI provides Node; locally
# any Node 18+ works.
node "$ROOT/scripts/gen-manifest.mjs"

echo "==> web/firmware contents:"
ls -la "$ROOT/web/firmware"
echo "==> done"
