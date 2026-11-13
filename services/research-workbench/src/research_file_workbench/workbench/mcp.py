"""Local Model Context Protocol surface over the workbench library.

The baseline declares MCP the unified entry for agents that share the workspace with the
operator. This module is a transport, not a second implementation: every tool delegates to
`WorkbenchService`, so the query boundary, method versions, receipts and refusals stay in
one place.

The read and write tools project the same operations the browser and the operator CLI
expose. Two records stay operator-only on purpose: author decisions refuse agent
proposals by design, and render-bundle registration captures independent human evidence
through the CLI or the browser.

A declared refusal must stay legible. The SDK turns any exception other than `ToolError` into
the single message "Error executing tool <name>", which would make an unsupported region, an
expired cursor and an unknown project indistinguishable to the client. Service refusals are
`ValueError` subclasses, so `_read` and `_write` re-raise them as `ToolError` and the reason
survives.
"""

from __future__ import annotations

import argparse
import os
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any, Literal

from mcp.server.context import CallNext, HandlerResult, ServerRequestContext
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import CallToolResult, TextContent, ToolAnnotations

from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.docx.query import (
    OBJECT_TYPES,
    QUERY_VERSION,
    REGIONS,
)
from research_file_workbench.docx.read_receipt import READ_RECEIPT_VERSION
from research_file_workbench.docx.report import READER_VERSION, REPORT_VERSION
from research_file_workbench.journals.models import (
    ANALYZER_VERSION,
    CHECKER_VERSION,
    WORLD_SCHEMA_VERSION,
)
from research_file_workbench.workbench.mcp_tools import register_read_tools, register_write_tools
from research_file_workbench.workbench.server import HTTP_CONTRACT_VERSION
from research_file_workbench.workbench.service import WorkbenchService

SERVER_NAME = "research-file-workbench"
SERVER_ID = "workbench-mcp"
SERVER_VERSION = "0.4.1"
CONTRACT_VERSION = "workbench-mcp-0.5.0"
LIBRARY_ROOT_ENV = "RFW_LIBRARY_ROOT"

# Bound to contracts/s1/mcp-surface.json by tests/engineering/test_architecture.py. A change
# here is a boundary change and must update the contract in the same commit.
METHOD_VERSIONS = {
    "http": HTTP_CONTRACT_VERSION,
    "reader": READER_VERSION,
    "report": REPORT_VERSION,
    "query": QUERY_VERSION,
    "read_receipt": READ_RECEIPT_VERSION,
    "world_schema": WORLD_SCHEMA_VERSION,
    "analyzer": ANALYZER_VERSION,
    "checker": CHECKER_VERSION,
}

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

# The literals above must stay aligned with the query catalogue in docx/query.py.
assert set(Region.__args__) == set(REGIONS)  # type: ignore[attr-defined]
assert set(ObjectType.__args__) == set(OBJECT_TYPES)  # type: ignore[attr-defined]

READ_ONLY = ToolAnnotations(read_only_hint=True, idempotent_hint=True)
WRITE = ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=False)

INSTRUCTIONS = """\
Local research-file workbench over a managed library of journal rule worlds and DOCX
manuscript projects. This server, the operator CLI, and the desktop browser surface project
the same WorkbenchService operations: agents work here, humans work in the browser.

What the workbench can do: report the library state and project bindings, import journal
worlds and manuscripts, update a manuscript as a new retained baseline, deliver selected
manuscript objects through the persistent query boundary with a read receipt, recover exact
saved responses and check records, diff world versions, revise rules as new world versions,
bind a project with compare-and-swap control, run a check against the bound world, record
notes and deferrals, and render retained PDF source pages as a reading aid.

What this server will not do: modify a manuscript's bytes in place, publish an author
decision (those refuse agent proposals by design), register page-evidence render bundles
(those must come from an independent human review through the operator CLI or browser), or
invent page coordinates. Discovery does not count as reading content, and a returned range
does not prove semantic understanding. Where the reader declares limits, coverage stays
partial.

A read-only server exposes discovery, manuscript reading and saved evidence only. Management
tools are registered only when the server starts without --read-only. Read receipts are still
persisted. Unknown tool argument names are refused instead of silently ignored.

A refused request returns the reason. Treat a refusal as the answer, not as a transport
failure to retry.
"""


def _read(call: Callable[[], JsonObject]) -> dict[str, Any]:
    """Run one service read, keeping a declared refusal legible to the client."""
    try:
        return dict(call())
    except ValueError as exc:
        raise ToolError(str(exc)) from exc


def _write(call: Callable[[], JsonObject]) -> dict[str, Any]:
    """Run one service write, keeping a declared refusal legible to the client."""
    try:
        return dict(call())
    except ValueError as exc:
        raise ToolError(str(exc)) from exc


def build_server(service: WorkbenchService, *, read_only: bool = False) -> MCPServer:
    """Register the local tool surface over one opened library."""
    server = MCPServer(
        name=SERVER_NAME,
        title="Research file workbench",
        version=SERVER_VERSION,
        instructions=INSTRUCTIONS,
    )
    register_read_tools(
        server,
        service,
        _read,
        read_only=READ_ONLY,
        server_id=SERVER_ID,
        method_versions_map=METHOD_VERSIONS,
        server_version=SERVER_VERSION,
        contract_version=CONTRACT_VERSION,
        scope="read_only" if read_only else "local_read_write",
    )
    if not read_only:
        register_write_tools(server, service, _write, write_annotations=WRITE)

    async def require_declared_arguments(
        ctx: ServerRequestContext[Any, Any], call_next: CallNext
    ) -> HandlerResult:
        # Reuse the SDK's generated field names; the SDK owns value validation.
        if ctx.method == "tools/call" and ctx.params is not None:
            arguments = ctx.params.get("arguments")
            if isinstance(arguments, dict):
                name = ctx.params.get("name")
                for tool in await server.list_tools():
                    if tool.name == name:
                        unexpected = arguments.keys() - tool.input_schema["properties"].keys()
                        if unexpected:
                            return CallToolResult(
                                is_error=True,
                                content=[
                                    TextContent(
                                        type="text",
                                        text=f"Unknown arguments for {name}: "
                                        f"{', '.join(sorted(unexpected))}.",
                                    )
                                ],
                            )
                        break
        return await call_next(ctx)

    server.middleware.append(require_declared_arguments)
    return server


def _library_root(value: str | None) -> Path:
    """Resolve the requested library, refusing an unset or blank location outright."""
    if value is None or not value.strip():
        raise ValueError(
            f"A library root is required: pass --library-root or set {LIBRARY_ROOT_ENV}."
        )
    return Path(value.strip())


def serve(library_root: Path, *, read_only: bool = False) -> None:
    """Open an existing library and answer MCP over stdio until the client disconnects."""
    service = WorkbenchService(library_root)
    build_server(service, read_only=read_only).run(transport="stdio")


def main(argv: list[str] | None = None) -> int:
    """Run the local MCP server, reporting failures through exit status."""
    parser = argparse.ArgumentParser(prog="rfw-workbench-mcp")
    parser.add_argument(
        "--library-root",
        default=os.environ.get(LIBRARY_ROOT_ENV),
        help=f"Managed library directory. Defaults to ${LIBRARY_ROOT_ENV}.",
    )
    parser.add_argument(
        "--read-only",
        action="store_true",
        help="Expose discovery and retained reads only; do not register management tools.",
    )
    args = parser.parse_args(argv)
    try:
        library_root = _library_root(args.library_root)
        print(f"WORKBENCH_MCP_LIBRARY: {library_root.resolve()}", file=sys.stderr)
        serve(library_root, read_only=args.read_only)
    except (OSError, ValueError) as exc:
        print(f"WORKBENCH_MCP_FAILED: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
