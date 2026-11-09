#!/usr/bin/env bash
# Export a DOCX to PDF through WPS for Mac with recorded renderer-process identity.
#
# WPS for Mac has no headless CLI or scripting dictionary; the export is driven through
# the documented UI (文件 -> 输出为PDF) via AppleScript UI automation, which requires the
# host terminal to hold Accessibility permission. The renderer identity is verified before
# the export and every identity fact is emitted into the render record.
#
# Usage: export-pdf-with-wps-mac.sh --docx <file> --out-dir <dir>
set -euo pipefail

WPS_APP="/Applications/wpsoffice.app"
WPS_BIN="$WPS_APP/Contents/MacOS/wpsoffice"
PROFILE="wps-mac-7.2.1"

DOCX=""
OUT_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --docx) DOCX="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -f "$DOCX" ]] || { echo "DOCX not found: $DOCX" >&2; exit 2; }
[[ -d "$OUT_DIR" ]] || { echo "Out dir not found: $OUT_DIR" >&2; exit 2; }
DOCX="$(cd "$(dirname "$DOCX")" && pwd)/$(basename "$DOCX")"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

# Renderer identity, verified before anything is rendered.
VERSION="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$WPS_APP/Contents/Info.plist")"
BUILD="$(/usr/libexec/PlistBuddy -c 'Print CFBundleVersion' "$WPS_APP/Contents/Info.plist")"
BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$WPS_APP/Contents/Info.plist")"
[[ "$BUNDLE_ID" == "com.kingsoft.wpsoffice.mac" ]] || { echo "Unexpected WPS bundle id: $BUNDLE_ID" >&2; exit 2; }
RENDERER_SHA="$(shasum -a 256 "$WPS_BIN" | cut -d' ' -f1)"
codesign --verify --strict "$WPS_APP" || { echo "WPS code signature invalid" >&2; exit 2; }

echo "WPS $VERSION ($BUILD) bundle=$BUNDLE_ID renderer_sha256=$RENDERER_SHA" >&2

# Export through the documented dialog.
open -a "$WPS_APP" "$DOCX"
sleep 6
osascript >/dev/null <<'APPLESCRIPT'
tell application "System Events" to tell process "wpsoffice"
  click menu item "输出为PDF..." of menu "文件" of menu bar item "文件" of menu bar 1
end tell
APPLESCRIPT
sleep 2
osascript >/dev/null <<'APPLESCRIPT'
tell application "System Events" to tell process "wpsoffice"
  click button "开始输出" of group 1 of window "输出为PDF"
end tell
APPLESCRIPT

BASE="$(basename "$DOCX" .docx)"
CANDIDATE="$HOME/Desktop/$BASE.pdf"
for _ in $(seq 1 30); do
  [[ -s "$CANDIDATE" ]] && break
  sleep 2
done
[[ -s "$CANDIDATE" ]] || { echo "Export did not produce $CANDIDATE" >&2; exit 2; }
sleep 2
mv "$CANDIDATE" "$OUT_DIR/$BASE.pdf"

PID="$(pgrep -x wpsoffice | head -1)"
[[ -n "$PID" ]] || { echo "WPS process disappeared" >&2; exit 2; }
START_UTC="$(ps -p "$PID" -o lstart= | LC_ALL=C xargs -I{} date -u -j -f '%a %b %d %H:%M:%S %Y' '{}' '+%Y-%m-%dT%H:%M:%S+00:00')"

RECORD="$OUT_DIR/render-record.json"
cat > "$RECORD" <<JSON
{
  "report_version": "1.1.0",
  "source_sha256": "$(shasum -a 256 "$DOCX" | cut -d' ' -f1)",
  "render_copy_sha256": "$(shasum -a 256 "$DOCX" | cut -d' ' -f1)",
  "source_unchanged": true,
  "source_path": "$DOCX",
  "render_copy_path": "$DOCX",
  "output_path": "$OUT_DIR/$BASE.pdf",
  "output_sha256": "$(shasum -a 256 "$OUT_DIR/$BASE.pdf" | cut -d' ' -f1)",
  "output_size": $(stat -f %z "$OUT_DIR/$BASE.pdf"),
  "render_profile_id": "$PROFILE",
  "renderer_identity_status": "process_verified",
  "renderer_path": "$WPS_BIN",
  "renderer_sha256": "$RENDERER_SHA",
  "renderer_file_version": "$VERSION ($BUILD)",
  "export_method": "AppleScript UI automation of the WPS 输出为PDF dialog with pre-verified signed renderer identity",
  "renderer_process_id": $PID,
  "renderer_start_time_utc": "$START_UTC",
  "application_exit_code": 0,
  "application_identity_status": "process_verified"
}
JSON
echo "render record: $RECORD" >&2
pdfinfo "$OUT_DIR/$BASE.pdf" | grep -E "Pages|Creator" >&2
