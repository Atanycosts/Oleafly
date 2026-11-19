"""SQLite file URIs retain paths and enforce their requested access mode."""

import sqlite3
from pathlib import PureWindowsPath

import pytest

from research_file_workbench.common.sqlite import sqlite_file_uri


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        (
            PureWindowsPath(r"C:\Library\worlds.sqlite3"),
            "file:///C:/Library/worlds.sqlite3?mode=ro",
        ),
        (
            PureWindowsPath(r"\\?\C:\Library\worlds.sqlite3"),
            "file:///C:/Library/worlds.sqlite3?mode=ro",
        ),
        (
            PureWindowsPath(r"\\?\UNC\server\share\worlds.sqlite3"),
            "file://server/share/worlds.sqlite3?mode=ro",
        ),
    ],
)
def test_sqlite_file_uri_normalizes_windows_paths_without_verbatim_authority(path, expected):
    assert sqlite_file_uri(path, "ro") == expected


def test_sqlite_file_uri_encodes_a_path_question_mark_before_the_mode_query():
    path = PureWindowsPath(r"\\?\C:\Library\world?draft.sqlite3")
    assert sqlite_file_uri(path, "ro") == "file:///C:/Library/world%3Fdraft.sqlite3?mode=ro"


def test_sqlite_readonly_uri_rejects_writes(tmp_path):
    database = tmp_path / "worlds.sqlite3"
    database.touch()
    with sqlite3.connect(sqlite_file_uri(database, "rw"), uri=True) as connection:
        connection.execute("CREATE TABLE retained (value TEXT NOT NULL)")
        connection.execute("INSERT INTO retained VALUES ('kept')")

    with sqlite3.connect(sqlite_file_uri(database, "ro"), uri=True) as connection:
        assert connection.execute("SELECT value FROM retained").fetchone() == ("kept",)
        with pytest.raises(sqlite3.OperationalError, match="readonly"):
            connection.execute("INSERT INTO retained VALUES ('rejected')")
