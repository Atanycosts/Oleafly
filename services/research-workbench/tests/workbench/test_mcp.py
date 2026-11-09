"""The MCP entry answers over stdio, projects the local surface, and refuses legibly."""

from __future__ import annotations

import asyncio
import base64
import os
import sys
from pathlib import Path

import pymupdf
import pytest
from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client
from mcp.types import CallToolResult, Tool

from research_file_workbench.journals.models import SourceInput
from research_file_workbench.workbench.service import WorkbenchService
from tests.journals.test_analysis import docx_bytes

SERVER_MODULE = "research_file_workbench.workbench.mcp"

EXPECTED_TOOLS = {
    "library_state",
    "project_detail",
    "world_review",
    "manuscript_workspace",
    "project_history",
    "read_objects",
    "saved_read",
    "check_record",
    "diff_worlds",
    "method_versions",
    "import_world",
    "revise_rule",
    "import_manuscript",
    "update_manuscript",
    "bind_project",
    "run_check",
    "record_disposition",
    "source_page",
}

WRITE_TOOLS = {
    "import_world",
    "revise_rule",
    "import_manuscript",
    "update_manuscript",
    "bind_project",
    "run_check",
    "record_disposition",
}


def _parameters(library_root: Path, *, read_only: bool = False) -> StdioServerParameters:
    # The SDK inherits only a safe subset of the environment, so the server process must be
    # told explicitly where to import from. Passing the parent import roots keeps the child on
    # the same declared dependency set the gate is verifying.
    return StdioServerParameters(
        command=sys.executable,
        args=["-m", SERVER_MODULE, "--library-root", str(library_root)]
        + (["--read-only"] if read_only else []),
        env={"PYTHONPATH": os.pathsep.join(entry for entry in sys.path if entry)},
    )


async def _list_tools(library_root: Path, *, read_only: bool = False) -> list[Tool]:
    async with (
        stdio_client(_parameters(library_root, read_only=read_only)) as (read, write),
        ClientSession(read, write) as session,
    ):
        await session.initialize()
        return list((await session.list_tools()).tools)


async def _call_raw(
    library_root: Path,
    name: str,
    arguments: dict[str, object],
    *,
    read_only: bool = False,
    meta: dict[str, object] | None = None,
) -> CallToolResult:
    async with (
        stdio_client(_parameters(library_root, read_only=read_only)) as (read, write),
        ClientSession(read, write) as session,
    ):
        await session.initialize()
        return await session.call_tool(name, arguments, meta=meta)


def _structured(library_root: Path, name: str, arguments: dict[str, object]) -> object:
    result = asyncio.run(_call_raw(library_root, name, arguments))
    assert not result.is_error, f"{name} failed: {_refusal(result)}"
    return result.structured_content


def test_read_receipt_refuses_malformed_oleafly_task_metadata(tmp_path: Path) -> None:
    library_root = tmp_path / "library"
    service = WorkbenchService.create(library_root)
    project = service.import_manuscript(
        "Synthetic", "manuscript.docx", docx_bytes("<w:p><w:r><w:t>Body text.</w:t></w:r></w:p>")
    )
    project_id = project["project_id"]
    assert isinstance(project_id, str)
    result = asyncio.run(
        _call_raw(
            library_root,
            "read_objects",
            {"project_id": project_id},
            meta={"com.oleafly/research-task": {"task_id": "task-1"}},
        )
    )
    assert result.is_error
    assert "caller" in _refusal(result)


def _refusal(result: CallToolResult) -> str:
    """Return the text a client would actually show for a failed call."""
    parts = [getattr(block, "text", "") for block in result.content]
    return "\n".join(part for part in parts if part)


def _populated_library(root: Path) -> WorkbenchService:
    """Create a library holding one retained rule world."""
    service = WorkbenchService.create(root)
    service.import_world(
        "journal-test",
        "Test Journal",
        [SourceInput("guide.txt", "guide_text", b"All manuscript pages must use A4 paper.")],
    )
    return service


def test_server_exposes_the_full_local_tool_surface_with_read_write_annotations(
    tmp_path: Path,
) -> None:
    WorkbenchService.create(tmp_path / "library")
    tools = asyncio.run(_list_tools(tmp_path / "library"))
    assert {tool.name for tool in tools} == EXPECTED_TOOLS
    for tool in tools:
        assert tool.annotations is not None, tool.name
        assert tool.annotations.read_only_hint is (tool.name not in WRITE_TOOLS), tool.name


def test_read_only_server_omits_management_tools_and_refuses_direct_calls(tmp_path: Path) -> None:
    """Real stdio: a client cannot bypass the tool list by naming a write tool."""
    library_root = tmp_path / "library"
    service = WorkbenchService.create(library_root)
    tools = asyncio.run(_list_tools(library_root, read_only=True))
    assert {tool.name for tool in tools} == EXPECTED_TOOLS - WRITE_TOOLS

    result = asyncio.run(
        _call_raw(
            library_root,
            "import_world",
            {
                "journal_id": "journal-test",
                "journal_name": "Test Journal",
                "sources": [
                    {
                        "name": "guide.txt",
                        "kind": "guide_text",
                        "content_base64": base64.b64encode(b"Use A4 paper.").decode("ascii"),
                    }
                ],
            },
            read_only=True,
        )
    )
    assert result.is_error
    assert "Unknown tool: import_world" in _refusal(result)
    assert service.state()["worlds"] == []
    metadata = asyncio.run(_call_raw(library_root, "method_versions", {}, read_only=True))
    assert metadata.structured_content is not None
    assert metadata.structured_content["scope"] == "read_only"
    assert metadata.structured_content["limits"]["check_execution"] is False


@pytest.mark.parametrize(
    "caller",
    [
        None,
        {
            "system": "oleafly",
            "project_id": "linked-project-1",
            "task_id": "task-1",
            "generation": 3,
        },
    ],
    ids=["without_caller", "oleafly_task"],
)
def test_read_only_server_reads_and_recovers_the_same_retained_response(
    tmp_path: Path, caller: dict[str, object] | None
) -> None:
    library_root = tmp_path / "library"
    service = WorkbenchService.create(library_root)
    project = service.import_manuscript(
        "Synthetic", "manuscript.docx", docx_bytes("<w:p><w:r><w:t>Body text.</w:t></w:r></w:p>")
    )
    project_id = project["project_id"]
    assert isinstance(project_id, str)
    result = asyncio.run(
        _call_raw(
            library_root,
            "read_objects",
            {"project_id": project_id, "region": "body"},
            read_only=True,
            meta={"com.oleafly/research-task": caller} if caller is not None else None,
        )
    )
    assert not result.is_error, _refusal(result)
    response = result.structured_content
    assert isinstance(response, dict)
    assert "Body text." in str(response)
    assert response["read_receipt"].get("caller") == caller
    saved = asyncio.run(
        _call_raw(
            library_root,
            "saved_read",
            {
                "project_id": project_id,
                "read_record_id": response["read_receipt"]["read_record_id"],
            },
            read_only=True,
        )
    )
    assert not saved.is_error, _refusal(saved)
    assert saved.structured_content == response


def test_write_tools_drive_the_full_local_journal_loop(tmp_path: Path) -> None:
    """Import, bind, check, and record a disposition without ever opening the browser."""
    library_root = tmp_path / "library"
    WorkbenchService.create(library_root)
    document = pymupdf.open()
    page = document.new_page()
    page.insert_text((50, 100), "All manuscript pages must use A4 paper.", fontsize=10.0)
    pdf_bytes = document.tobytes()
    document.close()

    world = _structured(
        library_root,
        "import_world",
        {
            "journal_id": "journal-test",
            "journal_name": "Test Journal",
            "sources": [
                {
                    "name": "guide.pdf",
                    "kind": "guide_pdf",
                    "content_base64": base64.b64encode(pdf_bytes).decode("ascii"),
                }
            ],
        },
    )
    assert isinstance(world, dict) and world["version_id"].startswith("world-")

    review = _structured(library_root, "world_review", {"version_id": world["version_id"]})
    assert isinstance(review, dict)
    located = [link for link in review["rule_links"] if link["link_status"] == "located"]
    assert located and located[0]["locator"] == "page:1/block:1"

    manuscript = _structured(
        library_root,
        "import_manuscript",
        {
            "name": "论文工作稿",
            "filename": "稿件.docx",
            "content_base64": base64.b64encode(
                docx_bytes("<w:p><w:r><w:t>Body text.</w:t></w:r></w:p>")
            ).decode("ascii"),
        },
    )
    assert isinstance(manuscript, dict)
    binding = _structured(
        library_root,
        "bind_project",
        {
            "project_id": manuscript["project_id"],
            "world_version_id": world["version_id"],
        },
    )
    assert isinstance(binding, dict) and binding["binding_id"].startswith("binding-")
    check = _structured(library_root, "run_check", {"project_id": manuscript["project_id"]})
    assert isinstance(check, dict) and check["check_id"].startswith("check-")

    disposition = _structured(
        library_root,
        "record_disposition",
        {
            "check_id": check["check_id"],
            "rule_id": check["world"]["rules"][0]["rule_id"],
            "action": "note",
            "note": "与作者确认过",
        },
    )
    assert isinstance(disposition, dict) and disposition["action"] == "note"

    page = _structured(
        library_root,
        "source_page",
        {
            "version_id": world["version_id"],
            "source_id": world["sources"][0]["source_id"],
            "page": 1,
        },
    )
    assert isinstance(page, dict) and len(page["png_base64"]) > 100


def test_import_world_refuses_an_unsupported_kind_legibly(tmp_path: Path) -> None:
    library_root = tmp_path / "library"
    WorkbenchService.create(library_root)
    result = asyncio.run(
        _call_raw(
            library_root,
            "import_world",
            {
                "journal_id": "journal-test",
                "journal_name": "Test Journal",
                "sources": [
                    {
                        "name": "mystery.bin",
                        "kind": "unknown_kind",
                        "content_base64": base64.b64encode(b"x").decode("ascii"),
                    }
                ],
            },
        )
    )
    assert result.is_error
    assert "不支持的来源类型" in _refusal(result)


def test_selection_inputs_are_constrained_by_the_schema(tmp_path: Path) -> None:
    """The generated schema must carry the catalogue, not just accept any string."""
    WorkbenchService.create(tmp_path / "library")
    tools = {tool.name: tool for tool in asyncio.run(_list_tools(tmp_path / "library"))}
    schema = tools["read_objects"].input_schema
    properties = schema["properties"]
    assert set(properties["region"]["anyOf"][0]["enum"]) == {
        "body",
        "header",
        "footer",
        "footnote",
        "endnote",
        "textbox",
    }
    assert "text_block" in properties["object_type"]["anyOf"][0]["enum"]
    assert properties["page_size"]["minimum"] == 1
    assert properties["page_number"]["anyOf"][0]["minimum"] == 1


def test_method_versions_reports_contract_versions_and_limits(tmp_path: Path) -> None:
    library_root = tmp_path / "library"
    WorkbenchService.create(library_root)
    payload = _structured(library_root, "method_versions", {})
    assert isinstance(payload, dict)
    assert payload["server_id"] == "workbench-mcp"
    assert payload["contract_version"] == "workbench-mcp-0.4.1"
    assert payload["scope"] == "local_read_write"
    assert payload["limits"]["manuscript_in_place_editing"] is False
    assert payload["limits"]["check_execution"] is True
    assert payload["limits"]["coverage"] == "partial while the reader declares limits"
    versions = payload["method_versions"]
    assert isinstance(versions, dict)
    for key in ("http", "reader", "report", "query", "world_schema", "analyzer", "checker"):
        assert isinstance(versions.get(key), str) and versions[key], f"missing {key}"


def test_library_state_reports_discovery_without_reading_content(tmp_path: Path) -> None:
    library_root = tmp_path / "library"
    WorkbenchService.create(library_root)
    payload = _structured(library_root, "library_state", {})
    assert isinstance(payload, dict)
    assert payload["projects"] == []
    assert "worlds" in payload
    assert payload["capabilities"]["manuscript_editing"] is False


def test_world_tools_round_trip_a_retained_world(tmp_path: Path) -> None:
    """world_review and diff_worlds must answer for a world that actually exists."""
    library_root = tmp_path / "library"
    _populated_library(library_root)
    state = _structured(library_root, "library_state", {})
    assert isinstance(state, dict)
    version_id = state["worlds"][0]["version_id"]

    review = _structured(library_root, "world_review", {"version_id": version_id})
    assert isinstance(review, dict) and review

    same = _structured(
        library_root, "diff_worlds", {"from_version": version_id, "to_version": version_id}
    )
    assert isinstance(same, dict)


@pytest.mark.parametrize(
    ("tool", "arguments"),
    [
        ("project_detail", {"project_id": "absent"}),
        ("project_history", {"project_id": "absent"}),
        ("manuscript_workspace", {"project_id": "absent"}),
        ("world_review", {"version_id": "world-absent"}),
        ("diff_worlds", {"from_version": "world-a", "to_version": "world-b"}),
        ("check_record", {"check_id": "check-absent"}),
        ("read_objects", {"project_id": "absent"}),
        ("saved_read", {"project_id": "absent", "read_record_id": "read-absent"}),
    ],
)
def test_a_refusal_keeps_its_reason(
    tmp_path: Path, tool: str, arguments: dict[str, object]
) -> None:
    """A refused call must carry the service reason, not a generic execution failure.

    The SDK collapses any exception other than ToolError into the single sentence
    "Error executing tool <name>", which would make every distinct refusal look identical.
    """
    library_root = tmp_path / "library"
    WorkbenchService.create(library_root)
    result = asyncio.run(_call_raw(library_root, tool, arguments))
    assert result.is_error, f"{tool} accepted an invalid request"
    message = _refusal(result)
    assert message != f"Error executing tool {tool}", f"{tool} lost its refusal reason"
    prefix = f"Error executing tool {tool}: "
    assert message.startswith(prefix), f"{tool} produced an unexpected shape: {message!r}"
    assert message[len(prefix) :].strip(), f"{tool} refused with an empty reason"


def test_distinct_refusals_are_distinguishable(tmp_path: Path) -> None:
    """Different causes must not collapse into one message, or a client cannot react."""
    library_root = tmp_path / "library"
    _populated_library(library_root)
    state = _structured(library_root, "library_state", {})
    assert isinstance(state, dict)
    version_id = state["worlds"][0]["version_id"]

    calls = [
        ("project_detail", {"project_id": "absent"}),
        ("world_review", {"version_id": "world-absent"}),
        ("check_record", {"check_id": "check-absent"}),
        ("diff_worlds", {"from_version": version_id, "to_version": "world-absent"}),
    ]
    reasons = set()
    for tool, arguments in calls:
        result = asyncio.run(_call_raw(library_root, tool, arguments))
        assert result.is_error, f"{tool} accepted an invalid request"
        reasons.add(_refusal(result))
    assert len(reasons) == len(calls), f"refusals collapsed into {reasons}"


def test_invalid_selection_is_refused_with_the_supported_values(tmp_path: Path) -> None:
    """An out-of-catalogue selection is a refusal the client can act on."""
    library_root = tmp_path / "library"
    WorkbenchService.create(library_root)
    result = asyncio.run(
        _call_raw(
            library_root,
            "read_objects",
            {"project_id": "absent", "region": "not-a-region"},
        )
    )
    assert result.is_error
    assert "not-a-region" in _refusal(result)


def test_out_of_range_page_size_is_refused_before_reaching_the_service(tmp_path: Path) -> None:
    """The declared bounds are enforced by the input schema, not silently coerced."""
    library_root = tmp_path / "library"
    _populated_library(library_root)
    result = asyncio.run(
        _call_raw(library_root, "read_objects", {"project_id": "absent", "page_size": 0})
    )
    assert result.is_error


def test_blank_library_root_is_refused_at_startup(tmp_path: Path) -> None:
    """An unset location must fail loudly, not fall back to the working directory."""
    from research_file_workbench.workbench.mcp import _library_root

    for blank in (None, "", "   "):
        with pytest.raises(ValueError, match="library root is required"):
            _library_root(blank)


@pytest.mark.parametrize("read_only", [False, True])
def test_unknown_argument_is_refused_before_any_content_read(
    tmp_path: Path, read_only: bool
) -> None:
    """A misspelled selector must not broaden the selection or create a read receipt."""
    library_root = tmp_path / "library"
    service = WorkbenchService.create(library_root)
    project = service.import_manuscript(
        "Synthetic", "manuscript.docx", docx_bytes("<w:p><w:r><w:t>Body text.</w:t></w:r></w:p>")
    )
    project_id = project["project_id"]
    assert isinstance(project_id, str)
    before = service.history(project_id)
    result = asyncio.run(
        _call_raw(
            library_root,
            "read_objects",
            {"project_id": project_id, "object_typ": "text_block"},
            read_only=read_only,
        )
    )
    assert result.is_error
    assert "Unknown arguments for read_objects: object_typ." in _refusal(result)
    assert service.history(project_id) == before


def test_revise_rule_creates_a_new_world_version(tmp_path: Path) -> None:
    library_root = tmp_path / "library"
    service = _populated_library(library_root)
    worlds = service.state()["worlds"]
    version_id = worlds[0]["version_id"]
    rule_id = service.review(version_id)["rule_links"][0]["rule_id"]

    revised = _structured(
        library_root,
        "revise_rule",
        {"version_id": version_id, "rule_id": rule_id, "expected": 12240, "reason": "改用 Letter"},
    )
    assert isinstance(revised, dict)
    assert revised["version_id"] != version_id
    assert revised["version_id"].startswith("world-")


def test_update_manuscript_reports_a_conflict_as_a_refusal(tmp_path: Path) -> None:
    """A compare-and-swap mismatch reaches the client as a refusal naming the real baseline."""
    library_root = tmp_path / "library"
    WorkbenchService.create(library_root)
    content = base64.b64encode(docx_bytes("<w:p><w:r><w:t>Body text.</w:t></w:r></w:p>")).decode(
        "ascii"
    )
    project = _structured(
        library_root,
        "import_manuscript",
        {"name": "论文", "filename": "稿件.docx", "content_base64": content},
    )
    assert isinstance(project, dict)
    result = asyncio.run(
        _call_raw(
            library_root,
            "update_manuscript",
            {
                "project_id": project["project_id"],
                "expected_baseline_id": "baseline-absent",
                "filename": "稿件2.docx",
                "content_base64": content,
                "reason": "修订稿",
                "request_id": "request-1",
            },
        )
    )
    assert result.is_error
    refusal = _refusal(result)
    assert "BASELINE_CONFLICT" in refusal
    assert str(project["baseline_id"]) in refusal


def test_update_manuscript_reports_idempotency_reuse_as_a_refusal(tmp_path: Path) -> None:
    """Reusing a request identity for different content is a declared refusal, not a retry."""
    library_root = tmp_path / "library"
    WorkbenchService.create(library_root)
    first = base64.b64encode(docx_bytes("<w:p><w:r><w:t>Body text.</w:t></w:r></w:p>")).decode(
        "ascii"
    )
    second = base64.b64encode(
        docx_bytes("<w:p><w:r><w:t>Revised body text.</w:t></w:r></w:p>")
    ).decode("ascii")
    project = _structured(
        library_root,
        "import_manuscript",
        {"name": "论文", "filename": "稿件.docx", "content_base64": first},
    )
    assert isinstance(project, dict)
    arguments = {
        "project_id": project["project_id"],
        "expected_baseline_id": project["baseline_id"],
        "filename": "稿件2.docx",
        "reason": "修订稿",
        "request_id": "request-1",
    }
    applied = _structured(library_root, "update_manuscript", {**arguments, "content_base64": first})
    assert isinstance(applied, dict)
    assert applied["status"] == "APPLIED"
    result = asyncio.run(
        _call_raw(library_root, "update_manuscript", {**arguments, "content_base64": second})
    )
    assert result.is_error
    assert "IDEMPOTENCY_CONFLICT" in _refusal(result)


def test_update_manuscript_refuses_a_blank_reason(tmp_path: Path) -> None:
    library_root = tmp_path / "library"
    WorkbenchService.create(library_root)
    content = base64.b64encode(docx_bytes("<w:p><w:r><w:t>Body text.</w:t></w:r></w:p>")).decode(
        "ascii"
    )
    project = _structured(
        library_root,
        "import_manuscript",
        {"name": "论文", "filename": "稿件.docx", "content_base64": content},
    )
    assert isinstance(project, dict)
    result = asyncio.run(
        _call_raw(
            library_root,
            "update_manuscript",
            {
                "project_id": project["project_id"],
                "expected_baseline_id": project["baseline_id"],
                "filename": "稿件2.docx",
                "content_base64": content,
                "reason": "   ",
                "request_id": "request-1",
            },
        )
    )
    assert result.is_error
    assert "请填写版本更新原因" in _refusal(result)
