"""Run bounded pwsh scripts for Windows guard tests with deterministic encoding."""

import os
import subprocess

# pwsh renders its error stream, including the ellipsis inside source-line
# excerpts, in the console code page; strict UTF-8 decoding of captured output
# requires the child session to pin its own output encoding before any script
# statement runs.
_ENCODING_PIN = (
    "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new();"
    "$OutputEncoding=[System.Text.UTF8Encoding]::new();"
)


def run_powershell(
    script: str,
    *,
    env_overrides: dict[str, str] | None = None,
    timeout: float = 30,
) -> subprocess.CompletedProcess[str]:
    """Execute one -Command script and capture decoded output without raising on exit codes."""
    environment = os.environ | (env_overrides or {})
    return subprocess.run(
        ["pwsh", "-NoProfile", "-NonInteractive", "-Command", _ENCODING_PIN + script],
        env=environment,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
        timeout=timeout,
    )
