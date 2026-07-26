#!/usr/bin/env bash
# Deploy the browser flasher/console with Caddy-readable permissions.
# Root-owned source files created by tooling may be mode 0600; preserving that
# mode causes Caddy to return 403 for new JS modules despite a correct route.
set -euo pipefail

SOURCE_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/web/}"
TARGET_DIR="${2:-/var/www/c6-enviro/}"

rsync -a --delete --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r "$SOURCE_DIR" "$TARGET_DIR"
