"""Exercise local query delivery against actual S1 runs and unchanged author inputs."""

import importlib
import json
from pathlib import Path

import pytest

from research_file_workbench.common.filesystem import PathBoundaryError, snapshot_directory
from research_file_workbench.common.hashing import sha256_file
from research_file_workbench.docx.pipeline import run_s1_readonly
from research_file_workbench.docx.query import ReadQuery, ReadQueryError
from research_file_workbench.docx.query_cli import main
from research_file_workbench.docx.query_run import catalog_run, query_run
from research_file_workbench.docx.read_receipt import load_read_receipt

ROOT = Path(__file__).resolve().parents[2]
SAMPLE_ID = "s1-figures-tables"


@pytest.fixture
def local_run(tmp_path: Path):
    author = tmp_path / "author"
    author.mkdir()
    source = author / "manuscript.docx"
    source.write_bytes(
        (ROOT / f"tests/fixtures/docx/normal/{SAMPLE_ID}/{SAMPLE_ID}.docx").read_bytes()
    )
    app = tmp_path / "app"
    run = app / "run"
    run_s1_readonly(
        source,
        application_root=app,
        output_directory=run,
        author_workspace_root=author,
    )
    return app, author, run


def read(local_run, query=None, *, output_name="response"):
    app, author, run = local_run
    return query_run(
        run,
        query if query is not None else ReadQuery(),
        application_root=app,
        author_workspace_root=author,
        output_directory=app / output_name,
    )


def test_query_persists_exact_returned_content_and_receipt_without_source_changes(local_run):
    app, author, run = local_run
    before = snapshot_directory(author)
    before_run = snapshot_directory(run)

    response = read(local_run, ReadQuery(object_type="image", page_size=1))

    saved = json.loads((app / "response/response.json").read_text(encoding="utf-8"))
    receipt = load_read_receipt(app / "response/read-receipt.json")
    assert saved == response
    assert receipt.to_json() == saved["read_receipt"]
    assert len(receipt.ranges) == len(response["items"]) == 1
    assert receipt.truncation is True
    assert receipt.pagination.has_more is True
    assert snapshot_directory(author) == before
    assert snapshot_directory(run) == before_run


def test_query_does_not_reopen_author_document(local_run):
    app, author, _ = local_run
    (author / "manuscript.docx").unlink()

    response = read(local_run, ReadQuery(object_type="image"))

    assert len(response["items"]) == 2
    assert list(author.iterdir()) == []
    assert (app / "response/read-receipt.json").is_file()


def test_catalog_writes_nothing_and_does_not_record_a_read(local_run):
    app, author, run = local_run
    before = snapshot_directory(app)

    catalog = catalog_run(run, application_root=app, author_workspace_root=author)

    assert "read_receipt" not in catalog
    assert snapshot_directory(app) == before


def test_old_workspace_evidence_does_not_claim_attribute_protection(local_run):
    app, _, run = local_run
    path = run / "workspace-comparison.json"
    comparison = json.loads(path.read_text(encoding="utf-8"))
    comparison["report_version"] = "1.0.0"
    path.write_text(json.dumps(comparison), encoding="utf-8")
    with pytest.raises(ReadQueryError, match="protection evidence is incompatible"):
        read(local_run)
    assert not (app / "response").exists()


def test_changed_workspace_protection_refuses_even_if_content_hashes_match(local_run):
    app, _, run = local_run
    path = run / "workspace-comparison.json"
    comparison = json.loads(path.read_text(encoding="utf-8"))
    comparison["after_protection_sha256"] = "0" * 64
    path.write_text(json.dumps(comparison), encoding="utf-8")
    with pytest.raises(ReadQueryError, match="protection attributes"):
        read(local_run)
    assert not (app / "response").exists()


def test_snapshot_hash_drift_refuses_before_output_creation(local_run):
    app, _, run = local_run
    snapshot = run / "snapshot/manuscript.docx"
    snapshot.write_bytes(snapshot.read_bytes() + b"changed")

    with pytest.raises(ReadQueryError, match="hash changed"):
        read(local_run)
    assert not (app / "response").exists()


@pytest.mark.parametrize(
    "field,value", [("status", "failed"), ("author_workspace_unchanged", False)]
)
def test_failed_run_refuses_before_output_creation(local_run, field, value):
    app, _, run = local_run
    path = run / "run-report.json"
    report = json.loads(path.read_text(encoding="utf-8"))
    report[field] = value
    path.write_text(json.dumps(report), encoding="utf-8")

    with pytest.raises(ReadQueryError):
        read(local_run)
    assert not (app / "response").exists()


def test_run_cannot_redirect_snapshot_outside_owned_run(local_run):
    app, author, run = local_run
    path = run / "run-report.json"
    report = json.loads(path.read_text(encoding="utf-8"))
    report["source"]["snapshot_path"] = (author / "manuscript.docx").as_posix()
    path.write_text(json.dumps(report), encoding="utf-8")

    with pytest.raises(PathBoundaryError):
        read(local_run)
    assert not (app / "response").exists()


def test_misdeclared_author_root_cannot_allow_output_beside_original(local_run):
    app, author, run = local_run
    with pytest.raises(ReadQueryError, match="Author workspace root differs"):
        query_run(
            run,
            ReadQuery(),
            application_root=app.parent,
            author_workspace_root=app.parent / "wrong-author",
            output_directory=author / "response",
        )
    assert not (author / "response").exists()


def test_receipt_write_failure_does_not_publish_partial_delivery(local_run, monkeypatch):
    app, _, _ = local_run
    module = importlib.import_module("research_file_workbench.docx.query_run")

    def failed_write(*args, **kwargs):
        raise OSError("simulated storage failure")

    monkeypatch.setattr(module, "write_read_receipt", failed_write)
    with pytest.raises(OSError, match="simulated storage failure"):
        read(local_run)
    assert not (app / "response").exists()
    assert list(app.glob(".s1-query-*")) == []


def test_invalid_query_creates_no_receipt(local_run):
    app, _, _ = local_run
    with pytest.raises(ReadQueryError):
        read(local_run, ReadQuery(object_id="not-an-object"))
    assert not (app / "response").exists()


def test_output_cannot_overwrite_or_touch_author_workspace(local_run):
    app, author, run = local_run
    read(local_run)
    before = snapshot_directory(app / "response")
    with pytest.raises(FileExistsError):
        read(local_run)
    assert snapshot_directory(app / "response") == before
    with pytest.raises(PathBoundaryError):
        query_run(
            run,
            ReadQuery(),
            application_root=app,
            author_workspace_root=author,
            output_directory=author / "response",
        )
    assert not (author / "response").exists()


def test_missing_mapping_refuses_page_query_without_false_receipt(local_run):
    app, _, _ = local_run
    with pytest.raises(ReadQueryError, match="independent page mapping"):
        read(local_run, ReadQuery(page_number=1))
    assert not (app / "response").exists()


@pytest.fixture
def mapped_run(local_run):
    """Use recorded fixture evidence; the test does not launch or attest a WPS process."""
    app, author, _ = local_run
    pdf = app / "fixture.pdf"
    pdf.write_bytes((ROOT / f"reports/phase0/fixtures/{SAMPLE_ID}/{SAMPLE_ID}.pdf").read_bytes())
    source = author / "manuscript.docx"
    render = app / "fixture-render-record.json"
    render.write_text(
        json.dumps(
            {
                "source_sha256": sha256_file(source),
                "output_path": pdf.as_posix(),
                "output_sha256": sha256_file(pdf),
                "renderer_identity_status": "process_verified",
                "render_profile_id": "wps-writer-12.1.0.28505",
            }
        ),
        encoding="utf-8",
    )
    run = app / "mapped-run"
    run_s1_readonly(
        source,
        application_root=app,
        output_directory=run,
        author_workspace_root=author,
        document_annotation=ROOT / f"annotations/s1/{SAMPLE_ID}/document-annotation.json",
        page_evidence=ROOT / f"annotations/s1/{SAMPLE_ID}/page-evidence.json",
        render_record=render,
    )
    return app, author, run


def test_page_query_uses_bound_fixture_pdf_and_preserves_coverage_gaps(mapped_run):
    response = read(mapped_run, ReadQuery(page_number=1, object_type="image"))
    assert response["items"]
    assert all(item["object_type"] == "image" for item in response["items"])
    assert response["coverage_gaps"]
    assert response["status"] == "partial"


def test_physical_pdf_page_count_limits_query(mapped_run):
    app, _, _ = mapped_run
    with pytest.raises(ReadQueryError):
        read(mapped_run, ReadQuery(page_number=4))
    assert not (app / "response").exists()


def test_pdf_drift_refuses_page_query(mapped_run):
    app, _, _ = mapped_run
    pdf = app / "fixture.pdf"
    pdf.write_bytes(pdf.read_bytes() + b"different-version")
    with pytest.raises(ReadQueryError, match="PDF hash changed"):
        read(mapped_run, ReadQuery(page_number=1))
    assert not (app / "response").exists()


def test_mapping_from_another_pdf_is_rejected(mapped_run):
    app, _, run = mapped_run
    path = run / "page-mapping-report.json"
    mapping = json.loads(path.read_text(encoding="utf-8"))
    mapping["pdf_sha256"] = "0" * 64
    path.write_text(json.dumps(mapping), encoding="utf-8")
    with pytest.raises(ReadQueryError, match="does not match"):
        read(mapped_run, ReadQuery(page_number=1))
    assert not (app / "response").exists()


def test_unsupported_mapping_version_is_rejected(mapped_run):
    app, _, run = mapped_run
    path = run / "page-mapping-report.json"
    mapping = json.loads(path.read_text(encoding="utf-8"))
    mapping["version"] = "unsupported-mapping-version"
    path.write_text(json.dumps(mapping), encoding="utf-8")
    with pytest.raises(ReadQueryError, match="version"):
        read(mapped_run, ReadQuery(page_number=1))
    assert not (app / "response").exists()


def test_page_query_rejects_structure_report_from_another_snapshot(mapped_run):
    app, _, run = mapped_run
    path = run / "structure-report.json"
    structure = json.loads(path.read_text(encoding="utf-8"))
    structure["source"]["sha256"] = "0" * 64
    path.write_text(json.dumps(structure), encoding="utf-8")
    with pytest.raises(ReadQueryError, match="another snapshot"):
        read(mapped_run, ReadQuery(page_number=1))
    assert not (app / "response").exists()


def test_existing_response_cannot_be_reached_through_symlink(local_run):
    app, _, _ = local_run
    target = app / "responses"
    target.mkdir()
    link = app / "linked-responses"
    try:
        link.symlink_to(target, target_is_directory=True)
    except OSError:
        pytest.skip("Symlinks are unavailable in this environment")
    with pytest.raises(PathBoundaryError, match="Reparse-point"):
        read(local_run, output_name="linked-responses/query")
    assert list(target.iterdir()) == []


def test_cli_exit_codes_follow_selection_delivery_not_coverage(local_run, capsys):
    app, author, run = local_run
    args = [str(run), "--application-root", str(app), "--author-workspace-root", str(author)]
    assert main([*args, "catalog"]) == 0
    catalog = json.loads(capsys.readouterr().out)
    assert "read_receipt" not in catalog
    assert "selection_delivery" not in catalog

    assert (
        main([*args, "read", "--output-directory", str(app / "whole"), "--page-size", "1000"]) == 0
    )
    whole = json.loads(capsys.readouterr().out)
    assert whole["selection_delivery"] == "continuation_exhausted"
    assert whole["status"] == "partial"
    assert whole["pagination"]["has_more"] is False
    assert whole["read_receipt"]["truncation"] is False

    assert (
        main([*args, "read", "--output-directory", str(app / "cli-response"), "--page-size", "1"])
        == 1
    )
    response = json.loads(capsys.readouterr().out)
    assert len(response["items"]) == 1
    assert response["status"] == "partial"
    assert response["selection_delivery"] == "continuation_available"
    assert response["read_receipt"]["truncation"] is True
    assert (
        main([*args, "read", "--output-directory", str(app / "refused"), "--page-number", "1"]) == 2
    )
    assert "S1_QUERY_FAILED" in capsys.readouterr().err
    assert not (app / "refused").exists()


@pytest.mark.parametrize(
    "response",
    [
        pytest.param({"status": "partial", "pagination": {"has_more": False}}, id="missing-value"),
        pytest.param(
            {"status": "partial", "selection_delivery": ["continuation_exhausted"]},
            id="unhashable-value",
        ),
        pytest.param({"status": "partial", "selection_delivery": "delivered"}, id="undeclared"),
        pytest.param(["not", "an", "object"], id="not-an-object"),
    ],
)
def test_cli_refuses_a_response_without_a_readable_continuation_state(
    local_run, capsys, monkeypatch, response
):
    """An unreadable continuation state is a refusal, never the continuation exit code.

    Exit 1 asserts that a continuation is available, so a response this command cannot read must be
    refused with 2 rather than letting a lookup or membership error escape the process as exit 1.
    """
    app, author, run = local_run
    args = [str(run), "--application-root", str(app), "--author-workspace-root", str(author)]
    monkeypatch.setattr(
        "research_file_workbench.docx.query_cli.query_run",
        lambda *arguments, **keywords: response,
    )

    code = main([*args, "read", "--output-directory", str(app / "unreadable"), "--page-size", "1"])
    captured = capsys.readouterr()

    assert code == 2
    assert "S1_QUERY_FAILED" in captured.err
    assert captured.out == ""
