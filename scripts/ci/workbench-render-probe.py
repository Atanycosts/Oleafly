"""Test starting LibreOffice without the desktop owner's control pipe."""

import contextlib
import subprocess
import sys
import threading
from pathlib import Path

run = subprocess.run


def traced_run(command, *args, **kwargs):
    if not isinstance(command, list) or "pdf:writer_pdf_Export" not in command:
        return run(command, *args, **kwargs)
    output = Path(command[command.index("--outdir") + 1]) / "baseline.pdf"

    def snapshot():
        stat = output.stat().st_size if output.exists() else None
        print(f"Render probe: after 20s PDF bytes={stat}", file=sys.stderr, flush=True)
        for name in ("soffice.com", "soffice.exe", "soffice.bin"):
            with contextlib.suppress(subprocess.SubprocessError, OSError):
                processes = run(["tasklist", "/FI", f"IMAGENAME eq {name}"], capture_output=True, timeout=5)
                print(processes.stdout.decode(errors="replace").strip(), file=sys.stderr, flush=True)

    print("Render probe: starting PDF conversion", file=sys.stderr, flush=True)
    kwargs["stdin"] = subprocess.DEVNULL
    timer = threading.Timer(20, snapshot)
    timer.daemon = True
    timer.start()
    try:
        return run(command, *args, **kwargs)
    except subprocess.TimeoutExpired as error:
        print(f"Render probe: timeout stdout={error.stdout!r} stderr={error.stderr!r}", file=sys.stderr, flush=True)
        raise
    finally:
        timer.cancel()


if sys.platform == "win32" and "research_file_workbench.workbench.launcher" in sys.orig_argv:
    subprocess.run = traced_run
