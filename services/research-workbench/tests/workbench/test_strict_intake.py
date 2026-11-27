"""Shared Strict DOCX intake across HTTP, project storage and template adoption."""

import base64
from io import BytesIO
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

import pytest

from research_file_workbench.common.hashing import sha256_bytes
from research_file_workbench.docx.models import DocxReadError
from research_file_workbench.docx.report import READER_VERSION
from research_file_workbench.projects.models import BaselineRequest, ProjectStoreError
from research_file_workbench.projects.service import (
    create_project,
    import_captured_document,
    import_document,
    open_project,
)
from research_file_workbench.workbench.service import WorkbenchService
from research_file_workbench.workbench.template_candidate_adoption import (
    adopt_template_candidate,
)
from tests.workbench.test_server import _request
from tests.workbench.test_template_service import snapshot, upload

STRICT_WORD = "http://purl.oclc.org/ooxml/wordprocessingml/main"
WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
STRICT_DOCUMENT_CONTENT_TYPE = "application/vnd.ms-word.document.main+xml"
TRANSITIONAL_DOCUMENT_CONTENT_TYPE = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
)


def office_docx(*, strict: bool, text: str = "Strict manuscript") -> bytes:
    namespace = STRICT_WORD if strict else WORD
    content_type = STRICT_DOCUMENT_CONTENT_TYPE if strict else TRANSITIONAL_DOCUMENT_CONTENT_TYPE
    stream = BytesIO()
    with ZipFile(stream, "w", ZIP_DEFLATED) as archive:
        archive.writestr(
            "[Content_Types].xml",
            (
                '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.'
                'relationships+xml"/>'
                '<Default Extension="xml" ContentType="application/xml"/>'
                f'<Override PartName="/word/document.xml" ContentType="{content_type}"/>'
                "</Types>"
            ),
        )
        archive.writestr(
            "_rels/.rels",
            (
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/'
                'relationships"><Relationship Id="rId1" Type="http://purl.oclc.org/ooxml/'
                'officeDocument/relationships/officeDocument" Target="word/document.xml"/>'
                "</Relationships>"
            ),
        )
        archive.writestr(
            "word/document.xml",
            (
                f'<w:document xmlns:w="{namespace}"><w:body>'
                f"<w:p><w:r><w:t>{text}</w:t></w:r></w:p>"
                '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
                '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>'
                '<w:cols w:num="1"/></w:sectPr>'
                "</w:body></w:document>"
            ),
        )
        archive.writestr(
            "word/_rels/document.xml.rels",
            (
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/'
                'relationships"/>'
            ),
        )
    return stream.getvalue()


def normalize_over_http(server, content: bytes):
    return _request(
        server,
        "POST",
        "/api/docx-normalize",
        {"content_base64": base64.b64encode(content).decode("ascii")},
        server.session_token,
    )


def normalized_bytes(response) -> bytes:
    encoded = response["content_base64"]
    assert isinstance(encoded, str)
    return base64.b64decode(encoded)


def test_docx_normalize_reports_passthrough_conversion_and_typed_refusal(running_server):
    unchanged = office_docx(strict=False)
    status, response = normalize_over_http(running_server, unchanged)
    assert status == 200, response
    assert response == {
        "content_base64": None,
        "original_sha256": sha256_bytes(unchanged),
        "source_sha256": sha256_bytes(unchanged),
        "provenance": None,
    }

    strict = office_docx(strict=True)
    status, response = normalize_over_http(running_server, strict)
    assert status == 200, response
    converted = normalized_bytes(response)
    assert response["original_sha256"] == sha256_bytes(strict)
    assert response["source_sha256"] == sha256_bytes(converted)
    assert response["source_sha256"] != response["original_sha256"]
    assert response["provenance"]["converted_sha256"] == response["source_sha256"]
    assert b"purl.oclc.org/ooxml/wordprocessingml/main" not in converted

    status, refusal = normalize_over_http(running_server, b"not a Word package")
    assert status == 400
    assert refusal["error"]
    assert refusal["code"] == "invalid_docx"


def test_project_import_retains_the_original_and_uses_the_normalized_baseline(running_server):
    strict = office_docx(strict=True)
    status, project = _request(
        running_server,
        "POST",
        "/api/projects",
        {"name": "Strict manuscript", **upload(strict, "strict.docx")},
        running_server.session_token,
    )
    assert status == 200, project
    assert project["original_sha256"] == sha256_bytes(strict)

    project_root = running_server.service.project_root(project["project_id"])
    store = open_project(project_root)
    baseline = store.get_baseline()
    original_sha256 = sha256_bytes(strict)
    assert baseline["original_sha256"] == original_sha256
    assert baseline["original_artifact_version_id"] == f"artifact-version-{original_sha256}"
    assert baseline["source_sha256"] != original_sha256
    assert project["source_sha256"] == baseline["source_sha256"]
    assert baseline["provenance"]["converted_sha256"] == baseline["source_sha256"]
    assert store.read_artifact(baseline["original_artifact_version_id"]) == strict
    normalized = store.read_artifact(f"artifact-version-{baseline['source_sha256']}")
    assert b"purl.oclc.org/ooxml/wordprocessingml/main" not in normalized
    input_path = running_server.service.root / "inputs" / project["project_id"] / "manuscript.docx"
    assert input_path.read_bytes() == strict

    status, source = _request(
        running_server,
        "GET",
        f"/api/manuscript-source?project_id={project['project_id']}&baseline_id={baseline['baseline_id']}",
    )
    assert status == 200, source
    assert base64.b64decode(source["content_base64"]) == normalized


def test_project_import_surfaces_the_typed_normalization_refusal(running_server):
    status, refusal = _request(
        running_server,
        "POST",
        "/api/projects",
        {
            "name": "Invalid package",
            **upload(b"not a Word package", "invalid.docx"),
        },
        running_server.session_token,
    )
    assert status == 400, refusal
    assert refusal["code"] == "invalid_docx"


def test_browser_source_upload_normalizes_but_editor_saves_keep_their_bytes(running_server):
    first = office_docx(strict=False, text="First")
    editor_bytes = office_docx(strict=False, text="Editor revision")
    status, imported = _request(
        running_server,
        "POST",
        "/api/projects",
        {"name": "Browser upload", **upload(first, "first.docx")},
        running_server.session_token,
    )
    assert status == 200, imported
    assert imported["original_sha256"] == sha256_bytes(first)
    assert imported["source_sha256"] == sha256_bytes(first)
    strict = office_docx(strict=True, text="Browser revision")
    status, applied = _request(
        running_server,
        "POST",
        "/api/baseline",
        {
            "project_id": imported["project_id"],
            "expected_baseline_id": imported["baseline_id"],
            "filename": "browser.docx",
            "reason": "Human file selection",
            "request_id": "browser-strict-upload",
            "source_upload": True,
            **upload(strict, "browser.docx"),
        },
        running_server.session_token,
    )
    assert status == 200 and applied["status"] == "APPLIED", applied
    browser_store = open_project(running_server.service.project_root(imported["project_id"]))
    browser_baseline = browser_store.get_baseline(applied["result_baseline_id"])
    assert browser_baseline["original_sha256"] == sha256_bytes(strict)
    assert browser_baseline["original_artifact_version_id"] == (
        f"artifact-version-{sha256_bytes(strict)}"
    )
    assert browser_baseline["source_sha256"] != sha256_bytes(strict)

    status, imported = _request(
        running_server,
        "POST",
        "/api/projects",
        {"name": "Editor save", **upload(first, "editor.docx")},
        running_server.session_token,
    )
    assert status == 200, imported
    status, applied = _request(
        running_server,
        "POST",
        "/api/baseline",
        {
            "project_id": imported["project_id"],
            "expected_baseline_id": imported["baseline_id"],
            "filename": "editor.docx",
            "reason": "Editor save",
            "request_id": "editor-save",
            **upload(editor_bytes, "editor.docx"),
        },
        running_server.session_token,
    )
    assert status == 200 and applied["status"] == "APPLIED", applied
    editor_store = open_project(running_server.service.project_root(imported["project_id"]))
    editor_baseline = editor_store.get_baseline(applied["result_baseline_id"])
    assert editor_baseline["source_sha256"] == sha256_bytes(editor_bytes)
    assert "original_sha256" not in editor_baseline


def test_exact_save_refuses_raw_strict_without_storing_a_baseline(running_server):
    first = office_docx(strict=False, text="Transitional source")
    status, imported = _request(
        running_server,
        "POST",
        "/api/projects",
        {"name": "Exact save", **upload(first, "exact.docx")},
        running_server.session_token,
    )
    assert status == 200, imported

    strict = office_docx(strict=True, text="Must be normalized first")
    status, refusal = _request(
        running_server,
        "POST",
        "/api/baseline",
        {
            "project_id": imported["project_id"],
            "expected_baseline_id": imported["baseline_id"],
            "filename": "strict.docx",
            "reason": "Unnormalized editor save",
            "request_id": "exact-strict-save",
            **upload(strict, "strict.docx"),
        },
        running_server.session_token,
    )
    assert status == 400, refusal
    assert refusal["status"] == "REJECTED"

    store = open_project(running_server.service.project_root(imported["project_id"]))
    current = store.get_baseline()
    assert current["baseline_id"] == imported["baseline_id"]
    assert current["source_sha256"] == sha256_bytes(first)
    assert sha256_bytes(strict) not in {
        baseline["source_sha256"] for baseline in store.list_baselines()
    }


def test_changed_source_replay_is_bound_to_both_original_and_derivative(tmp_path: Path):
    author_root = tmp_path / "author"
    author_root.mkdir()
    project_root = tmp_path / "project"
    create_project(project_root, author_workspace_root=author_root)
    strict = office_docx(strict=True)

    first = import_captured_document(
        project_root,
        strict,
        filename="strict.docx",
        request_id="strict-source-one",
        expected_baseline_id=None,
        confirmation_reason="Retain the original Strict source",
        source_upload=True,
    )
    replay = import_captured_document(
        project_root,
        strict,
        filename="strict.docx",
        request_id="strict-source-one",
        expected_baseline_id=None,
        confirmation_reason="Recover the retained result",
        source_upload=True,
    )
    assert replay == first

    changed = import_captured_document(
        project_root,
        office_docx(strict=True, text="Different original"),
        filename="different.docx",
        request_id="strict-source-one",
        expected_baseline_id=None,
        confirmation_reason="Must not replace the request identity",
        source_upload=True,
    )
    assert changed["status"] == "IDEMPOTENCY_CONFLICT"


def test_baseline_conflict_does_not_claim_an_unstored_original_artifact(tmp_path: Path):
    author_root = tmp_path / "author"
    author_root.mkdir()
    project_root = tmp_path / "project"
    create_project(project_root, author_workspace_root=author_root)
    strict = office_docx(strict=True)

    result = import_captured_document(
        project_root,
        strict,
        filename="strict.docx",
        request_id="strict-baseline-conflict",
        expected_baseline_id="baseline-" + "0" * 32,
        confirmation_reason="Must not publish a partial source binding",
        source_upload=True,
    )

    assert result["status"] == "BASELINE_CONFLICT"
    assert "original_sha256" not in result
    assert "original_artifact_version_id" not in result
    assert "provenance" not in result
    store = open_project(project_root)
    with pytest.raises(ProjectStoreError, match="does not exist"):
        store.read_artifact(f"artifact-version-{sha256_bytes(strict)}")
    assert store.list_baselines() == []


def test_strict_source_upload_conflict_returns_409_without_original_metadata(running_server):
    initial = office_docx(strict=False, text="Initial manuscript")
    status, imported = _request(
        running_server,
        "POST",
        "/api/projects",
        {"name": "Strict conflict", **upload(initial, "initial.docx")},
        running_server.session_token,
    )
    assert status == 200, imported

    strict = office_docx(strict=True, text="Replacement manuscript")
    submitted = {
        "project_id": imported["project_id"],
        "expected_baseline_id": "baseline-" + "0" * 32,
        "filename": "replacement.docx",
        "reason": "Replace the source after a stale read",
        "request_id": "stale-strict-upload",
        "source_upload": True,
        **upload(strict, "replacement.docx"),
    }
    for _attempt in range(2):
        status, refusal = _request(
            running_server,
            "POST",
            "/api/baseline",
            submitted,
            running_server.session_token,
        )
        assert status == 409, refusal
        assert refusal["status"] == "BASELINE_CONFLICT"
        assert refusal["previous_baseline_id"] == imported["baseline_id"]
        assert "original_sha256" not in refusal
        assert "original_artifact_version_id" not in refusal
        assert "provenance" not in refusal

    store = open_project(running_server.service.project_root(imported["project_id"]))
    assert store.get_baseline()["baseline_id"] == imported["baseline_id"]
    with pytest.raises(ProjectStoreError, match="does not exist"):
        store.read_artifact(f"artifact-version-{sha256_bytes(strict)}")
    assert len(store.list_baselines()) == 1


def test_direct_project_import_refuses_raw_strict_instead_of_recording_it(tmp_path: Path):
    author_root = tmp_path / "author"
    author_root.mkdir()
    source = author_root / "strict.docx"
    strict = office_docx(strict=True)
    source.write_bytes(strict)
    project_root = tmp_path / "project"
    create_project(project_root, author_workspace_root=author_root)

    result = import_document(
        project_root,
        source,
        source_sha256=sha256_bytes(strict),
        request_id="direct-strict-import",
        expected_baseline_id=None,
        actor_id="local-operator",
        confirmation_reason="Exercise the exact source-path import",
    )

    assert result["status"] == "REJECTED"
    with pytest.raises(ProjectStoreError, match="No current reading baseline"):
        open_project(project_root).get_baseline()


def test_candidate_commit_refuses_historical_raw_strict_without_target_writes(
    tmp_path: Path,
):
    service = WorkbenchService.create(tmp_path / "library")
    target = service.import_manuscript(
        "Target", "target.docx", office_docx(strict=False, text="Transitional target")
    )
    candidate_id = "project-candidaterawstrict"
    candidate_author = service.root / "inputs" / candidate_id
    candidate_author.mkdir(parents=True)
    candidate_root = service.root / "projects" / candidate_id
    create_project(
        candidate_root,
        author_workspace_root=candidate_author,
        project_id=candidate_id,
    )
    strict = office_docx(strict=True)
    candidate = open_project(candidate_root)
    candidate_baseline = candidate.apply_baseline(
        BaselineRequest(
            project_id=candidate_id,
            actor_id="local-operator",
            request_id="raw-strict-candidate",
            expected_baseline_id=None,
            source_sha256=sha256_bytes(strict),
        ),
        source_bytes=strict,
        source_path="candidate.docx",
        confirmation_reason="Retain a historical Strict candidate fixture",
        evidence=[],
        reader_version=READER_VERSION,
    )
    assert candidate_baseline["status"] == "APPLIED"

    target_store = open_project(service.project_root(str(target["project_id"])))
    before = target_store.list_baselines()
    with pytest.raises(DocxReadError):
        adopt_template_candidate(
            service,
            {
                "project_id": target["project_id"],
                "expected_baseline_id": target["baseline_id"],
                "expected_binding_id": None,
                "candidate_project_id": candidate_id,
                "candidate_baseline_id": candidate_baseline["result_baseline_id"],
                "expected_candidate_binding_id": "binding-" + "0" * 32,
                "candidate_source_sha256": sha256_bytes(strict),
                "candidate_check_id": "candidate-check-strict",
                "request_id": "adopt-raw-strict-candidate",
            },
        )
    assert target_store.list_baselines() == before


def test_template_adoption_validates_new_strict_provenance_against_uploaded_bytes(
    running_server,
):
    strict = office_docx(strict=True)
    status, normalized = normalize_over_http(running_server, strict)
    assert status == 200, normalized
    converted = normalized_bytes(normalized)
    payload = {
        "journal_id": "template-test",
        "journal_name": "Template Test",
        "article_type": "research_article",
        "stage": "initial_submission",
        "language": "en",
        "original": upload(strict, "template.docx"),
        "normalized": {
            **upload(converted, "template.docx"),
            "provenance": normalized["provenance"],
        },
        "snapshot": snapshot(converted),
    }
    status, world = _request(
        running_server,
        "POST",
        "/api/template-world",
        payload,
        running_server.session_token,
    )
    assert status == 200, world
    assert world["template"]["original_sha256"] == sha256_bytes(strict)
    assert world["template"]["source_sha256"] == sha256_bytes(converted)
    assert world["template"]["provenance"]["converted_sha256"] == sha256_bytes(converted)

    other_docx = office_docx(strict=False, text="Another document")
    for wrong in (
        {
            **payload,
            "normalized": {
                **payload["normalized"],
                "provenance": {**normalized["provenance"], "version": "unknown"},
            },
        },
        {
            **payload,
            "normalized": {
                **upload(other_docx, "template.docx"),
                "provenance": {
                    **normalized["provenance"],
                    "converted_sha256": sha256_bytes(other_docx),
                },
            },
            "snapshot": snapshot(other_docx),
        },
    ):
        status, refusal = _request(
            running_server,
            "POST",
            "/api/template-world",
            wrong,
            running_server.session_token,
        )
        assert status == 400, refusal
        assert refusal["code"] == "docx_normalization_mismatch"
        assert "differs from its original DOCX" in refusal["error"]


def test_strict_template_copy_reuses_normalized_bytes_and_world_provenance(running_server):
    strict = office_docx(strict=True, text="Strict template")
    status, normalized = normalize_over_http(running_server, strict)
    assert status == 200, normalized
    converted = normalized_bytes(normalized)
    status, world = _request(
        running_server,
        "POST",
        "/api/template-world",
        {
            "journal_id": "template-test",
            "journal_name": "Template Test",
            "article_type": "research_article",
            "stage": "initial_submission",
            "language": "en",
            "original": upload(strict, "template.docx"),
            "normalized": {
                **upload(converted, "template.docx"),
                "provenance": normalized["provenance"],
            },
            "snapshot": snapshot(converted),
        },
        running_server.session_token,
    )
    assert status == 200, world

    status, source = _request(
        running_server,
        "GET",
        f"/api/template-source?world_version_id={world['version_id']}",
    )
    assert status == 200, source
    assert base64.b64decode(source["content_base64"]) == converted

    status, created = _request(
        running_server,
        "POST",
        "/api/template-copy",
        {
            "world_version_id": world["version_id"],
            "name": "Strict template copy",
            "request_id": "strict-template-copy",
        },
        running_server.session_token,
    )
    assert status == 200, created
    assert created["origin"]["source_sha256"] == world["template"]["source_sha256"]
    project = created["project"]
    store = open_project(running_server.service.project_root(project["project_id"]))
    baseline = store.get_baseline(project["baseline_id"])
    assert baseline["source_sha256"] == sha256_bytes(converted)
    assert "original_sha256" not in baseline
    assert store.read_artifact(f"artifact-version-{baseline['source_sha256']}") == converted
    with pytest.raises(ProjectStoreError, match="does not exist"):
        store.read_artifact(f"artifact-version-{sha256_bytes(strict)}")
    assert running_server.service.store.read_source(world["template"]["source_id"]) == strict
    assert world["template"]["provenance"] == normalized["provenance"]
