#!/usr/bin/env bash
set -euo pipefail

while [[ "$1" != -m ]]; do shift; done
test "$2" = research_file_workbench.workbench.launcher
shift 2

exec "$OLEAFLY_PROBE_PYTHON" -u -c '
import faulthandler
import runpy
import sys

print("Workbench probe: Python entered", file=sys.stderr, flush=True)
faulthandler.dump_traceback_later(20)
runpy.run_module("research_file_workbench.workbench.launcher", run_name="__main__")
' "$@"
