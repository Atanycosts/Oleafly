#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
scratch="$(cd "$scratch" && pwd -P)"
mkdir -p "$scratch/tools" "$scratch/app with spaces"

typst_pin="$(cd "$ROOT" && node scripts/typst/bundled-typst.mjs version)"
for tool in bash dirname grep node; do
  ln -s "$(command -v "$tool")" "$scratch/tools/$tool"
done

bundle="$scratch/app with spaces"
write_engine() {
  printf '#!/bin/sh\n[ "$1" = "--version" ] || exit 1\nprintf "%%s\\n" "%s"\n' "$2" >"$bundle/$1"
  chmod +x "$bundle/$1"
}
write_engine Oleafly "Oleafly test app"
write_engine typst "typst $typst_pin"
write_engine tectonic "tectonic 0.17.0"
write_engine pandoc "pandoc 3.9.0.2"
write_engine tectonic-biber "biber version: 2.17"
ln -s "$bundle/Oleafly" "$scratch/oleafly-launcher"

check_packaged_app() {
  PATH="$scratch/tools" bash "$ROOT/scripts/ensure-e2e-sidecars.sh" "$scratch/oleafly-launcher"
}
check_packaged_app

write_engine pandoc "pandoc 0.0.0"
if check_packaged_app >"$scratch/check.log" 2>&1; then
  echo "e2e sidecar check accepted the wrong bundled Pandoc version" >&2
  exit 1
fi
grep -F "expected pandoc 3.9.0.2 from $bundle/pandoc" "$scratch/check.log" >/dev/null
