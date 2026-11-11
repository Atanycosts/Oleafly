"""GET API routing kept separate from HTTP transport mechanics."""

from __future__ import annotations

from http import HTTPStatus
from typing import TYPE_CHECKING

from research_file_workbench.workbench.http_boundary import query_text, require_query_fields

if TYPE_CHECKING:
    from research_file_workbench.workbench.request_handler import WorkbenchRequestHandler


def handle_api_get(
    handler: WorkbenchRequestHandler, path: str, query: dict[str, list[str]]
) -> None:
    """Dispatch a validated local GET request to the application service."""
    if path == "/api/state":
        require_query_fields(query, set())
        handler._json(handler.server.service.state())
    elif path == "/api/review":
        require_query_fields(query, {"version_id"})
        handler._json(handler.server.service.review(query_text(query, "version_id")))
    elif path == "/api/source-page":
        require_query_fields(query, {"version_id", "source_id", "page"})
        handler._json(
            handler.server.service.source_page(
                query_text(query, "version_id"),
                query_text(query, "source_id"),
                int(query_text(query, "page")),
            )
        )
    elif path == "/api/manuscript":
        require_query_fields(query, {"project_id", "baseline_id"})
        baseline = query_text(query, "baseline_id")
        handler._json(
            handler.server.service.manuscript(
                query_text(query, "project_id"),
                None if baseline == "current" else baseline,
            )
        )
    elif path == "/api/manuscript-source":
        require_query_fields(query, {"project_id", "baseline_id"})
        handler._json(
            handler.server.service.manuscript_source(
                query_text(query, "project_id"),
                query_text(query, "baseline_id"),
            )
        )
    elif path == "/api/derived-renders":
        require_query_fields(query, {"project_id", "baseline_id"})
        handler._json(
            handler.server.service.derived_renders(
                query_text(query, "project_id"),
                query_text(query, "baseline_id"),
            )
        )
    elif path == "/api/history":
        require_query_fields(query, {"project_id"})
        handler._json(handler.server.service.history(query_text(query, "project_id")))
    elif path == "/api/read":
        require_query_fields(query, {"project_id", "read_record_id"})
        handler._json(
            handler.server.service.saved_read(
                query_text(query, "project_id"), query_text(query, "read_record_id")
            )
        )
    elif path == "/api/render":
        require_query_fields(
            query, {"project_id", "baseline_id", "bundle_id", "role", "page_number"}
        )
        page, role = query_text(query, "page_number"), query_text(query, "role")
        content = handler.server.service.render_artifact(
            query_text(query, "project_id"),
            query_text(query, "baseline_id"),
            query_text(query, "bundle_id"),
            role,
            None if page == "none" else int(page),
        )
        handler._send(HTTPStatus.OK, content, "application/pdf" if role == "pdf" else "image/png")
    elif path == "/api/world":
        require_query_fields(query, {"version_id"})
        handler._json(handler.server.service.store.get_world(query_text(query, "version_id")))
    elif path == "/api/check":
        require_query_fields(query, {"check_id"})
        handler._json(handler.server.service.check_record(query_text(query, "check_id")))
    elif path == "/api/diff":
        require_query_fields(query, {"from_version", "to_version"})
        handler._json(
            handler.server.service.diff_worlds(
                query_text(query, "from_version"), query_text(query, "to_version")
            )
        )
    else:
        handler._json_error(HTTPStatus.NOT_FOUND, "接口不存在。")
