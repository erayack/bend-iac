#!/usr/bin/env bash
# Fetches the pinned Bend 2 compiler (a git checkout at BEND_COMMIT) and the
# pinned Lean release that --verdict needs, then builds the BendTT kernel.
# Everything lands in ./.toolchain; global paths (~/.bend, ~/.elan, PATH) are
# never written. Network is needed only here. Idempotent.
#
#   BEND_SRC=/path/to/local/bend/clone scripts/bootstrap.sh   # optional mirror
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/toolchain.env"
TC="$ROOT/.toolchain"
mkdir -p "$TC"

say() { printf 'bootstrap: %s\n' "$*"; }

# 1. Bend at the pinned commit -------------------------------------------
if [ -d "$TC/bend/.git" ] && [ "$(git -C "$TC/bend" rev-parse HEAD)" = "$BEND_COMMIT" ] \
  && [ -z "$(git -C "$TC/bend" status --porcelain)" ]; then
  say "bend $BEND_COMMIT already present"
else
  rm -rf "$TC/bend"
  git init -q "$TC/bend"
  src="${BEND_SRC:-$BEND_REPO}"
  say "fetching bend $BEND_COMMIT from $src"
  git -C "$TC/bend" fetch -q --depth 1 "$src" "$BEND_COMMIT"
  git -C "$TC/bend" -c advice.detachedHead=false checkout -q FETCH_HEAD
fi
got="$(git -C "$TC/bend" rev-parse HEAD)"
[ "$got" = "$BEND_COMMIT" ] || { say "bend commit mismatch: $got"; exit 1; }

# 2. Lean at the pinned version, checked against its release digest -------
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) plat=darwin_aarch64 ;;
  Darwin-x86_64) plat=darwin ;;
  Linux-x86_64) plat=linux ;;
  Linux-aarch64) plat=linux_aarch64 ;;
  *) say "unsupported platform $(uname -s)-$(uname -m)"; exit 1 ;;
esac
var="LEAN_SHA256_$plat"
want="${!var}"
asset="lean-$LEAN_VERSION-$plat.tar.zst"
lean_dir="$TC/lean/lean-$LEAN_VERSION-$plat"
if [ -x "$lean_dir/bin/lean" ]; then
  say "lean $LEAN_VERSION already present"
else
  mkdir -p "$TC/dl" "$TC/lean"
  if [ ! -f "$TC/dl/$asset" ]; then
    say "downloading $asset"
    curl -fsSL -o "$TC/dl/$asset.part" \
      "https://github.com/leanprover/lean4/releases/download/v$LEAN_VERSION/$asset"
    mv "$TC/dl/$asset.part" "$TC/dl/$asset"
  fi
  have="$(shasum -a 256 "$TC/dl/$asset" | cut -d' ' -f1)"
  [ "$have" = "$want" ] || { say "sha256 mismatch for $asset: $have != $want"; rm -f "$TC/dl/$asset"; exit 1; }
  command -v zstd >/dev/null || { say "zstd is required to unpack $asset"; exit 1; }
  zstd -dc "$TC/dl/$asset" | tar -x -C "$TC/lean"
fi
"$lean_dir/bin/lean" --version | grep -q "version $LEAN_VERSION" \
  || { say "lean version mismatch"; exit 1; }

# 3. The BendTT kernel (bend2/bendtt.lean, compiled like bend2/safe.ts does,
#    but into ./.toolchain/bendtt instead of ~/.bend/bendtt) --------------
kdir="$TC/bendtt"
src="$TC/bend/bend2/bendtt.lean"
if [ -x "$kdir/bendtt" ] && cmp -s "$src" "$kdir/bendtt.lean"; then
  say "bendtt kernel already built"
else
  rm -rf "$kdir" && mkdir -p "$kdir"
  cp "$src" "$kdir/bendtt.lean"
  say "building the BendTT kernel with lean $LEAN_VERSION"
  (cd "$kdir" && "$lean_dir/bin/lean" -c bendtt.c bendtt.lean \
    && "$lean_dir/bin/leanc" -O3 -DNDEBUG bendtt.c -o bendtt)
fi

say "bun $(bun --version) (tested: $BUN_TESTED)"
say "ok: run 'npm test'"
