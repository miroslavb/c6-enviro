# Deploy — c6.miroslav.diy/flash/enviro/

Static-only (no backend). Topology: browser ──HTTPS──> edge VPS (Caddy, TLS)
──HTTP──> NUC Caddy ──> /var/www/c6-enviro.

1. Build/refresh bins: `bash scripts/build-firmware.sh` (commits-worthy output in `web/firmware/`).
2. Copy the static tree: `rsync -a --delete web/ <nuc>:/var/www/c6-enviro/`
3. Merge `deploy/Caddyfile.example` into the existing c6.miroslav.diy `route` block
   on the NUC, `caddy validate`, reload (not restart).
4. Smoke: https://c6.miroslav.diy/flash/enviro/ → page 200, `firmware/manifest.json`
   fetches, console/ opens.

Z2M/HA side: see `docs/INTEGRATION.md`.
