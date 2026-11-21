#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -n "${1:-}" ]]; then
  # Match the app's runtime lookup, including launches through a symlink.
  BIN_DIR="$(node -p 'require("node:path").dirname(require("node:fs").realpathSync(process.argv[1]))' -- "$1")"
  SUFFIX=""
else
  HOST="$(rustc -vV | awk '/^host: / { print $2 }')"
  case "$HOST" in
    aarch64-apple-darwin|x86_64-apple-darwin|aarch64-unknown-linux-gnu|x86_64-unknown-linux-gnu|x86_64-pc-windows-msvc) ;;
    *) echo "unsupported E2E host: $HOST" >&2; exit 1 ;;
  esac

  BIN_DIR="$ROOT/src-tauri/binaries"
  SUFFIX="-$HOST"
  [[ "$HOST" == *windows* ]] && SUFFIX+=".exe"

  bash "$ROOT/scripts/fetch-typst.sh" "$HOST"
  bash "$ROOT/scripts/fetch-tectonic.sh" "$HOST"
  bash "$ROOT/scripts/fetch-biber.sh" "$HOST"
  bash "$ROOT/scripts/fetch-pandoc.sh" "$HOST"
fi

check_version() {
  local binary="$1" expected="$2" version
  if ! version="$("$binary" --version)" || ! grep -Fi -- "$expected" <<<"$version" >/dev/null; then
    echo "e2e: expected $expected from $binary (reported: $version)" >&2
    return 1
  fi
}

TYPST_PIN="$(cd "$ROOT" && node scripts/typst/bundled-typst.mjs version)"
check_version "$BIN_DIR/typst$SUFFIX" "typst $TYPST_PIN"
check_version "$BIN_DIR/tectonic$SUFFIX" "tectonic 0.17.0"
check_version "$BIN_DIR/pandoc$SUFFIX" "pandoc 3.9.0.2"
# Biber is optional on aarch64 Linux (no upstream 2.17 binary).
BIBER="$BIN_DIR/tectonic-biber$SUFFIX"
if [[ -f "$BIBER" ]]; then
  BIBER_VERSION="$("$BIBER" --version 2>&1 || true)"
  if ! grep -Fi "2.17" <<<"$BIBER_VERSION" >/dev/null; then
    echo "e2e: expected Biber 2.17 from $BIBER (reported: $BIBER_VERSION)" >&2
    exit 1
  fi
fi
