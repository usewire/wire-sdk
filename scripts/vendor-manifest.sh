#!/usr/bin/env bash
# Vendor the Connect manifest validator from the Wire engine (SUP-946).
#
# The engine (usewire/wire) owns the manifest format and its validator. It
# builds the validator as one self-contained ESM file with no imports
# (`bun run build:manifest`). The SDK carries a copy of that build, pinned to
# the engine commit in MANIFEST_REF, under src/vendor/manifest/. Nothing in
# there is edited by hand: change MANIFEST_REF and rerun this script.
#
#   scripts/vendor-manifest.sh            fetch usewire/wire at MANIFEST_REF and build
#   WIRE_OSS_DIR=../wire scripts/...      build from an existing checkout (must be AT MANIFEST_REF)
#
# CI runs this and fails on any diff, so the vendored files always match the
# pinned commit. Needs git and bun (the version in BUN_VERSION below, so the
# bundle is byte-identical between machines).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REF="$(tr -d '[:space:]' < "$ROOT/MANIFEST_REF")"
DEST="$ROOT/src/vendor/manifest"
BUN_VERSION="1.3.13"

if [[ ! "$REF" =~ ^[0-9a-f]{40}$ ]]; then
  echo "MANIFEST_REF must hold a full 40-character commit SHA (got '$REF')" >&2
  exit 1
fi
if [[ "$(bun --version)" != "$BUN_VERSION" ]]; then
  echo "bun $BUN_VERSION required (found $(bun --version)); the bundle must be reproducible" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [[ -n "${WIRE_OSS_DIR:-}" ]]; then
  SRC="$(cd "$WIRE_OSS_DIR" && pwd)"
  HEAD="$(git -C "$SRC" rev-parse HEAD)"
  if [[ "$HEAD" != "$REF" ]]; then
    echo "WIRE_OSS_DIR is at $HEAD, not MANIFEST_REF $REF" >&2
    exit 1
  fi
else
  SRC="$WORK/wire"
  git init -q "$SRC"
  git -C "$SRC" remote add origin "${WIRE_OSS_REPO:-https://github.com/usewire/wire.git}"
  git -C "$SRC" fetch -q --depth 1 origin "$REF"
  git -C "$SRC" checkout -q FETCH_HEAD
fi

# Only the validator's build tooling is needed; skip install scripts and the
# optional ML dependency.
(cd "$SRC" && bun install --frozen-lockfile --ignore-scripts --omit optional >/dev/null)
(cd "$SRC" && bun run build:manifest --out "$WORK/out" >/dev/null)

HEADER="// Vendored from usewire/wire@$REF by scripts/vendor-manifest.sh (bun $BUN_VERSION). Do not edit: change MANIFEST_REF and rerun."

rm -rf "$DEST"
mkdir -p "$DEST"
{ echo "$HEADER"; cat "$WORK/out/manifest.js"; } > "$DEST/manifest.js"
{ echo "$HEADER"; cat "$WORK/out/manifest.d.ts"; } > "$DEST/manifest.d.ts"
cp -R "$WORK/out/manifest-types" "$DEST/manifest-types"
cat > "$DEST/ref.ts" <<EOF
$HEADER
/** The usewire/wire commit the vendored manifest validator was built from. */
export const MANIFEST_VALIDATOR_REF = '$REF';
EOF

echo "vendored the manifest validator from usewire/wire@$REF into src/vendor/manifest/"
