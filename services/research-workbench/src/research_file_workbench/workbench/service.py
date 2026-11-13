"""Local journal worlds, explicit manuscript bindings and evidence-backed checks."""

import shutil
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import cast
from uuid import uuid4

from research_file_workbench.common.clock import utc_now_iso
from research_file_workbench.common.filesystem import require_no_reparse_points, require_within
from research_file_workbench.common.hashing import sha256_bytes
from research_file_workbench.common.json_io import JsonObject, write_json_object
from research_file_workbench.docx.query import ReadQuery
from research_file_workbench.docx.read_receipt import ReadCaller
from research_file_workbench.docx.reader import read_docx_bytes
from research_file_workbench.docx.report import READER_VERSION
from research_file_workbench.journals import models
from research_file_workbench.journals.analysis import analyze_world
from research_file_workbench.journals.checker import check_world
from research_file_workbench.journals.models import CHECKER_VERSION, SourceInput
from research_file_workbench.journals.revisions import revise_rule
from research_file_workbench.journals.store import WorldStore
from research_file_workbench.projects.models import BaselineConflictError
from research_file_workbench.projects.service import (
    create_project,
    import_captured_document,
    import_document,
    open_project,
)
from research_file_workbench.workbench.manuscripts import manuscript_source, read_manuscript
from research_file_workbench.workbench.project_facade import (
    diff_worlds,
    discover_state,
    history_details,
    manuscript_details,
    project_details,
)


class ManuscriptUpdateRefused(ValueError):
    """Raised when a retained refusal record answers a manuscript update attempt."""

    def __init__(self, message: str, *, result: JsonObject) -> None:
        super().__init__(message)
        self.result = result


class WorkbenchService:
    """Coordinate owned library data while keeping original client files read-only."""

    def __init__(self, root: Path, *, font_dirs: tuple[Path, ...] = ()) -> None:
        self.store = WorldStore(root)
        self.store.validate_library()
        self.root = root.resolve()
        self.font_dirs = font_dirs

    @classmethod
    def create(
        cls, root: Path, *, protected_roots: tuple[Path, ...] = (), font_dirs: tuple[Path, ...] = ()
    ) -> "WorkbenchService":
        """Initialize explicitly selected storage outside protected author workspaces."""
        WorldStore.create(root, protected_roots=protected_roots)
        return cls(root, font_dirs=font_dirs)

    def import_world(
        self,
        journal_id: str,
        journal_name: str,
        sources: list[SourceInput],
        *,
        article_type: str = "research_article",
        stage: str = "initial_submission",
        language: str = "en",
    ) -> JsonObject:
        """Analyze captured inputs and retain an immediately usable immutable world."""
        world = analyze_world(
            journal_id,
            journal_name,
            sources,
            article_type=article_type,
            stage=stage,
            language=language,
        )
        captured = {f"source-{sha256_bytes(source.content)}": source.content for source in sources}
        return self.store.save_world(world, captured)

    def revise(self, version_id: str, rule_id: str, expected: int | str, reason: str) -> JsonObject:
        """Create a reasoned local rule correction without changing existing bindings."""
        original = self.store.get_world(version_id)
        revised = revise_rule(original, rule_id, expected, reason, "local-operator")
        captured = {
            _text(source, "source_id"): self.store.read_source(_text(source, "source_id"))
            for source in _records(revised, "sources")
        }
        return self.store.save_world(revised, captured)

    def import_component(
        self,
        version_id: str,
        name: str,
        content: bytes,
        *,
        sources: tuple[SourceInput, ...] = (),
        decisions: tuple[JsonObject, ...] = (),
        preview: bool = False,
    ) -> JsonObject:
        """Review or adopt captured candidates using the existing world/version owners."""
        original = self.store.get_world(version_id)
        captured = [
            SourceInput(
                _text(source, "name"),
                _text(source, "kind"),
                self.store.read_source(_text(source, "source_id")),
            )
            for source in _records(original, "sources")
        ]
        captured.extend(sources)
        captured.append(SourceInput(name, "rule_component_json", content))
        scope = cast(JsonObject, original["scope"])
        world = analyze_world(
            _text(original, "journal_id"),
            _text(original, "journal_name"),
            captured,
            article_type=_text(scope, "article_type"),
            stage=_text(scope, "stage"),
            language=_text(scope, "language"),
        )
        for decision in cast(list[JsonObject], original.get("manual_decisions", [])):
            world = revise_rule(
                world,
                _text(decision, "rule_id"),
                cast(int | str, decision["expected"]),
                _text(decision, "reason"),
                _text(decision, "actor_id"),
            )
        for decision in decisions:
            models.require_keys(decision, {"property", "expected", "reason"})
            property_name = models.require_text(decision["property"], "decision property")
            rule = next(
                (rule for rule in _records(world, "rules") if rule["property"] == property_name),
                None,
            )
            if rule is None:
                raise ValueError("A decision must select a rule in the proposed world.")
            world = revise_rule(
                world,
                _text(rule, "rule_id"),
                models.require_expected(property_name, decision["expected"]),
                models.require_text(decision["reason"], "decision reason"),
                "local-operator",
            )
        if preview:
            return world
        return self.store.save_world(
            world, {source.source_id: source.content for source in captured}
        )

    def import_manuscript(
        self, name: str, filename: str, content: bytes, *, surface: str = "browser"
    ) -> JsonObject:
        """Retain an uploaded DOCX in a managed project; no client source path is written."""
        _surface(surface)
        display_name = _display_name(name)
        filename = _name(filename)
        if Path(filename).suffix.lower() != ".docx":
            raise ValueError("论文需要选择 DOCX 文件。")
        result = read_docx_bytes(content, source_label=filename)
        if any(part.status == "failed" for part in result.parts):
            raise ValueError("论文包含无法解析的 XML 部件，请先检查源文件。")
        identity = f"project-{uuid4().hex}"
        source_root = self.root / "inputs" / identity
        project_root = self.root / "projects" / identity
        self.store.validate_library()
        scratch_root = self.root / "var"
        for path in (source_root, project_root, scratch_root):
            require_no_reparse_points(path)
            require_within(path, self.root)
        scratch_root.mkdir(parents=True, exist_ok=True)
        with TemporaryDirectory(prefix="upload-", dir=scratch_root) as directory:
            stage = Path(directory)
            captured_root = stage / "input"
            captured_root.mkdir()
            (captured_root / "manuscript.docx").write_bytes(content)
            source_root.parent.mkdir(parents=True, exist_ok=True)
            captured_root.rename(source_root)
            published = False
            try:
                staged_project = stage / "project"
                create_project(
                    staged_project, author_workspace_root=source_root, project_id=identity
                )
                outcome = import_document(
                    staged_project,
                    source_root / "manuscript.docx",
                    source_sha256=result.source_sha256,
                    request_id="initial-world-workbench-import",
                    expected_baseline_id=None,
                    actor_id="local-operator",
                    confirmation_reason=(
                        f"Captured from the {surface} surface for read-only journal checking."
                    ),
                )
                if outcome.get("status") != "APPLIED":
                    raise ValueError("论文版本未能保存，请检查导入结果。")
                write_json_object(
                    staged_project / "display.json", {"name": display_name, "filename": filename}
                )
                self.store.validate_library()
                require_no_reparse_points(project_root)
                project_root.parent.mkdir(parents=True, exist_ok=True)
                staged_project.rename(project_root)
                published = True
            finally:
                if not published:
                    require_no_reparse_points(source_root)
                    require_within(source_root, self.root / "inputs")
                    shutil.rmtree(source_root)
        return self.project(identity)

    def project(self, project_id: str) -> JsonObject:
        """Return a managed project identity with its explicit binding and last check."""
        return project_details(
            project_id=project_id,
            project_root=self.project_root,
            store=self.store,
            check_record=self.check_record,
        )

    def state(self) -> JsonObject:
        """Return discovery metadata; discovery never records a content read or review."""
        return discover_state(root=self.root, store=self.store, project_lookup=self.project)

    def review(self, version_id: str) -> JsonObject:
        """Build source-bound review units without changing any world or check record."""
        from research_file_workbench.journals.evidence import build_world_evidence

        world = self.store.get_world(version_id)
        sources = {
            _text(source, "source_id"): self.store.read_source(_text(source, "source_id"))
            for source in _records(world, "sources")
        }
        return build_world_evidence(world, sources)

    def source_page(self, version_id: str, source_id: str, page: int) -> JsonObject:
        """Render one retained guide-PDF page for local review; no record is written."""
        from research_file_workbench.journals.pdf_analysis import render_pdf_page

        world = self.store.get_world(version_id)
        kinds = {
            _text(source, "source_id"): _text(source, "kind")
            for source in _records(world, "sources")
        }
        if source_id not in kinds:
            raise ValueError("来源不在该期刊版本中。")
        if kinds[source_id] != "guide_pdf":
            raise ValueError("页面预览仅支持 PDF 来源。")
        return render_pdf_page(self.store.read_source(source_id), page, source_id)

    def manuscript(self, project_id: str, baseline_id: str | None) -> JsonObject:
        """Expose one selected manuscript version with retained object and page evidence."""
        return manuscript_details(
            project_id=project_id,
            baseline_id=baseline_id,
            project_lookup=self.project,
            project_root=self.project_root,
        )

    def manuscript_source(self, project_id: str, baseline_id: str) -> JsonObject:
        """Return immutable DOCX bytes for the explicitly selected managed baseline."""
        path = self.project_root(project_id)
        if not path.is_dir():
            raise ValueError("论文不在当前工作台库中。")
        return manuscript_source(path, baseline_id)

    def render_baseline(
        self,
        project_id: str,
        baseline_id: str,
        *,
        libreoffice_executable: str,
        reason: str,
        surface: str = "browser",
    ) -> JsonObject:
        """Register a headless LibreOffice PDF for one explicit retained baseline."""
        from research_file_workbench.projects.render_service import (
            render_libreoffice_baseline,
        )

        _surface(surface)
        if not reason.strip():
            raise ValueError("请填写稿件渲染原因。")
        path = self.project_root(project_id)
        if not path.is_dir():
            raise ValueError("论文不在当前工作台库中。")
        return render_libreoffice_baseline(
            path,
            baseline_id=baseline_id,
            executable=Path(libreoffice_executable),
            profile=self.root / "var" / "libreoffice-profile",
            actor_id="local-operator",
            confirmation_reason=f"Rendered from the {surface} surface: {reason}",
            surface=surface,
            font_dirs=self.font_dirs,
        )

    def derived_renders(self, project_id: str, baseline_id: str) -> JsonObject:
        """List derived PDF registrations for one explicit retained baseline."""
        from research_file_workbench.projects.render_service import font_cache_identity

        path = self.project_root(project_id)
        if not path.is_dir():
            raise ValueError("论文不在当前工作台库中。")
        project = open_project(path)
        project.get_baseline(baseline_id)
        return {
            "project_id": project_id,
            "baseline_id": baseline_id,
            "font_cache_sha256": font_cache_identity(self.font_dirs),
            "derived_renders": project.list_derived_renders(baseline_id),
        }

    def history(self, project_id: str) -> JsonObject:
        """Present check and binding history in storage commit order."""
        return history_details(
            project_id=project_id,
            project_lookup=self.project,
            check_record=self.check_record,
            store=self.store,
            project_root=self.project_root,
        )

    def read(
        self,
        project_id: str,
        query: ReadQuery,
        baseline_id: str | None,
        render_bundle_id: str | None,
        *,
        client_id: str = "research-workbench",
        caller: ReadCaller | None = None,
    ) -> JsonObject:
        """Deliver selected content through the persistent query and receipt boundary.

        `client_id` records which serving surface asked, so a retained receipt distinguishes a
        desktop read from an agent read. It is chosen by the surface, not by a caller.
        """
        return read_manuscript(
            self.project_root(project_id),
            query,
            baseline_id,
            render_bundle_id,
            client_id=client_id,
            caller=caller,
        )

    def saved_read(self, project_id: str, read_record_id: str) -> JsonObject:
        """Recover the exact original response without executing a historical reader."""
        return open_project(self.project_root(project_id)).get_read(read_record_id)

    def update_manuscript(
        self,
        project_id: str,
        expected_baseline_id: str,
        filename: str,
        content: bytes,
        reason: str,
        request_id: str,
        *,
        surface: str = "browser",
    ) -> JsonObject:
        """Retain an explicitly confirmed source update and leave old checks historical.

        Retained refusal records answer as typed refusals with their exact saved result,
        so callers can distinguish a confirmed refusal from an unknown transport outcome.
        """
        _surface(surface)
        if not reason.strip():
            raise ValueError("请填写版本更新原因。")
        result = import_captured_document(
            self.project_root(project_id),
            content,
            filename=filename,
            request_id=request_id,
            expected_baseline_id=expected_baseline_id,
            confirmation_reason=f"Captured from the {surface} surface: {reason}",
        )
        status = result.get("status")
        if status == "APPLIED":
            return result
        if status == "BASELINE_CONFLICT":
            raise BaselineConflictError(
                "BASELINE_CONFLICT：论文版本已变化，当前基线是 "
                f"{result.get('previous_baseline_id')}，请刷新后重试。",
                result=result,
            )
        if status == "IDEMPOTENCY_CONFLICT":
            raise ManuscriptUpdateRefused(
                "IDEMPOTENCY_CONFLICT：同一 request_id 已用于不同内容，请改用新的请求标识。",
                result=result,
            )
        if status == "REJECTED":
            detail = result.get("rejection_reason")
            if not isinstance(detail, str) or not detail:
                detail = "该文档未能读取，请检查源文件。"
            raise ManuscriptUpdateRefused(f"REJECTED：{detail}", result=result)
        raise ManuscriptUpdateRefused(
            f"{status}：稿件更新未应用，请检查保留的请求记录。", result=result
        )

    def render_artifact(
        self,
        project_id: str,
        baseline_id: str,
        bundle_id: str,
        role: str,
        page_number: int | None,
    ) -> bytes:
        """Return an exact retained page or PDF from an explicitly selected evidence bundle."""
        from research_file_workbench.projects.render_service import read_render_artifact

        if (
            (role == "pdf" and page_number is not None)
            or (role == "page_image" and (page_number is None or page_number < 1))
            or role not in {"pdf", "page_image"}
        ):
            raise ValueError("请选择已保存的页面或 PDF。")
        return read_render_artifact(
            self.project_root(project_id),
            baseline_id=baseline_id,
            bundle_id=bundle_id,
            role=role,
            page_number=page_number,
        )

    def bind(
        self,
        project_id: str,
        world_version_id: str,
        expected_binding_id: str | None,
        *,
        surface: str = "browser",
    ) -> JsonObject:
        """Bind a selected world version with compare-and-swap concurrency control."""
        _surface(surface)
        path = self.project_root(project_id)
        project = open_project(path)
        baseline = project.get_baseline()
        world = self.store.get_world(world_version_id)
        with project.guard_baseline(_text(baseline, "baseline_id")):
            binding = self.store.bind_project(
                project_id,
                path.as_posix(),
                _text(baseline, "baseline_id"),
                _text(world, "version_id"),
                expected_binding_id=expected_binding_id,
                actor_id="local-operator",
                surface=surface,
            )
        return binding

    def run_check(self, project_id: str, *, surface: str = "browser") -> JsonObject:
        """Check retained source bytes against a pinned world; never change either input."""
        _surface(surface)
        binding = self.store.get_binding(project_id)
        if binding is None:
            raise ValueError("请先为这篇论文选择并绑定一个期刊世界版本。")
        project = open_project(self.project_root(project_id))
        baseline = project.get_baseline()
        if baseline["baseline_id"] != binding["baseline_id"]:
            raise ValueError("论文基线已变化，请重新绑定当前论文版本。")
        artifact = f"artifact-version-{_text(baseline, 'source_sha256')}"
        payload = project.read_artifact(artifact)
        result = read_docx_bytes(payload, source_label=artifact)
        world = self.store.get_world(_text(binding, "world_version_id"))
        checked = check_world(world, result)
        if project.get_baseline()["baseline_id"] != baseline["baseline_id"]:
            raise ValueError("检查期间论文基线发生变化，请重新运行检查。")
        if sha256_bytes(project.read_artifact(artifact)) != result.source_sha256:
            raise ValueError("检查期间保留的论文内容发生变化。")
        record: JsonObject = {
            **checked,
            "check_id": f"check-{uuid4().hex}",
            "created_at": utc_now_iso(),
            "project_id": project_id,
            "baseline_id": baseline["baseline_id"],
            "binding_id": binding["binding_id"],
            "reader_version": READER_VERSION,
            "actor_id": "local-operator",
            "surface": surface,
            "world_version_id": world["version_id"],
            "dependencies": {
                "artifact_version_id": artifact,
                "source_sha256": result.source_sha256,
                "world_version_id": world["version_id"],
                "reader_version": READER_VERSION,
                "checker_version": CHECKER_VERSION,
                "completeness": "complete_for_declared_section_geometry",
            },
        }
        with project.guard_baseline(_text(baseline, "baseline_id")):
            self.store.save_check(record)
        return self.check_record(_text(record, "check_id"))

    def check_record(self, check_id: str) -> JsonObject:
        """Derive current applicability without rewriting the historical check verdicts."""
        record = self.store.get_check(check_id)
        project_id = _text(record, "project_id")
        baseline = open_project(self.project_root(project_id)).get_baseline()
        binding = self.store.get_binding(project_id)
        reasons = []
        if baseline["baseline_id"] != record["baseline_id"]:
            reasons.append("source_baseline_changed")
        if binding is None or binding["binding_id"] != record["binding_id"]:
            reasons.append("world_binding_changed")
        if record.get("checker_version") != CHECKER_VERSION:
            reasons.append("checker_version_changed")
        if record.get("reader_version") != READER_VERSION:
            reasons.append("reader_version_changed")
        artifact = f"artifact-version-{_text(record, 'source_sha256')}"
        open_project(self.project_root(project_id)).read_artifact(artifact)
        world = self.store.get_world(_text(record, "world_version_id"))
        if world["analyzer_version"] != models.ANALYZER_VERSION:
            reasons.append("analyzer_version_changed")
        update = any(
            other["journal_id"] == world["journal_id"]
            and cast(int, other["version_ordinal"]) > cast(int, world["version_ordinal"])
            for other in self.store.list_worlds()
        )
        return {
            **record,
            "world": world,
            "validity": "STALE" if reasons else "CURRENT",
            "stale_reasons": reasons,
            "update_available": update,
            "dispositions": self.store.list_dispositions(check_id),
        }

    def disposition(
        self, check_id: str, rule_id: str, action: str, note: str, *, surface: str = "browser"
    ) -> JsonObject:
        """Record handling without replacing a rule or modifying its verdict."""
        _surface(surface)
        return self.store.record_disposition(
            check_id, rule_id, action, note, "local-operator", surface=surface
        )

    def diff_worlds(self, from_version: str, to_version: str) -> JsonObject:
        """Compare effective rule content, retaining context differences explicitly."""
        return diff_worlds(self.store, from_version, to_version)

    def project_root(self, project_id: str) -> Path:
        """Resolve an application-owned project identifier inside the selected library."""
        if not project_id.startswith("project-") or not project_id[8:].isalnum():
            raise ValueError("论文标识无效。")
        path = self.root / "projects" / project_id
        require_no_reparse_points(path)
        require_within(path, self.root / "projects")
        return path


def _surface(value: str) -> str:
    """Validate the driving-surface label retained with operator-attributed records."""
    if value not in {"browser", "mcp", "cli"}:
        raise ValueError("未知的调用面别。")
    return value


def _name(value: str) -> str:
    if (
        not isinstance(value, str)
        or not value.strip()
        or Path(value).name != value
        or any(c in value for c in ("/", "\\", ":", "\0"))
    ):
        raise ValueError("请提供文件名，不要提供文件路径。")
    return value


def _display_name(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("请填写论文名称。")
    if any(ord(character) < 0x20 or ord(character) == 0x7F for character in value):
        raise ValueError("论文名称不能包含控制字符。")
    return value.strip()


def _text(value: JsonObject, key: str) -> str:
    field = value.get(key)
    if not isinstance(field, str) or not field:
        raise ValueError(f"Missing {key}")
    return field


def _records(value: JsonObject, key: str) -> list[JsonObject]:
    field = value.get(key)
    if not isinstance(field, list) or any(not isinstance(item, dict) for item in field):
        raise ValueError(f"Invalid {key}")
    return cast(list[JsonObject], field)
