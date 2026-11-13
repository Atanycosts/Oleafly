"""Register captured page evidence and query its immutable project-held versions."""

import os
import shutil
import subprocess
import time
from collections.abc import Callable
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import cast

import pymupdf

from research_file_workbench.common.clock import utc_now_iso
from research_file_workbench.common.filesystem import (
    is_within,
    require_no_reparse_points,
    require_within,
)
from research_file_workbench.common.hashing import sha256_bytes, sha256_file, sha256_text
from research_file_workbench.common.json_io import (
    JsonObject,
    decode_json_object,
    encode_json_object,
)
from research_file_workbench.common.pdf import PdfInspectionError, read_pdf_page_count
from research_file_workbench.docx.page_mapping import PAGE_MAPPING_VERSION
from research_file_workbench.docx.reader import read_docx_bytes
from research_file_workbench.docx.report import READER_VERSION
from research_file_workbench.projects.models import ProjectStoreError
from research_file_workbench.projects.render_validation import (
    BUNDLE_VERSION,
    DERIVED_RENDER_REPORT_VERSION,
    SUPPORTED_BUNDLE_VERSIONS,
    validate_render_bundle,
)
from research_file_workbench.projects.service import open_project
from research_file_workbench.projects.store import ProjectStore

LIBREOFFICE_RENDER_TIMEOUT_SECONDS = 120
CommandRunner = Callable[
    [list[str], int],
    subprocess.CompletedProcess[bytes],
]


class RendererUnavailableError(ValueError):
    """Raised when the explicitly selected LibreOffice capability is not usable."""

    code = "renderer_unavailable"


class RenderConversionError(ValueError):
    """Raised when LibreOffice fails or does not yield a readable PDF."""

    code = "render_failed"


def render_libreoffice_baseline(
    project_root: Path,
    *,
    baseline_id: str,
    executable: Path,
    profile: Path,
    actor_id: str,
    confirmation_reason: str,
    surface: str,
    runner: CommandRunner | None = None,
    font_dirs: tuple[Path, ...] = (),
) -> JsonObject:
    """Convert one retained baseline with an explicit executable and profile parent.

    The author path is never opened. Source bytes come from the immutable project artifact,
    conversion inputs and outputs live in a disposable project-local directory, each conversion
    receives a private temporary profile below the supplied parent, and the resulting PDF is
    registered as unreviewed derived evidence without a page mapping.
    """
    if (
        not executable.is_absolute()
        or not executable.is_file()
        or not os.access(executable, os.X_OK)
    ):
        raise RendererUnavailableError(
            "LibreOffice is unavailable at the explicitly selected executable."
        )
    if not profile.is_absolute():
        raise RendererUnavailableError("An absolute LibreOffice profile parent is required.")
    if profile.exists() and not profile.is_dir():
        raise RendererUnavailableError("The LibreOffice profile parent is not a directory.")
    profile.mkdir(parents=True, exist_ok=True)

    invoke = runner or _run_command
    try:
        version_result = invoke(
            [executable.as_posix(), "--version"],
            LIBREOFFICE_RENDER_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise RendererUnavailableError(
            "The selected LibreOffice executable could not be started."
        ) from exc
    version_output = _command_output(version_result)
    version_line = next(
        (line.strip() for line in version_output.splitlines() if "libreoffice" in line.casefold()),
        "",
    )
    if version_result.returncode != 0 or not version_line:
        raise RendererUnavailableError(
            "The selected executable did not identify itself as LibreOffice."
        )

    store = open_project(project_root)
    baseline = store.get_baseline(baseline_id)
    source_sha256 = cast(str, baseline["source_sha256"])
    artifact_id = cast(list[str], baseline["artifact_version_ids"])[0]
    source_bytes = store.read_artifact(artifact_id)
    if sha256_bytes(source_bytes) != source_sha256:
        raise ProjectStoreError("Retained baseline bytes differ from their source identity")

    executable_sha256 = sha256_file(executable)
    profile_id = f"libreoffice-headless-{sha256_text(profile.resolve().as_posix())[:16]}"
    scratch = project_root / "var"
    require_no_reparse_points(scratch)
    require_within(scratch, project_root)
    scratch.mkdir(exist_ok=True)
    started_at = utc_now_iso()
    started = time.monotonic()
    with TemporaryDirectory(prefix="libreoffice-render-", dir=scratch) as directory:
        work = Path(directory)
        source_copy = work / "baseline.docx"
        output_root = work / "output"
        output_root.mkdir()
        source_copy.write_bytes(source_bytes)
        output_path = output_root / "baseline.pdf"
        with TemporaryDirectory(prefix="profile-", dir=profile) as profile_directory:
            render_profile = Path(profile_directory)
            supplied_fonts = _stage_fonts(font_dirs, render_profile / "user" / "fonts")
            font_cache_sha256 = _font_set_sha256(supplied_fonts)
            command = [
                executable.as_posix(),
                f"-env:UserInstallation={render_profile.resolve().as_uri()}",
                "--headless",
                "--nologo",
                "--nodefault",
                "--nofirststartwizard",
                "--convert-to",
                "pdf:writer_pdf_Export",
                "--outdir",
                output_root.as_posix(),
                source_copy.as_posix(),
            ]
            try:
                conversion_result = invoke(command, LIBREOFFICE_RENDER_TIMEOUT_SECONDS)
            except (OSError, subprocess.SubprocessError) as exc:
                raise RenderConversionError(
                    "LibreOffice headless conversion could not be started."
                ) from exc
            if conversion_result.returncode != 0:
                raise RenderConversionError(
                    f"LibreOffice headless conversion failed with exit code "
                    f"{conversion_result.returncode}."
                )
            if not output_path.is_file():
                raise RenderConversionError("LibreOffice did not produce the expected PDF.")
            pdf_bytes = output_path.read_bytes()
            if not pdf_bytes.startswith(b"%PDF-"):
                raise RenderConversionError(
                    "LibreOffice output does not begin with a PDF signature."
                )
            try:
                page_count = read_pdf_page_count(output_path)
            except PdfInspectionError as exc:
                raise RenderConversionError("LibreOffice output is not a readable PDF.") from exc
            with pymupdf.open(output_path) as pdf:  # type: ignore[no-untyped-call]
                pdf_fonts = sorted({font[3] for page in pdf for font in page.get_fonts(full=True)})

    completed_at = utc_now_iso()
    duration_ms = round((time.monotonic() - started) * 1000)
    pdf_sha256 = sha256_bytes(pdf_bytes)
    render_record: JsonObject = {
        "report_version": DERIVED_RENDER_REPORT_VERSION,
        "evidence_kind": "derived_pdf",
        "source_sha256": source_sha256,
        "render_copy_sha256": source_sha256,
        "source_unchanged": True,
        "output_path": "captured/baseline.pdf",
        "output_sha256": pdf_sha256,
        "output_size": len(pdf_bytes),
        "render_profile_id": profile_id,
        "renderer_identity_status": "executable_hash_verified",
        "renderer_engine": "LibreOffice",
        "renderer_mode": "headless",
        "renderer_path": executable.as_posix(),
        "renderer_sha256": executable_sha256,
        "renderer_version": version_line,
        "libreoffice_profile_parent": profile.resolve().as_posix(),
        "libreoffice_profile": render_profile.as_posix(),
        "export_method": "libreoffice --headless --convert-to pdf",
        "source_path": f"retained-baseline:{baseline_id}",
        "render_copy_path": "temporary/baseline.docx",
        "surface": surface,
        "started_at": started_at,
        "completed_at": completed_at,
        "duration_ms": duration_ms,
        "process_return_code": conversion_result.returncode,
        "supplied_fonts": supplied_fonts,
        "font_cache_sha256": font_cache_sha256,
        "pdf_font_names": pdf_fonts,
    }
    render_record_bytes = encode_json_object(render_record).encode("utf-8")
    artifact_refs = [
        _derived_artifact_ref("pdf", "rendered_pdf", pdf_bytes),
        _derived_artifact_ref("render_record", "file", render_record_bytes),
    ]
    manifest: JsonObject = {
        "version": BUNDLE_VERSION,
        "evidence_kind": "derived_pdf",
        "baseline_id": baseline_id,
        "source_sha256": source_sha256,
        "pdf_sha256": pdf_sha256,
        "render_profile_id": profile_id,
        "page_count": page_count,
        "reader_version": READER_VERSION,
        "mapping_version": PAGE_MAPPING_VERSION,
        "mapping": None,
        "mapping_status": "pending_independent_review",
        "render_record": render_record,
        "pages": [],
        "artifacts": artifact_refs,
        "limitations": [
            "The PDF was produced by the explicitly selected LibreOffice executable and "
            "headless profile; renderer availability does not establish Word, WPS or "
            "publisher fidelity.",
            "PDF readability and page count are verified; visual correctness and scientific "
            "content are not reviewed.",
            "No page images, source-object page mapping or independent page review were "
            "created by this render.",
            "The retained PDF can be opened as derived evidence but is not adequate for "
            "physical-page source queries.",
        ],
    }
    return store.save_render_bundle(
        baseline_id=baseline_id,
        manifest=manifest,
        blobs={
            cast(str, artifact_refs[0]["version_id"]): pdf_bytes,
            cast(str, artifact_refs[1]["version_id"]): render_record_bytes,
        },
        actor_id=actor_id,
        confirmation_reason=confirmation_reason,
    )


def font_cache_identity(font_dirs: tuple[Path, ...]) -> str:
    """Hash the current unique font-byte set without staging or rendering it."""
    return _font_set_sha256(_stage_fonts(font_dirs, None))


def _font_set_sha256(fonts: list[JsonObject]) -> str:
    return sha256_text("\n".join(sorted({cast(str, font["sha256"]) for font in fonts})))


def _stage_fonts(font_dirs: tuple[Path, ...], destination: Path | None) -> list[JsonObject]:
    supplied: list[JsonObject] = []
    seen: set[str] = set()
    for root in font_dirs:
        if not root.is_absolute():
            raise RendererUnavailableError("Application font cache paths must be absolute.")
        if not root.exists():
            continue
        require_no_reparse_points(root)
        for path in sorted(root.rglob("*")):
            if path.suffix.casefold() not in {".ttf", ".otf"} or not path.is_file():
                continue
            require_no_reparse_points(path)
            digest = sha256_file(path)
            if digest in seen:
                continue
            if destination is not None:
                destination.mkdir(parents=True, exist_ok=True)
                copied = destination / f"{digest}{path.suffix.lower()}"
                shutil.copyfile(path, copied)
                if sha256_file(copied) != digest:
                    raise RenderConversionError(
                        "Application font changed while preparing the render."
                    )
            metadata: JsonObject = {}
            receipt = path.parent / "source.json"
            if receipt.is_file():
                require_no_reparse_points(receipt)
                source = decode_json_object(receipt.read_bytes())
                for raw in cast(list[JsonObject], source["files"]):
                    if raw.get("name") == path.name:
                        if raw.get("sha256") != digest:
                            raise RenderConversionError(
                                "Cached font differs from its source receipt."
                            )
                        metadata = {
                            key: raw[key]
                            for key in ("family", "postscript", "version", "weight", "style")
                        }
                        break
            supplied.append({"path": path.as_posix(), "sha256": digest, **metadata})
            seen.add(digest)
    return supplied


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
    if manifest.get("version") not in SUPPORTED_BUNDLE_VERSIONS:
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


def _run_command(command: list[str], timeout: int) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        command,
        capture_output=True,
        check=False,
        timeout=timeout,
    )


def _command_output(result: subprocess.CompletedProcess[bytes]) -> str:
    content = b"\n".join(part for part in (result.stdout, result.stderr) if part)
    return content.decode("utf-8", errors="replace").strip()


def _derived_artifact_ref(role: str, kind: str, content: bytes) -> JsonObject:
    digest = sha256_bytes(content)
    return {
        "role": role,
        "kind": kind,
        "source_kind": "derived",
        "page_number": None,
        "version_id": f"artifact-version-{digest}",
        "sha256": digest,
    }


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
