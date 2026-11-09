"""Register captured page evidence and query its immutable project-held versions."""

from pathlib import Path
from tempfile import TemporaryDirectory
from typing import cast

from research_file_workbench.common.filesystem import (
    is_within,
    require_no_reparse_points,
    require_within,
)
from research_file_workbench.common.hashing import sha256_bytes, sha256_file
from research_file_workbench.common.json_io import JsonObject, decode_json_object
from research_file_workbench.common.pdf import read_pdf_page_count
from research_file_workbench.docx.page_mapping import PAGE_MAPPING_VERSION
from research_file_workbench.docx.reader import read_docx_bytes
from research_file_workbench.docx.report import READER_VERSION
from research_file_workbench.projects.models import ProjectStoreError
from research_file_workbench.projects.render_validation import (
    BUNDLE_VERSION,
    validate_render_bundle,
)
from research_file_workbench.projects.service import open_project
from research_file_workbench.projects.store import ProjectStore


def register_render_bundle(
    project_root: Path,
    *,
    baseline_id: str,
    input_root: Path,
    render_record: Path,
    page_index: Path,
    actor_id: str,
    confirmation_reason: str,
    document_annotation: Path | None = None,
    page_evidence: Path | None = None,
) -> JsonObject:
    """Capture existing outputs read-only and atomically retain an explicit evidence version.

    Referenced files must be below input_root. The project may not be inside that read-only
    input root. This operation does not run WPS or independently attest historical reviewers.
    """
    store = open_project(project_root)
    store.get_baseline(baseline_id)
    require_no_reparse_points(input_root)
    if is_within(project_root, input_root) or is_within(input_root, project_root):
        raise ProjectStoreError("Evidence input root and writable project storage must not overlap")
    render_bytes = _capture(render_record, input_root)
    index_bytes = _capture(page_index, input_root)
    render = decode_json_object(render_bytes)
    index = decode_json_object(index_bytes)
    pdf_bytes = _capture(Path(_text(render, "output_path")), input_root)
    page_images: dict[int, bytes] = {}
    raw_pages = index.get("pages")
    if not isinstance(raw_pages, list):
        raise ProjectStoreError("Page index must contain page entries")
    for raw in raw_pages:
        page = _object(raw)
        number = page.get("page_number")
        if type(number) is not int or number < 1 or number in page_images:
            raise ProjectStoreError("Page numbers must be positive and unique")
        page_images[number] = _capture(Path(_text(page, "path")), input_root)
    if (document_annotation is None) != (page_evidence is None):
        raise ProjectStoreError("Independent document annotation and page evidence are a pair")
    annotation_bytes = (
        _capture(document_annotation, input_root) if document_annotation is not None else None
    )
    evidence_bytes = _capture(page_evidence, input_root) if page_evidence is not None else None
    return register_render_bytes(
        project_root,
        baseline_id=baseline_id,
        render_record=render_bytes,
        page_index=index_bytes,
        pdf_bytes=pdf_bytes,
        page_images=page_images,
        actor_id=actor_id,
        confirmation_reason=confirmation_reason,
        document_annotation=annotation_bytes,
        page_evidence=evidence_bytes,
    )


def register_render_bytes(
    project_root: Path,
    *,
    baseline_id: str,
    render_record: bytes,
    page_index: bytes,
    pdf_bytes: bytes,
    page_images: dict[int, bytes],
    actor_id: str,
    confirmation_reason: str,
    document_annotation: bytes | None = None,
    page_evidence: bytes | None = None,
) -> JsonObject:
    """Validate captured uploads using the same evidence contract as local registration.

    Paths within uploaded JSON remain historical labels. They are never opened by this entry.
    Original JSON bytes are retained alongside the exact supplied PDF and page images.
    """
    store = open_project(project_root)
    baseline = store.get_baseline(baseline_id)
    if (document_annotation is None) != (page_evidence is None):
        raise ProjectStoreError("Independent document annotation and page evidence are a pair")
    captures: dict[str, bytes] = {}
    artifact_refs: list[JsonObject] = []

    def retain(content: bytes, role: str, page_number: int | None = None) -> None:
        digest = sha256_bytes(content)
        version = f"artifact-version-{digest}"
        captures[version] = content
        artifact_refs.append(
            {
                "role": role,
                "kind": "rendered_pdf"
                if role == "pdf"
                else "page_image"
                if role == "page_image"
                else "file",
                "source_kind": "derived",
                "page_number": page_number,
                "version_id": version,
                "sha256": digest,
            }
        )

    for content, role in (
        (render_record, "render_record"),
        (page_index, "page_index"),
        (pdf_bytes, "pdf"),
    ):
        retain(content, role)
    for number, content in page_images.items():
        retain(content, "page_image", number)
    for optional_content, role in (
        (document_annotation, "document_annotation"),
        (page_evidence, "page_evidence"),
    ):
        if optional_content is not None:
            retain(optional_content, role)
    render = decode_json_object(render_record)
    index = decode_json_object(page_index)
    annotation = (
        decode_json_object(document_annotation) if document_annotation is not None else None
    )
    pages = decode_json_object(page_evidence) if page_evidence is not None else None
    source_version = f"artifact-version-{_text(baseline, 'source_sha256')}"
    result = read_docx_bytes(store.read_artifact(source_version), source_label=source_version)
    # Inspect captured PDF bytes, not a path that could have changed after capture.
    scratch = project_root / "var"
    require_no_reparse_points(scratch)
    require_within(scratch, project_root)
    scratch.mkdir(exist_ok=True)
    with TemporaryDirectory(prefix="pdf-inspection-", dir=scratch) as temporary:
        inspected = Path(temporary) / "captured.pdf"
        inspected.write_bytes(pdf_bytes)
        page_count = read_pdf_page_count(inspected)
    manifest = validate_render_bundle(
        result=result,
        render_record=render,
        pdf_bytes=pdf_bytes,
        pdf_page_count=page_count,
        page_index=index,
        page_images=page_images,
        document_annotation=annotation,
        page_evidence=pages,
    )
    manifest.update(
        baseline_id=baseline_id,
        artifacts=sorted(
            artifact_refs, key=lambda item: (str(item["role"]), item["page_number"] or 0)
        ),
    )
    store = open_project(project_root)
    return store.save_render_bundle(
        baseline_id=baseline_id,
        manifest=manifest,
        blobs=captures,
        actor_id=actor_id,
        confirmation_reason=confirmation_reason,
    )


def load_render_mapping(store: ProjectStore, baseline_id: str, bundle_id: str) -> JsonObject:
    """Use a selected retained mapping only when its source, methods and retained bytes agree."""
    baseline = store.get_baseline(baseline_id)
    record = store.get_render_bundle(baseline_id, bundle_id)
    manifest = _object(record["manifest"])
    if manifest.get("version") != BUNDLE_VERSION:
        raise ProjectStoreError("Unsupported render bundle method version")
    if manifest.get("source_sha256") != baseline["source_sha256"]:
        raise ProjectStoreError("Render bundle source is not the selected baseline")
    if (
        manifest.get("reader_version") != READER_VERSION
        or manifest.get("mapping_version") != PAGE_MAPPING_VERSION
    ):
        raise ProjectStoreError("Render mapping method changed; register freshly reviewed evidence")
    mapping = manifest.get("mapping")
    if not isinstance(mapping, dict):
        raise ProjectStoreError("Render bundle has no independently reviewed page mapping")
    # Retained evidence dependencies are validated even after the original files are removed.
    for reference in _references(manifest):
        content = store.read_artifact(_text(reference, "version_id"))
        if sha256_bytes(content) != reference.get("sha256"):
            raise ProjectStoreError("A retained page evidence dependency changed")
    selected = dict(mapping)
    selected["render_bundle_id"] = bundle_id
    return selected


def read_render_artifact(
    project_root: Path,
    *,
    baseline_id: str,
    bundle_id: str,
    role: str,
    page_number: int | None = None,
) -> bytes:
    """Return exact registered bytes for PDF/PNG presentation without inferring visual review.

    This internal binary accessor does not issue a model read receipt. A presentation client
    must record what it actually delivers; listing or loading bytes is not semantic review.
    """
    store = open_project(project_root)
    manifest = _object(store.get_render_bundle(baseline_id, bundle_id)["manifest"])
    matches = [
        item
        for item in _references(manifest)
        if item.get("role") == role and item.get("page_number") == page_number
    ]
    if len(matches) != 1:
        raise ProjectStoreError("The selected render artifact does not identify exactly one item")
    return store.read_artifact(_text(matches[0], "version_id"))


def _references(manifest: JsonObject) -> list[JsonObject]:
    refs = manifest.get("artifacts")
    if not isinstance(refs, list):
        raise ProjectStoreError("Render bundle artifact references are missing")
    return [_object(item) for item in refs]


def _capture(path: Path, root: Path) -> bytes:
    if not path.is_absolute():
        raise ProjectStoreError("Evidence input paths must be absolute")
    require_no_reparse_points(path)
    require_within(path, root)
    before = sha256_file(path)
    content = path.read_bytes()
    if sha256_bytes(content) != before or sha256_file(path) != before:
        raise ProjectStoreError("Evidence input changed while capturing its version")
    return content


def _object(value: object) -> JsonObject:
    if not isinstance(value, dict):
        raise ProjectStoreError("Expected a page evidence object")
    return cast(JsonObject, value)


def _text(record: JsonObject, key: str) -> str:
    value = record.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ProjectStoreError(f"Page evidence has an invalid {key}")
    return value
