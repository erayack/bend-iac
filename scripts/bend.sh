#!/usr/bin/env bash
# Runs the pinned Bend 2 CLI from ./.toolchain without touching global state:
# telemetry off, hub cache local, --verdict kernel local.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TC="$ROOT/.toolchain"
[ -f "$TC/bend/bend2/main.ts" ] || { echo "bend-iac: toolchain missing; run scripts/bootstrap.sh" >&2; exit 127; }
export BEND_NO_TELEMETRY=1
export BEND_LIB="$TC/lib"
export BEND_HUB="http://127.0.0.1:9/no-hub"
export BENDTT="$TC/bendtt/bendtt"
exec bun "$TC/bend/bend2/main.ts" "$@"
