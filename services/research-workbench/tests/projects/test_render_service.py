"""Persistent page evidence registration, history and read binding tests."""

import importlib
import json
import sqlite3
import struct
import subprocess
import zlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from research_file_workbench.common.filesystem import snapshot_directory
from research_file_workbench.common.hashing import sha256_bytes, sha256_file
from research_file_workbench.docx.query import ReadQuery, ReadQueryError
from research_file_workbench.docx.report import READER_VERSION
from research_file_workbench.projects.cli import main
from research_file_workbench.projects.models import ProjectStoreError
from research_file_workbench.projects.render_service import (
    RenderConversionError,
    RendererUnavailableError,
    load_render_mapping,
    read_render_artifact,
    register_render_bundle,
    render_libreoffice_baseline,
)
from research_file_workbench.projects.render_validation import BUNDLE_VERSION
from research_file_workbench.projects.service import (
    create_project,
    import_document,
    open_project,
    read_project,
)

ROOT = Path(__file__).resolve().parents[2]
SAMPLE = "s1-figures-tables"


@pytest.fixture
def rendered_project(tmp_path):
    author = tmp_path / "author"
    author.mkdir()
    source = author / "source.docx"
    source.write_bytes((ROOT / f"tests/fixtures/docx/normal/{SAMPLE}/{SAMPLE}.docx").read_bytes())
    project = tmp_path / "project"
    create_project(project, author_workspace_root=author, project_id="project-render-test")
    imported = import_document(
        project,
        source,
        source_sha256=sha256_file(source),
        request_id="request-initial",
        expected_baseline_id=None,
        actor_id="operator-test",
        confirmation_reason="Fixture import",
    )
    inputs = tmp_path / "render-inputs"
    inputs.mkdir()
    pdf = inputs / "source.pdf"
    pdf.write_bytes((ROOT / f"reports/phase0/fixtures/{SAMPLE}/{SAMPLE}.pdf").read_bytes())
    pages = []
    for number in range(1, 4):
        page = inputs / f"page-{number}.png"
        page.write_bytes(
            (ROOT / f"reports/phase0/fixtures/{SAMPLE}/pages-150dpi/page-{number}.png").read_bytes()
        )
        pages.append(
            {
                "page_number": number,
                "path": page.as_posix(),
                "sha256": sha256_file(page),
                "parse_status": "unverified",
            }
        )
    # Synthetic historical process metadata tests validation; it is not a WPS execution claim.
    render = {
        "report_version": "1.1.0",
        "source_sha256": sha256_file(source),
        "render_copy_sha256": sha256_file(source),
        "source_unchanged": True,
        "output_path": pdf.as_posix(),
        "output_sha256": sha256_file(pdf),
        "output_size": pdf.stat().st_size,
        "render_profile_id": "wps-writer-12.1.0.28505",
        "renderer_identity_status": "process_verified",
        "renderer_path": "C:/fixture/wps.exe",
        "renderer_sha256": "a" * 64,
        "renderer_file_version": "12.1.0.28505",
        "renderer_process_id": 123,
        "renderer_start_time_utc": "2026-09-24T00:00:00Z",
        "source_path": source.as_posix(),
        "render_copy_path": "C:/fixture/render-copy.docx",
        "export_method": "Synthetic fixture record",
        "task_id": "fixture-render-task",
        "application_exit_requested": False,
    }
    index = {
        "version": "s1-page-evidence-index-1.0.0",
        "status": "unverified",
        "pdf_sha256": sha256_file(pdf),
        "render_profile_id": render["render_profile_id"],
        "page_count": 3,
        "pages": pages,
    }
    (inputs / "render.json").write_text(json.dumps(render), encoding="utf-8")
    (inputs / "index.json").write_text(json.dumps(index), encoding="utf-8")
    for filename in ("document-annotation.json", "page-evidence.json"):
        (inputs / filename).write_bytes((ROOT / f"annotations/s1/{SAMPLE}/{filename}").read_bytes())
    return project, author, source, inputs, imported["result_baseline_id"]


def register(fixture, *, reviewed=True):
    project, _, _, inputs, baseline = fixture
    return register_render_bundle(
        project,
        baseline_id=baseline,
        input_root=inputs,
        render_record=inputs / "render.json",
        page_index=inputs / "index.json",
        document_annotation=inputs / "document-annotation.json" if reviewed else None,
        page_evidence=inputs / "page-evidence.json" if reviewed else None,
        actor_id="operator-test",
        confirmation_reason="Register the fixture evidence version",
    )


def test_libreoffice_render_retains_readable_pdf_without_fabricating_page_mapping(
    rendered_project, tmp_path
):
    project, _, source, _, baseline = rendered_project
    fixture_pdf = (
        ROOT / "reports/phase0/fixtures/s1-figures-tables/s1-figures-tables.pdf"
    ).read_bytes()
    executable = tmp_path / "LibreOffice"
    executable.write_bytes(b"fake LibreOffice executable")
    executable.chmod(0o755)
    profile = tmp_path / "libreoffice-profile"
    calls: list[list[str]] = []

    def runner(command: list[str], timeout: int) -> subprocess.CompletedProcess[bytes]:
        assert timeout == 120
        calls.append(command)
        if command[1:] == ["--version"]:
            return subprocess.CompletedProcess(command, 0, b"LibreOffice 25.2\n", b"")
        output_root = Path(command[command.index("--outdir") + 1])
        (output_root / "baseline.pdf").write_bytes(fixture_pdf)
        return subprocess.CompletedProcess(
            command, 0, b"convert /baseline.docx -> /baseline.pdf", b""
        )

    same_source = source.with_name("same-source.docx")
    same_source.write_bytes(source.read_bytes())
    source.unlink()
    record = render_libreoffice_baseline(
        project,
        baseline_id=baseline,
        executable=executable,
        profile=profile,
        actor_id="operator-test",
        confirmation_reason="Render the saved baseline",
        surface="browser",
        runner=runner,
    )

    manifest = record["manifest"]
    assert manifest["version"] == BUNDLE_VERSION
    assert manifest["evidence_kind"] == "derived_pdf"
    assert manifest["mapping"] is None
    assert manifest["mapping_status"] == "pending_independent_review"
    assert manifest["pages"] == []
    assert manifest["render_record"]["renderer_engine"] == "LibreOffice"
    assert manifest["render_record"]["renderer_identity_status"] == "executable_hash_verified"
    assert manifest["render_record"]["libreoffice_profile_parent"] == profile.resolve().as_posix()
    assert Path(manifest["render_record"]["libreoffice_profile"]).parent == profile.resolve()
    assert len(calls) == 2
    assert calls[0][1:] == ["--version"]
    assert "--headless" in calls[1]
    assert (
        read_render_artifact(
            project,
            baseline_id=baseline,
            bundle_id=record["bundle_id"],
            role="pdf",
        )
        == fixture_pdf
    )
    store = open_project(project)
    assert store.list_render_bundles() == []
    assert store.list_derived_renders(baseline) == [record]
    derived = next(
        item
        for item in store.list_evidence(baseline, reader_version=manifest["reader_version"])
        if item["evidence_version"] == record["bundle_id"]
    )
    assert derived["kind"] == "derived_render"
    assert derived["scope"] == {"object_type": "derived_render"}
    assert derived["verification_status"] == "NOT_REVIEWED"
    assert list(project.glob("var/libreoffice-render-*")) == []
    changed = import_document(
        project,
        same_source,
        source_sha256=sha256_file(same_source),
        request_id="request-rebaseline-render",
        expected_baseline_id=baseline,
        actor_id="operator-test",
        confirmation_reason="Confirm a separate same-source baseline",
    )
    historical = next(
        item
        for item in store.list_evidence(baseline, reader_version=manifest["reader_version"])
        if item["evidence_version"] == record["bundle_id"]
    )
    assert changed["result_baseline_id"] != baseline
    assert historical["applicability_to_current_baseline"] == "STALE"
    assert historical["stale_reasons"] == ["baseline_binding_changed"]
    assert list(profile.glob("profile-*")) == []


def test_missing_libreoffice_is_a_typed_capability_failure(rendered_project, tmp_path):
    project, _, _, _, baseline = rendered_project
    before = open_project(project).list_evidence(baseline, reader_version=READER_VERSION)

    with pytest.raises(RendererUnavailableError) as unavailable:
        render_libreoffice_baseline(
            project,
            baseline_id=baseline,
            executable=tmp_path / "missing-soffice",
            profile=tmp_path / "profile",
            actor_id="operator-test",
            confirmation_reason="Render with missing capability",
            surface="browser",
        )

    assert unavailable.value.code == "renderer_unavailable"
    assert open_project(project).list_evidence(baseline, reader_version=READER_VERSION) == before


def test_libreoffice_failure_never_registers_a_partial_render(rendered_project, tmp_path):
    project, _, _, _, baseline = rendered_project
    executable = tmp_path / "LibreOffice"
    executable.write_bytes(b"fake LibreOffice executable")
    executable.chmod(0o755)

    def runner(command: list[str], timeout: int) -> subprocess.CompletedProcess[bytes]:
        if command[1:] == ["--version"]:
            return subprocess.CompletedProcess(command, 0, b"LibreOffice 25.2\n", b"")
        return subprocess.CompletedProcess(command, 7, b"", b"conversion failed")

    with pytest.raises(RenderConversionError) as failed:
        render_libreoffice_baseline(
            project,
            baseline_id=baseline,
            executable=executable,
            profile=tmp_path / "profile",
            actor_id="operator-test",
            confirmation_reason="Render a failing conversion",
            surface="browser",
            runner=runner,
        )

    assert failed.value.code == "render_failed"
    assert open_project(project).list_render_bundles() == []
    assert open_project(project).list_derived_renders(baseline) == []


def test_unreadable_pdf_is_a_conversion_failure_without_registration(rendered_project, tmp_path):
    project, _, _, _, baseline = rendered_project
    executable = tmp_path / "LibreOffice"
    executable.write_bytes(b"fake LibreOffice executable")
    executable.chmod(0o755)

    def runner(command: list[str], timeout: int) -> subprocess.CompletedProcess[bytes]:
        if command[1:] == ["--version"]:
            return subprocess.CompletedProcess(command, 0, b"LibreOffice 25.2\n", b"")
        output_root = Path(command[command.index("--outdir") + 1])
        (output_root / "baseline.pdf").write_bytes(b"%PDF-1.7\nnot a readable PDF")
        return subprocess.CompletedProcess(command, 0, b"converted", b"")

    with pytest.raises(RenderConversionError) as failed:
        render_libreoffice_baseline(
            project,
            baseline_id=baseline,
            executable=executable,
            profile=tmp_path / "profile",
            actor_id="operator-test",
            confirmation_reason="Render unreadable output",
            surface="browser",
            runner=runner,
        )

    assert failed.value.code == "render_failed"
    assert str(failed.value) == "LibreOffice output is not a readable PDF."
    assert open_project(project).list_derived_renders(baseline) == []


def test_bundle_persists_pdf_png_annotations_and_reads_after_inputs_deleted(rendered_project):
    project, author, _, inputs, baseline = rendered_project
    before = snapshot_directory(author)
    input_before = snapshot_directory(inputs)
    pdf = (inputs / "source.pdf").read_bytes()
    page = (inputs / "page-1.png").read_bytes()
    record = register(rendered_project)
    assert record["manifest"]["mapping_status"] == "reviewed"
    assert snapshot_directory(author) == before
    assert snapshot_directory(inputs) == input_before
    for path in inputs.iterdir():
        path.unlink()
    assert (
        read_render_artifact(
            project, baseline_id=baseline, bundle_id=record["bundle_id"], role="pdf"
        )
        == pdf
    )
    assert (
        read_render_artifact(
            project,
            baseline_id=baseline,
            bundle_id=record["bundle_id"],
            role="page_image",
            page_number=1,
        )
        == page
    )
    response = read_project(
        project, ReadQuery(page_number=1, object_type="image"), render_bundle_id=record["bundle_id"]
    )
    assert len(response["items"]) == 2
    assert response["status"] == "partial"
    assert response["read_receipt"]["returned_versions"] == [response["source"]["version_id"]]
    assert record["bundle_id"] in response["read_receipt"]["dependencies"]
    assert open_project(project).get_read(response["read_receipt"]["read_record_id"]) == response


def test_duplicate_registration_is_idempotent_without_read_or_baseline_change(rendered_project):
    project, _, _, _, baseline = rendered_project
    first = register(rendered_project)
    second = register(rendered_project)
    assert first == second
    assert len(open_project(project).list_render_bundles()) == 1
    assert open_project(project).info()["current_baseline_id"] == baseline
    assert open_project(project).list_reads() == []


def test_same_source_rebaseline_invalidates_only_baseline_bound_render_evidence(rendered_project):
    project, _, source, inputs, baseline = rendered_project
    record = register(rendered_project)
    original_response = read_project(
        project, ReadQuery(page_number=1, object_type="image"), render_bundle_id=record["bundle_id"]
    )
    changed = import_document(
        project,
        source,
        source_sha256=sha256_file(source),
        request_id="request-same-source",
        expected_baseline_id=baseline,
        actor_id="operator-test",
        confirmation_reason="Confirm the same source under a separate baseline",
    )
    store = open_project(project)
    old_evidence = store.list_evidence(
        baseline, reader_version=record["manifest"]["reader_version"]
    )
    bundle = next(item for item in old_evidence if item["evidence_version"] == record["bundle_id"])
    assert bundle["applicability_to_current_baseline"] == "STALE"
    assert bundle["stale_reasons"] == ["baseline_binding_changed"]
    assert changed["invalidated_refs"] == [record["bundle_id"]]
    observations = [item for item in old_evidence if item is not bundle]
    assert observations and all(
        item["applicability_to_current_baseline"] == "CURRENT" for item in observations
    )
    with pytest.raises(ProjectStoreError, match="not registered for this baseline"):
        read_project(project, ReadQuery(page_number=1), render_bundle_id=record["bundle_id"])
    assert len(store.list_reads()) == 1
    historical = read_project(
        project,
        ReadQuery(page_number=1, object_type="image"),
        baseline_id=baseline,
        render_bundle_id=record["bundle_id"],
    )
    assert historical["items"] == original_response["items"]
    assert store.get_read(original_response["read_receipt"]["read_record_id"]) == original_response
    replacement = register_render_bundle(
        project,
        baseline_id=changed["result_baseline_id"],
        input_root=inputs,
        render_record=inputs / "render.json",
        page_index=inputs / "index.json",
        document_annotation=inputs / "document-annotation.json",
        page_evidence=inputs / "page-evidence.json",
        actor_id="operator-test",
        confirmation_reason="Bind retained evidence to the selected baseline",
    )
    assert replacement["bundle_id"] != record["bundle_id"]
    assert read_project(
        project, ReadQuery(page_number=1), render_bundle_id=replacement["bundle_id"]
    )["items"]


def test_undecodable_page_image_cannot_publish_bundle_or_artifacts(rendered_project):
    project, author, _, inputs, _ = rendered_project
    image_path = inputs / "page-1.png"
    original = image_path.read_bytes()
    payload = b"IDATnot-a-zlib-stream"
    corrupt_image = (
        original[:33]
        + struct.pack(">I", len(payload) - 4)
        + payload
        + struct.pack(">I", zlib.crc32(payload))
        + original[-12:]
    )
    image_path.write_bytes(corrupt_image)
    index_path = inputs / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8"))
    index["pages"][0]["sha256"] = sha256_bytes(corrupt_image)
    index_path.write_text(json.dumps(index), encoding="utf-8")
    author_before = snapshot_directory(author)
    inputs_before = snapshot_directory(inputs)
    with sqlite3.connect(project / "project.sqlite3") as connection:
        artifacts_before = connection.execute("SELECT count(*) FROM artifact").fetchone()[0]
    with pytest.raises(ProjectStoreError, match="cannot be decompressed"):
        register(rendered_project)
    with sqlite3.connect(project / "project.sqlite3") as connection:
        assert connection.execute("SELECT count(*) FROM artifact").fetchone()[0] == artifacts_before
    assert open_project(project).list_render_bundles() == []
    assert snapshot_directory(author) == author_before
    assert snapshot_directory(inputs) == inputs_before
    assert list(project.glob(".pdf-inspection-*")) == []


def test_concurrent_identical_registration_commits_one_bundle(rendered_project):
    project, _, _, _, baseline = rendered_project
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(register, rendered_project) for _ in range(2)]
        results = [future.result(timeout=30) for future in futures]
    assert results[0] == results[1]
    assert len(open_project(project).list_render_bundles(baseline)) == 1
    assert len(open_project(project).list_baselines()) == 1
    assert list(project.glob(".pdf-inspection-*")) == []


def test_unreviewed_bundle_is_retained_but_page_selection_is_refused(rendered_project):
    project, _, _, _, _ = rendered_project
    record = register(rendered_project, reviewed=False)
    assert record["manifest"]["mapping_status"] == "pending_independent_review"
    with pytest.raises(ProjectStoreError, match="independently reviewed"):
        read_project(project, ReadQuery(page_number=1), render_bundle_id=record["bundle_id"])
    assert open_project(project).list_reads() == []


def test_wrong_source_and_unreviewed_annotations_never_create_bundle(rendered_project):
    project, _, _, inputs, _ = rendered_project
    render_path = inputs / "render.json"
    render = json.loads(render_path.read_text(encoding="utf-8"))
    render["source_sha256"] = "0" * 64
    render_path.write_text(json.dumps(render), encoding="utf-8")
    with pytest.raises(ProjectStoreError):
        register(rendered_project)
    assert open_project(project).list_render_bundles() == []
    assert list(project.glob(".pdf-inspection-*")) == []


def test_bundle_requires_explicit_baseline_and_never_follows_new_source(rendered_project):
    project, _, source, _, baseline = rendered_project
    record = register(rendered_project)
    other = ROOT / "tests/fixtures/docx/normal/s1-regions-fields/s1-regions-fields.docx"
    source.write_bytes(other.read_bytes())
    import_document(
        project,
        source,
        source_sha256=sha256_file(source),
        request_id="request-update",
        expected_baseline_id=baseline,
        actor_id="operator-test",
        confirmation_reason="Fixture revision",
    )
    with pytest.raises(ProjectStoreError, match="not registered"):
        read_project(project, ReadQuery(page_number=1), render_bundle_id=record["bundle_id"])
    response = read_project(
        project,
        ReadQuery(page_number=1, object_type="image"),
        baseline_id=baseline,
        render_bundle_id=record["bundle_id"],
    )
    assert response["project"]["baseline_is_current"] is False


def test_another_bundle_cannot_reuse_page_cursor(rendered_project):
    project, _, _, inputs, _ = rendered_project
    first = register(rendered_project)
    response = read_project(
        project, ReadQuery(page_number=1, page_size=1), render_bundle_id=first["bundle_id"]
    )
    path = inputs / "page-evidence.json"
    annotation = json.loads(path.read_text(encoding="utf-8"))
    annotation["limitations"].append("Independent second audit record")
    path.write_text(json.dumps(annotation), encoding="utf-8")
    second = register(rendered_project)
    assert second["bundle_id"] != first["bundle_id"]
    with pytest.raises(ReadQueryError, match="Cursor"):
        read_project(
            project,
            ReadQuery(page_number=1, page_size=1, cursor=response["pagination"]["next_cursor"]),
            render_bundle_id=second["bundle_id"],
        )


def test_tampered_blob_or_manifest_is_refused(rendered_project):
    project, _, _, _, baseline = rendered_project
    record = register(rendered_project)
    digest = record["manifest"]["pdf_sha256"]
    with sqlite3.connect(project / "project.sqlite3") as connection:
        connection.execute("UPDATE artifact SET content=? WHERE sha256=?", (b"corrupt", digest))
    with pytest.raises(ProjectStoreError, match="immutable version"):
        load_render_mapping(open_project(project), baseline, record["bundle_id"])
    assert open_project(project).list_reads() == []


def test_tampered_manifest_is_not_returned_as_registered_evidence(rendered_project):
    project, _, _, _, baseline = rendered_project
    record = register(rendered_project)
    with sqlite3.connect(project / "project.sqlite3") as connection:
        payload = json.loads(
            connection.execute(
                "SELECT payload FROM evidence WHERE evidence_version=?", (record["bundle_id"],)
            ).fetchone()[0]
        )
        payload["value"]["manifest"]["page_count"] = 999
        connection.execute(
            "UPDATE evidence SET payload=? WHERE evidence_version=?",
            (json.dumps(payload), record["bundle_id"]),
        )
    with pytest.raises(ProjectStoreError, match="content or binding changed"):
        open_project(project).get_render_bundle(baseline, record["bundle_id"])


def test_render_list_and_binary_accessor_do_not_claim_visual_read(rendered_project):
    project, _, _, _, baseline = rendered_project
    record = register(rendered_project)
    open_project(project).list_render_bundles(baseline)
    read_render_artifact(
        project,
        baseline_id=baseline,
        bundle_id=record["bundle_id"],
        role="page_image",
        page_number=1,
    )
    assert open_project(project).list_reads() == []


def test_render_registration_transaction_failure_keeps_no_partial_blobs(rendered_project):
    project, _, _, _, _ = rendered_project
    with sqlite3.connect(project / "project.sqlite3") as connection:
        count = connection.execute("SELECT COUNT(*) FROM artifact").fetchone()[0]
        connection.execute(
            "CREATE TRIGGER fail_render BEFORE INSERT ON baseline_evidence "
            "BEGIN SELECT RAISE(ABORT,'registration failure'); END"
        )
    with pytest.raises(ProjectStoreError, match="registration failure"):
        register(rendered_project)
    with sqlite3.connect(project / "project.sqlite3") as connection:
        assert connection.execute("SELECT COUNT(*) FROM artifact").fetchone()[0] == count
    assert open_project(project).list_render_bundles() == []


def test_mapping_method_change_is_stale_in_listing_and_refused_for_page_query(
    rendered_project, monkeypatch
):
    project, _, _, _, baseline = rendered_project
    record = register(rendered_project)
    module = importlib.import_module("research_file_workbench.docx.page_mapping")
    monkeypatch.setattr(module, "PAGE_MAPPING_VERSION", "s1-page-mapping-future")
    evidence = open_project(project).list_evidence(
        baseline, reader_version=record["manifest"]["reader_version"]
    )
    bundle = next(item for item in evidence if item["evidence_version"] == record["bundle_id"])
    assert bundle["applicability_to_current_baseline"] == "STALE"
    assert "mapping_method_changed" in bundle["stale_reasons"]


def test_render_input_cannot_direct_capture_outside_declared_root(rendered_project, tmp_path):
    project, _, _, inputs, _ = rendered_project
    pdf = tmp_path / "outside.pdf"
    pdf.write_bytes((inputs / "source.pdf").read_bytes())
    path = inputs / "render.json"
    metadata = json.loads(path.read_text(encoding="utf-8"))
    metadata["output_path"] = pdf.as_posix()
    path.write_text(json.dumps(metadata), encoding="utf-8")
    with pytest.raises(ValueError, match="outside declared root"):
        register(rendered_project)
    assert open_project(project).list_render_bundles() == []


def test_store_rejects_wrong_page_bundle_binding_without_receipt(rendered_project):
    project, _, _, _, baseline = rendered_project
    record = register(rendered_project)
    response = read_project(
        project, ReadQuery(page_number=1, object_type="image"), render_bundle_id=record["bundle_id"]
    )
    response["render_bundle"]["pdf_sha256"] = "0" * 64
    response["read_receipt"]["task_id"] = "task-false-bundle"
    task = {
        "task_id": "task-false-bundle",
        "baseline_id": baseline,
        "scope": response["query_scope"],
        "status": "partial",
        "actual_read_ranges": response["read_receipt"]["ranges"],
        "unresolved_items": [],
    }
    with pytest.raises(ProjectStoreError, match="binding differs"):
        open_project(project).save_read(
            baseline_id=baseline, require_current=True, task=task, response=response
        )
    assert len(open_project(project).list_reads()) == 1


def test_page_read_cli_records_partial_and_bundle_dependency(rendered_project, capsys):
    project, _, _, _, _ = rendered_project
    record = register(rendered_project)
    prefix = ["--project-root", str(project)]
    assert main([*prefix, "renders"]) == 0
    assert len(json.loads(capsys.readouterr().out)["render_bundles"]) == 1
    assert (
        main(
            [
                *prefix,
                "read",
                "--page-number",
                "1",
                "--render-bundle-id",
                record["bundle_id"],
                "--object-type",
                "image",
            ]
        )
        == 1
    )
    response = json.loads(capsys.readouterr().out)
    assert record["bundle_id"] == response["render_bundle"]["bundle_id"]
