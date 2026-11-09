"""Verify the desktop process contract using real pipes and local HTTP requests."""

import os
import subprocess
import sys
import threading
from contextlib import contextmanager
from http.client import HTTPConnection
from io import BytesIO, StringIO
from pathlib import Path
from urllib.parse import urlparse

import pytest

from research_file_workbench.common.json_io import decode_json_object
from research_file_workbench.journals.store import DATABASE_NAME
from research_file_workbench.workbench.launcher import run
from research_file_workbench.workbench.service import WorkbenchService

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


@contextmanager
def launched_service(root: Path):
    environment = os.environ.copy()
    environment["PYTHONPATH"] = str(REPOSITORY_ROOT / "src")
    process = subprocess.Popen(
        [
            sys.executable,
            "-u",
            "-m",
            "research_file_workbench.workbench.launcher",
            "--library-root",
            str(root),
        ],
        cwd=root.parent,
        env=environment,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    startup_deadline = threading.Timer(10, process.kill)
    startup_deadline.start()
    try:
        assert process.stdout is not None
        address = process.stdout.readline().decode("ascii").strip()
        startup_deadline.cancel()
        yield process, address
    finally:
        startup_deadline.cancel()
        if process.stdin is not None:
            process.stdin.close()
            process.stdin = None
        try:
            process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate(timeout=5)
            raise


def session(address: str):
    parsed = urlparse(address)
    assert parsed.scheme == "http"
    assert parsed.hostname == "127.0.0.1"
    assert parsed.port is not None and parsed.port > 0
    connection = HTTPConnection(parsed.hostname, parsed.port, timeout=5)
    connection.request("GET", "/api/session")
    response = connection.getresponse()
    payload = response.read()
    connection.close()
    assert response.status == 200
    return decode_json_object(payload)


def test_service_reports_actual_address_and_stops_when_owner_pipe_closes(tmp_path: Path):
    root = tmp_path / "library"
    with launched_service(root) as (process, address):
        result = session(address)
        assert result["token"]
        assert result["asset_version"]
        assert (root / DATABASE_NAME).is_file()
        assert process.poll() is None
        assert process.stdin is not None
        process.stdin.close()
        process.stdin = None
        assert process.wait(timeout=5) == 0
    parsed = urlparse(address)
    connection = HTTPConnection(parsed.hostname, parsed.port, timeout=1)
    with pytest.raises(OSError):
        connection.connect()
    connection.close()


def test_service_processes_get_distinct_ports_and_sessions(tmp_path: Path):
    with (
        launched_service(tmp_path / "first") as (_, first),
        launched_service(tmp_path / "second") as (_, second),
    ):
        assert first != second
        assert session(first)["token"] != session(second)["token"]


def test_existing_library_is_reopened_without_reinitialization(tmp_path: Path):
    root = tmp_path / "library"
    WorkbenchService.create(root)
    original = (root / DATABASE_NAME).read_bytes()
    with launched_service(root) as (_, address):
        session(address)
    assert (root / DATABASE_NAME).read_bytes() == original


def test_corrupt_library_never_reports_readiness(tmp_path: Path):
    root = tmp_path / "library"
    root.mkdir()
    database = root / DATABASE_NAME
    original = b"not a sqlite library"
    database.write_bytes(original)
    with launched_service(root) as (process, address):
        assert address == ""
        assert process.wait(timeout=5) == 2
    assert database.read_bytes() == original


def test_existing_file_is_not_replaced_with_library(tmp_path: Path):
    root = tmp_path / "author.txt"
    root.write_text("retained input", encoding="utf-8")
    ready = StringIO()
    with pytest.raises(OSError):
        run(root, BytesIO(), ready)
    assert ready.getvalue() == ""
    assert root.read_text(encoding="utf-8") == "retained input"


def test_control_pipe_error_stops_service_and_propagates(tmp_path: Path):
    class BrokenPipe(BytesIO):
        def read(self, size=-1):
            raise OSError("owner control pipe failed")

    ready = StringIO()
    with pytest.raises(OSError, match="owner control pipe failed"):
        run(tmp_path / "library", BrokenPipe(), ready)
    assert ready.getvalue().startswith("http://127.0.0.1:")
