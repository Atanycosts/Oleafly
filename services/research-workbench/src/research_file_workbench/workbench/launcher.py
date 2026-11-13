"""Run the application service for exactly one owning desktop process."""

from __future__ import annotations

import argparse
import os
import sys
import threading
from pathlib import Path
from typing import BinaryIO, TextIO

from research_file_workbench.journals.store import DATABASE_NAME
from research_file_workbench.workbench.server import WorkbenchHttpServer
from research_file_workbench.workbench.service import WorkbenchService

SHUTDOWN_POLL_SECONDS = 0.1


def run(root: Path, control: BinaryIO, ready: TextIO) -> None:
    """Serve owned storage until the shell closes its control pipe.

    Write the bound loopback URL only after storage and browser assets validate.
    Storage, bind and pipe errors propagate to the executable boundary.
    """
    font_dirs = tuple(
        Path(path) for path in os.environ.get("OLEAFLY_FONT_DIRS", "").split(os.pathsep) if path
    )
    service = (
        WorkbenchService(root, font_dirs=font_dirs)
        if (root / DATABASE_NAME).exists()
        else WorkbenchService.create(root, font_dirs=font_dirs)
    )
    with WorkbenchHttpServer(("127.0.0.1", 0), service) as server:
        ready.write(f"http://127.0.0.1:{server.server_port}/\n")
        ready.flush()

        control_errors: list[OSError] = []

        def wait_for_owner() -> None:
            try:
                control.read()
            except OSError as exc:
                control_errors.append(exc)
            finally:
                server.shutdown()

        owner_watch = threading.Thread(target=wait_for_owner, name="desktop-owner", daemon=True)
        owner_watch.start()
        server.serve_forever(poll_interval=SHUTDOWN_POLL_SECONDS)
        owner_watch.join()
        if control_errors:
            raise control_errors[0]


def main(argv: list[str] | None = None) -> int:
    """Start the local service, returning a failure status if startup is refused."""
    parser = argparse.ArgumentParser(prog="rfw-desktop-service")
    parser.add_argument("--library-root", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        run(args.library_root, sys.stdin.buffer, sys.stdout)
    except (OSError, ValueError) as exc:
        print(f"无法打开工作台：{exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
