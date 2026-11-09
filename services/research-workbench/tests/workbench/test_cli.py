"""Command-line entry point checks for the local workbench shell."""

import json

from research_file_workbench.workbench import cli


def test_init_creates_library_and_reports_resolved_root(tmp_path, capsys):
    root = tmp_path / "library"

    assert cli.main(["--library-root", str(root), "init"]) == 0

    report = json.loads(capsys.readouterr().out)
    assert report == {"library_root": root.resolve().as_posix()}
    assert (root / "worlds.sqlite3").is_file()
    # The library creates application subdirectories lazily on first manuscript import.
    assert not (root / "inputs").exists()
    assert not (root / "projects").exists()


def test_serve_rejects_protected_root_after_initialization(monkeypatch, tmp_path, capsys):
    called = False

    def fail_if_started(*args, **kwargs):
        nonlocal called
        called = True

    monkeypatch.setattr(cli, "serve", fail_if_started)
    result = cli.main(
        [
            "--library-root",
            str(tmp_path / "library"),
            "--protected-root",
            str(tmp_path / "author"),
            "serve",
        ]
    )

    assert result == 2
    assert called is False
    assert "Protected roots" in capsys.readouterr().err


def test_serve_forwards_host_and_port(monkeypatch, tmp_path):
    calls = []

    def capture(root, *, host, port):
        calls.append((root, host, port))

    monkeypatch.setattr(cli, "serve", capture)
    root = tmp_path / "library"

    assert (
        cli.main(["--library-root", str(root), "--host", "127.0.0.2", "--port", "9876", "serve"])
        == 0
    )
    assert calls == [(root, "127.0.0.2", 9876)]


def test_cli_journal_loop_round_trips_without_the_browser(tmp_path, capsys):
    """Import, review, bind, check, and record a disposition through CLI commands only."""
    import pymupdf

    from research_file_workbench.workbench.service import WorkbenchService
    from tests.journals.test_analysis import docx_bytes

    library = tmp_path / "library"
    assert cli.main(["--library-root", str(library), "init"]) == 0
    capsys.readouterr()

    document = pymupdf.open()
    page = document.new_page()
    page.insert_text((50, 100), "All manuscript pages must use A4 paper.", fontsize=10.0)
    guide = tmp_path / "guide.pdf"
    guide.write_bytes(document.tobytes())
    document.close()
    manifest = tmp_path / "sources.json"
    manifest.write_text(
        json.dumps([{"name": "guide.pdf", "kind": "guide_pdf", "path": guide.as_posix()}]),
        encoding="utf-8",
    )

    assert (
        cli.main(
            [
                "--library-root",
                str(library),
                "import-world",
                "--journal-id",
                "journal-test",
                "--name",
                "Test Journal",
                "--sources-manifest",
                str(manifest),
            ]
        )
        == 0
    )
    world = json.loads(capsys.readouterr().out)
    assert world["version_id"].startswith("world-")

    assert (
        cli.main(["--library-root", str(library), "review", "--version-id", world["version_id"]])
        == 0
    )
    review = json.loads(capsys.readouterr().out)
    located = [link for link in review["rule_links"] if link["link_status"] == "located"]
    assert located and located[0]["locator"] == "page:1/block:1"

    docx = tmp_path / "稿件.docx"
    docx.write_bytes(docx_bytes("<w:p><w:r><w:t>Body text.</w:t></w:r></w:p>"))
    assert (
        cli.main(
            [
                "--library-root",
                str(library),
                "import-manuscript",
                "--name",
                "论文工作稿",
                "--filename",
                "稿件.docx",
                "--docx",
                str(docx),
            ]
        )
        == 0
    )
    project = json.loads(capsys.readouterr().out)

    assert (
        cli.main(
            [
                "--library-root",
                str(library),
                "bind",
                "--project-id",
                project["project_id"],
                "--world-version-id",
                world["version_id"],
            ]
        )
        == 0
    )
    capsys.readouterr()
    assert (
        cli.main(["--library-root", str(library), "check", "--project-id", project["project_id"]])
        == 0
    )
    check = json.loads(capsys.readouterr().out)

    assert (
        cli.main(
            [
                "--library-root",
                str(library),
                "disposition",
                "--check-id",
                check["check_id"],
                "--rule-id",
                check["world"]["rules"][0]["rule_id"],
                "--action",
                "note",
                "--note",
                "与作者确认过",
            ]
        )
        == 0
    )
    assert json.loads(capsys.readouterr().out)["action"] == "note"

    page_png = tmp_path / "page-1.png"
    assert (
        cli.main(
            [
                "--library-root",
                str(library),
                "source-page",
                "--version-id",
                world["version_id"],
                "--source-id",
                world["sources"][0]["source_id"],
                "--page",
                "1",
                "--out",
                str(page_png),
            ]
        )
        == 0
    )
    assert page_png.stat().st_size > 100 and page_png.read_bytes()[:4] == b"\x89PNG"

    # The browser-side service sees exactly the same retained records.
    service = WorkbenchService(library)
    history = service.history(project["project_id"])
    assert history["checks"] and history["bindings"]


def test_cli_update_manuscript_applies_and_reports_conflicts_with_reasons(tmp_path, capsys):
    """update-manuscript captures a new baseline; a stale expected id is a declared refusal."""
    from research_file_workbench.workbench.service import WorkbenchService
    from tests.journals.test_analysis import docx_bytes

    library = tmp_path / "library"
    service = WorkbenchService.create(library)
    content = docx_bytes("<w:p><w:r><w:t>Body text.</w:t></w:r></w:p>")
    project = service.import_manuscript("论文工作稿", "稿件.docx", content)
    baseline_id = str(project["baseline_id"])

    revised = tmp_path / "稿件2.docx"
    revised.write_bytes(docx_bytes("<w:p><w:r><w:t>Revised body text.</w:t></w:r></w:p>"))
    assert (
        cli.main(
            [
                "--library-root",
                str(library),
                "update-manuscript",
                "--project-id",
                str(project["project_id"]),
                "--expected-baseline-id",
                baseline_id,
                "--filename",
                "稿件2.docx",
                "--docx",
                str(revised),
                "--reason",
                "修订稿",
            ]
        )
        == 0
    )
    applied = json.loads(capsys.readouterr().out)
    assert applied["status"] == "APPLIED"

    assert (
        cli.main(
            [
                "--library-root",
                str(library),
                "update-manuscript",
                "--project-id",
                str(project["project_id"]),
                "--expected-baseline-id",
                baseline_id,
                "--filename",
                "稿件2.docx",
                "--docx",
                str(revised),
                "--reason",
                "再次修订",
            ]
        )
        == 2
    )
    assert "BASELINE_CONFLICT" in capsys.readouterr().err


def test_cli_import_world_refuses_a_bad_manifest_without_touching_the_library(tmp_path, capsys):
    from research_file_workbench.workbench.service import WorkbenchService

    library = tmp_path / "library"
    WorkbenchService.create(library)
    manifest = tmp_path / "sources.json"
    manifest.write_text(
        json.dumps([{"name": "x", "kind": "unknown", "path": "y"}]), encoding="utf-8"
    )

    exit_code = cli.main(
        [
            "--library-root",
            str(library),
            "import-world",
            "--journal-id",
            "j",
            "--name",
            "n",
            "--sources-manifest",
            str(manifest),
        ]
    )

    assert exit_code == 2
    assert "不支持的来源类型" in capsys.readouterr().err
