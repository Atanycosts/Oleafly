"""Registration of the local MCP tool handlers over one WorkbenchService.

Read tools and write tools are separate registrations with separate annotations, but
both project the same service operations the HTTP surface exposes. Two capabilities
stay off the MCP surface on purpose: author decisions refuse agent proposals by
design, and render-bundle registration records independent human evidence.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Annotated, Any, Literal

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.context import Context
from mcp.types import ToolAnnotations
from pydantic import Field

from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.docx.query import ReadQuery
from research_file_workbench.docx.read_receipt import ReadCaller
from research_file_workbench.journals.models import SOURCE_KINDS
from research_file_workbench.workbench.http_boundary import captured_bytes
from research_file_workbench.workbench.service import WorkbenchService

Region = Literal["body", "header", "footer", "footnote", "endnote", "textbox"]
ObjectType = Literal[
    "text_block",
    "table",
    "image",
    "math",
    "field",
    "section",
    "break",
    "complex_object",
    "reference",
]
SourceKind = Literal[
    "template_docx",
    "guide_text",
    "guide_docx",
    "guide_pdf",
    "rule_component_json",
]
DispositionAction = Literal["note", "defer"]

assert set(SourceKind.__args__) == set(SOURCE_KINDS)  # type: ignore[attr-defined]


def _captured_source(raw: object) -> tuple[str, str, bytes]:
    """Decode one declared source upload, sharing the HTTP boundary's rules."""
    from research_file_workbench.workbench.http_boundary import text

    if not isinstance(raw, dict):
        raise ValueError("来源记录格式无效。")
    kind = text(raw, "kind")
    if kind not in SOURCE_KINDS:
        raise ValueError(f"不支持的来源类型：{kind}")
    name = text(raw, "name")
    return name, kind, captured_bytes(raw)


def _captured_sources(raw: object) -> list[Any]:
    if not isinstance(raw, list) or not raw:
        raise ValueError("请至少提供一个期刊来源文件。")
    from research_file_workbench.journals.models import SourceInput

    return [SourceInput(*_captured_source(item)) for item in raw]


def _captured_payload(content_base64: object) -> bytes:
    return captured_bytes({"content_base64": content_base64})


def register_read_tools(
    server: MCPServer,
    service: WorkbenchService,
    read: Callable[[Callable[[], JsonObject]], dict[str, Any]],
    *,
    read_only: ToolAnnotations,
    server_id: str,
    method_versions_map: dict[str, str],
    server_version: str,
    contract_version: str,
    scope: str = "read_only",
) -> None:
    """Register the read tool surface over one opened library."""

    _register_discovery_tools(server, service, read, read_only=read_only)
    _register_workspace_tool(
        server,
        service,
        read,
        read_only=read_only,
    )
    _register_history_tools(server, service, read, read_only=read_only)
    _register_query_tool(
        server,
        service,
        read,
        read_only=read_only,
        server_id=server_id,
    )
    _register_metadata_tool(
        server,
        read_only=read_only,
        server_id=server_id,
        method_versions_map=method_versions_map,
        server_version=server_version,
        contract_version=contract_version,
        scope=scope,
    )


def _register_discovery_tools(
    server: MCPServer,
    service: WorkbenchService,
    read: Callable[[Callable[[], JsonObject]], dict[str, Any]],
    *,
    read_only: ToolAnnotations,
) -> None:
    """Register library and retained-world discovery tools."""

    @server.tool(
        name="library_state",
        title="Library state",
        annotations=read_only,
        description=(
            "Report the library discovery view: known rule worlds, managed projects with "
            "their bindings, and the declared capability flags. Discovery records no content "
            "read and no review."
        ),
    )
    def library_state() -> dict[str, Any]:
        return read(service.state)

    @server.tool(
        name="project_detail",
        title="Project detail",
        annotations=read_only,
        description=(
            "Report one managed project: its display identity, current baseline id, explicit "
            "journal binding, and the latest saved check with derived applicability."
        ),
    )
    def project_detail(project_id: str) -> dict[str, Any]:
        return read(lambda: service.project(project_id))

    @server.tool(
        name="world_review",
        title="World review",
        annotations=read_only,
        description=(
            "Build source-bound review units for one retained rule-world version. Returns "
            "the world content with its captured sources; it changes no world or check record."
        ),
    )
    def world_review(version_id: str) -> dict[str, Any]:
        return read(lambda: service.review(version_id))

    @server.tool(
        name="source_page",
        title="Source page preview",
        annotations=read_only,
        description=(
            "Render one page of a retained PDF source at fixed DPI in the unrotated coordinate "
            "frame of its fragment boxes. A derived reading aid, not a retained render artifact; "
            "no record is written."
        ),
    )
    def source_page(
        version_id: str,
        source_id: str,
        page: Annotated[int, Field(ge=1)],
    ) -> dict[str, Any]:
        return read(lambda: service.source_page(version_id, source_id, page))


def _register_workspace_tool(
    server: MCPServer,
    service: WorkbenchService,
    read: Callable[[Callable[[], JsonObject]], dict[str, Any]],
    *,
    read_only: ToolAnnotations,
) -> None:
    """Register the retained manuscript workspace presentation tool."""

    @server.tool(
        name="manuscript_workspace",
        title="Manuscript workspace",
        annotations=read_only,
        description=(
            "Expose one manuscript version with its retained object and page evidence. Omit "
            "baseline_id to use the project current baseline."
        ),
    )
    def manuscript_workspace(project_id: str, baseline_id: str | None = None) -> dict[str, Any]:
        return read(lambda: service.manuscript(project_id, baseline_id))


def _register_query_tool(
    server: MCPServer,
    service: WorkbenchService,
    read: Callable[[Callable[[], JsonObject]], dict[str, Any]],
    *,
    read_only: ToolAnnotations,
    server_id: str,
) -> None:
    """Register the persistent manuscript object query tool."""

    @server.tool(
        name="read_objects",
        title="Read manuscript objects",
        annotations=read_only,
        description=(
            "Deliver complete manuscript observations through the persistent query and receipt "
            "boundary. Select by region, object type, exact object id, or a reviewed physical "
            "page. page_size limits how many objects are returned, never the size of one "
            "object. Pass the returned cursor to continue. A physical-page selection is refused "
            "unless a reviewed independent mapping exists for the chosen render bundle."
        ),
    )
    def read_objects(
        ctx: Context[Any, Any],
        project_id: str,
        baseline_id: str | None = None,
        render_bundle_id: str | None = None,
        region: Region | None = None,
        object_type: ObjectType | None = None,
        object_id: str | None = None,
        page_number: Annotated[int, Field(ge=1)] | None = None,
        page_size: Annotated[int, Field(ge=1, le=200)] = 20,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        def run() -> JsonObject:
            metadata = ctx.request_context.meta
            caller_metadata = (
                None if metadata is None else metadata.get("com.oleafly/research-task")
            )
            caller = None if caller_metadata is None else ReadCaller.from_json(caller_metadata)
            query = ReadQuery(
                region=region,
                object_type=object_type,
                object_id=object_id,
                page_number=page_number,
                page_size=page_size,
                cursor=cursor,
            )
            return service.read(
                project_id,
                query,
                baseline_id,
                render_bundle_id,
                client_id=server_id,
                caller=caller,
            )

        return read(run)


def _register_history_tools(
    server: MCPServer,
    service: WorkbenchService,
    read: Callable[[Callable[[], JsonObject]], dict[str, Any]],
    *,
    read_only: ToolAnnotations,
) -> None:
    """Register saved reads, checks, and project history tools."""

    @server.tool(
        name="project_history",
        title="Project history",
        annotations=read_only,
        description=(
            "Present check and binding history in storage commit order, together with the "
            "recorded reads. Order is commit order, not wall-clock time."
        ),
    )
    def project_history(project_id: str) -> dict[str, Any]:
        return read(lambda: service.history(project_id))

    @server.tool(
        name="saved_read",
        title="Saved read",
        annotations=read_only,
        description=(
            "Recover the exact original response of a recorded read without executing a "
            "historical reader. Use this to cite what was actually delivered under an earlier "
            "method version."
        ),
    )
    def saved_read(project_id: str, read_record_id: str) -> dict[str, Any]:
        return read(lambda: service.saved_read(project_id, read_record_id))

    @server.tool(
        name="check_record",
        title="Check record",
        annotations=read_only,
        description=(
            "Return one saved check with its original rule basis and verdict, plus the reasons "
            "its applicability may no longer hold. A stale check keeps its recorded verdict; "
            "validity is derived at read time and is never written back."
        ),
    )
    def check_record(check_id: str) -> dict[str, Any]:
        return read(lambda: service.check_record(check_id))

    @server.tool(
        name="diff_worlds",
        title="Diff world versions",
        annotations=read_only,
        description=(
            "Compare the effective rule content of two retained world versions and report the "
            "differences with their context, without changing either version."
        ),
    )
    def diff_worlds(from_version: str, to_version: str) -> dict[str, Any]:
        return read(lambda: service.diff_worlds(from_version, to_version))


def _register_metadata_tool(
    server: MCPServer,
    *,
    read_only: ToolAnnotations,
    server_id: str,
    method_versions_map: dict[str, str],
    server_version: str,
    contract_version: str,
    scope: str,
) -> None:
    """Register the server identity and method coverage declaration."""

    @server.tool(
        name="method_versions",
        title="Method versions",
        annotations=read_only,
        description=(
            "Report this server identity, the method and contract versions it answers under, "
            "and the declared coverage limits. Any recorded result must be read together with "
            "the method version that produced it."
        ),
    )
    def method_versions() -> dict[str, Any]:
        return {
            "server_id": server_id,
            "server_version": server_version,
            "contract_version": contract_version,
            "method_versions": dict(method_versions_map),
            "scope": scope,
            "limits": {
                "manuscript_in_place_editing": False,
                "check_execution": scope == "local_read_write",
                "page_coordinate_inference": False,
                "coverage": "partial while the reader declares limits",
            },
        }


def register_write_tools(
    server: MCPServer,
    service: WorkbenchService,
    write: Callable[[Callable[[], JsonObject]], dict[str, Any]],
    *,
    write_annotations: ToolAnnotations,
) -> None:
    """Register the local write tool surface: the same operations the HTTP surface exposes.

    Author decisions and render-bundle registration stay off this surface on purpose: the
    storage rules refuse agent proposals, and page evidence must come from an independent
    human review, which the CLI operator path records.
    """

    @server.tool(
        name="import_world",
        title="Import journal world",
        annotations=write_annotations,
        description=(
            "Capture supplied guidance and template sources, analyze them under the current "
            "analyzer, and retain a new immediately usable world version. Sources carry name, "
            "kind and base64 content exactly like the HTTP contract; identical repeated "
            "analysis reuses the retained world version."
        ),
    )
    def import_world(
        journal_id: str,
        journal_name: str,
        sources: Annotated[list[dict[str, str]], Field(min_length=1)],
        article_type: str = "research_article",
        stage: str = "initial_submission",
        language: str = "en",
    ) -> dict[str, Any]:
        return write(
            lambda: service.import_world(
                journal_id,
                journal_name,
                _captured_sources(sources),
                article_type=article_type,
                stage=stage,
                language=language,
            )
        )

    @server.tool(
        name="revise_rule",
        title="Revise world rule",
        annotations=write_annotations,
        description=(
            "Create a reasoned local correction of one rule as a new world version; the "
            "original version, its checks and bindings stay unchanged."
        ),
    )
    def revise_rule(
        version_id: str,
        rule_id: str,
        expected: Annotated[int, Field(ge=0)] | str,
        reason: str,
    ) -> dict[str, Any]:
        return write(lambda: service.revise(version_id, rule_id, expected, reason))

    @server.tool(
        name="import_manuscript",
        title="Import manuscript",
        annotations=write_annotations,
        description=(
            "Capture a DOCX manuscript as a new application-owned project with its first "
            "baseline; the author file itself is never modified."
        ),
    )
    def import_manuscript(name: str, filename: str, content_base64: str) -> dict[str, Any]:
        return write(
            lambda: service.import_manuscript(
                name, filename, _captured_payload(content_base64), surface="mcp"
            )
        )

    @server.tool(
        name="update_manuscript",
        title="Update manuscript",
        annotations=write_annotations,
        description=(
            "Capture a supplied DOCX as a new baseline of an existing project after a "
            "compare-and-swap guard on the expected baseline; old checks stay historical."
        ),
    )
    def update_manuscript(
        project_id: str,
        expected_baseline_id: str,
        filename: str,
        content_base64: str,
        reason: str,
        request_id: str,
    ) -> dict[str, Any]:
        return write(
            lambda: service.update_manuscript(
                project_id,
                expected_baseline_id,
                filename,
                _captured_payload(content_base64),
                reason,
                request_id,
                surface="mcp",
            )
        )

    @server.tool(
        name="bind_project",
        title="Bind journal world",
        annotations=write_annotations,
        description=(
            "Bind one project to one retained world version with compare-and-swap control on "
            "the expected binding; rebinding after a manuscript update is explicit."
        ),
    )
    def bind_project(
        project_id: str,
        world_version_id: str,
        expected_binding_id: str | None = None,
    ) -> dict[str, Any]:
        return write(
            lambda: service.bind(project_id, world_version_id, expected_binding_id, surface="mcp")
        )

    @server.tool(
        name="run_check",
        title="Run journal check",
        annotations=write_annotations,
        description=(
            "Check the retained manuscript bytes against the bound world and save one check "
            "record; the verdict is immutable afterwards and validity is derived, not written."
        ),
    )
    def run_check(project_id: str) -> dict[str, Any]:
        return write(lambda: service.run_check(project_id, surface="mcp"))

    @server.tool(
        name="record_disposition",
        title="Record disposition",
        annotations=write_annotations,
        description=(
            "Record a note or a defer for one rule of one check. Dispositions never change the "
            "recorded verdict or the rule basis."
        ),
    )
    def record_disposition(
        check_id: str,
        rule_id: str,
        action: DispositionAction,
        note: str,
    ) -> dict[str, Any]:
        return write(lambda: service.disposition(check_id, rule_id, action, note, surface="mcp"))
