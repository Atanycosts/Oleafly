#!/usr/bin/env bash
set -euo pipefail

exec "$OLEAFLY_PROBE_PYTHON" -u -c '
import faulthandler
import runpy
import sys

print("Workbench probe: Python entered", file=sys.stderr, flush=True)
faulthandler.dump_traceback_later(20)
del sys.argv[1:3]
runpy.run_module("research_file_workbench.workbench.launcher", run_name="__main__")
' "$@"
