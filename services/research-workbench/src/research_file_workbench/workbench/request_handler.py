"""HTTP request routing for the local workbench server."""

from __future__ import annotations

from http import HTTPStatus
from http.server import BaseHTTPRequestHandler
from typing import TYPE_CHECKING, cast
from urllib.parse import parse_qs, urlparse

from research_file_workbench.common.json_io import JsonDocumentError
from research_file_workbench.docx.query import ReadQuery, ReadQueryError
from research_file_workbench.journals.models import SourceInput, require_keys
from research_file_workbench.journals.store_records import BindingConflictError, WorldStoreError
from research_file_workbench.projects.models import BaselineConflictError, ProjectStoreError
from research_file_workbench.projects.render_service import (
    RenderConversionError,
    RendererUnavailableError,
)
from research_file_workbench.workbench.get_routes import handle_api_get
from research_file_workbench.workbench.http_boundary import (
    HTTP_CONTRACT_VERSION,
    REQUEST_TIMEOUT_SECONDS,
    RequestError,
    SessionError,
    captured_bytes,
    decode_request_json,
    discard_request_body,
    encode_json_body,
    named_upload,
    optional_text,
    require_local_origin,
    require_query_fields,
    require_session_token,
    text,
)
from research_file_workbench.workbench.service import ManuscriptUpdateRefused

if TYPE_CHECKING:
    from research_file_workbench.workbench.server import WorkbenchHttpServer

__all__ = ["WorkbenchRequestHandler"]


class WorkbenchRequestHandler(BaseHTTPRequestHandler):
    """Serve static UI assets and JSON API calls without exposing files."""

    server: WorkbenchHttpServer
    protocol_version = "HTTP/1.1"

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(REQUEST_TIMEOUT_SECONDS)
        self._request_body_handled = False

    def do_GET(self) -> None:  # noqa: N802
        try:
            self._require_local_origin()
            parsed = urlparse(self.path)
            query = parse_qs(parsed.query, keep_blank_values=True)
            if parsed.path == "/api/session":
                require_query_fields(query, set())
                self._json(
                    {
                        "token": self.server.session_token,
                        "contract_version": HTTP_CONTRACT_VERSION,
                        "asset_version": self.server.asset_version,
                    }
                )
            elif parsed.path == "/favicon.ico":
                self._send(HTTPStatus.NO_CONTENT, b"", "image/x-icon")
            elif parsed.path.startswith("/api/"):
                self._handle_api_get(parsed.path, query)
            else:
                self._static(parsed.path)
        except SessionError as exc:
            self._discard_request_body()
            self.close_connection = True
            self._json_error(HTTPStatus.FORBIDDEN, str(exc))
        except BaselineConflictError:
            self._json_error(HTTPStatus.CONFLICT, "论文版本已变化，请重新读取当前状态。")
        except (WorldStoreError, ProjectStoreError):
            self._error_internal()
        except (OSError, ValueError, JsonDocumentError) as exc:
            self._error(exc)

    def do_POST(self) -> None:  # noqa: N802
        try:
            self._require_local_origin()
            self._require_token()
            parsed = urlparse(self.path)
            require_query_fields(parse_qs(parsed.query, keep_blank_values=True), set())
            payload = self._request_json()
            routes = {
                "/api/worlds": self._create_world,
                "/api/world-component": self._import_component,
                "/api/projects": self._create_project,
                "/api/read": self._read_manuscript,
                "/api/render-bundle": self._register_render_bundle,
                "/api/render-baseline": self._render_baseline,
            }
            route = routes.get(parsed.path)
            if route is not None:
                route(payload)
            elif parsed.path == "/api/baseline":
                self._update_baseline(payload)
            elif parsed.path == "/api/bind":
                self._bind(payload)
            elif parsed.path == "/api/check":
                require_keys(payload, {"project_id"})
                self._json(
                    self.server.service.run_check(text(payload, "project_id"), surface="browser")
                )
            elif parsed.path == "/api/disposition":
                require_keys(payload, {"check_id", "rule_id", "action", "note"})
                self._json(
                    self.server.service.disposition(
                        text(payload, "check_id"),
                        text(payload, "rule_id"),
                        text(payload, "action"),
                        text(payload, "note"),
                        surface="browser",
                    )
                )
            elif parsed.path == "/api/revise":
                self._revise(payload)
            else:
                self._json_error(HTTPStatus.NOT_FOUND, "接口不存在。")
        except SessionError as exc:
            self._discard_request_body()
            self.close_connection = True
            self._json_error(HTTPStatus.FORBIDDEN, str(exc))
        except BindingConflictError as exc:
            self._json_error(HTTPStatus.CONFLICT, str(exc))
        except BaselineConflictError as exc:
            self._json_error(
                HTTPStatus.CONFLICT, "论文版本已变化，请重新读取当前状态。", result=exc.result
            )
        except ManuscriptUpdateRefused as exc:
            self._json_error(HTTPStatus.BAD_REQUEST, str(exc), result=exc.result)
        except RendererUnavailableError as exc:
            self._json_error(HTTPStatus.SERVICE_UNAVAILABLE, str(exc), code=exc.code)
        except RenderConversionError as exc:
            self._json_error(HTTPStatus.BAD_GATEWAY, str(exc), code=exc.code)
        except ReadQueryError:
            self._json_error(
                HTTPStatus.BAD_REQUEST,
                "无法按此范围读取，请重新选择对象；按页读取需要独立审查过的页面证据。",
            )
        except (WorldStoreError, ProjectStoreError):
            self._error_internal()
        except (OSError, ValueError, JsonDocumentError) as exc:
            self._error(exc)

    def log_message(self, format: str, *args: object) -> None:
        """Keep the local UI server quiet; operation errors are returned as JSON."""

    def _handle_api_get(self, path: str, query: dict[str, list[str]]) -> None:
        handle_api_get(self, path, query)

    def _create_world(self, payload: dict[str, object]) -> None:
        require_keys(
            payload, {"journal_id", "journal_name", "article_type", "stage", "language", "sources"}
        )
        raw_sources = payload.get("sources")
        if not isinstance(raw_sources, list) or not raw_sources:
            raise ValueError("请至少提供一个期刊来源文件。")
        sources: list[SourceInput] = []
        for raw in raw_sources:
            if not isinstance(raw, dict):
                raise ValueError("来源记录格式无效。")
            require_keys(raw, {"name", "kind", "content_base64"})
            sources.append(SourceInput(text(raw, "name"), text(raw, "kind"), captured_bytes(raw)))
        self._json(
            self.server.service.import_world(
                text(payload, "journal_id"),
                text(payload, "journal_name"),
                sources,
                article_type=text(payload, "article_type"),
                stage=text(payload, "stage"),
                language=text(payload, "language"),
            )
        )

    def _create_project(self, payload: dict[str, object]) -> None:
        require_keys(payload, {"name", "filename", "content_base64"})
        self._json(
            self.server.service.import_manuscript(
                text(payload, "name"), text(payload, "filename"), captured_bytes(payload)
            )
        )

    def _import_component(self, payload: dict[str, object]) -> None:
        require_keys(
            payload,
            {"version_id", "name", "content_base64"},
            {"sources", "decisions", "preview"},
        )
        sources = payload.get("sources", [])
        decisions = payload.get("decisions", [])
        preview = payload.get("preview", False)
        if not isinstance(sources, list) or not isinstance(decisions, list):
            raise RequestError("Sources and decisions must be lists.")
        if type(preview) is not bool:
            raise RequestError("preview must be a boolean.")
        captured = []
        for source in sources:
            if not isinstance(source, dict):
                raise RequestError("A captured source must be an object.")
            require_keys(source, {"name", "kind", "content_base64"})
            captured.append(
                SourceInput(text(source, "name"), text(source, "kind"), captured_bytes(source))
            )
        if any(not isinstance(decision, dict) for decision in decisions):
            raise RequestError("A rule decision must be an object.")
        self._json(
            self.server.service.import_component(
                text(payload, "version_id"),
                text(payload, "name"),
                captured_bytes(payload),
                sources=tuple(captured),
                decisions=tuple(decisions),
                preview=preview,
            )
        )

    def _read_manuscript(self, payload: dict[str, object]) -> None:
        require_keys(payload, {"project_id", "baseline_id", "render_bundle_id", "query"})
        query = payload["query"]
        if not isinstance(query, dict):
            raise RequestError("请选择读取范围。")
        require_keys(
            query, {"region", "object_type", "object_id", "page_number", "page_size", "cursor"}
        )
        size, page = query["page_size"], query["page_number"]
        if type(size) is not int or (page is not None and type(page) is not int):
            raise RequestError("读取页数无效。")
        selection = ReadQuery(
            region=optional_text(query, "region"),
            object_type=optional_text(query, "object_type"),
            object_id=optional_text(query, "object_id"),
            page_number=page,
            page_size=size,
            cursor=optional_text(query, "cursor"),
        )
        self._json(
            self.server.service.read(
                text(payload, "project_id"),
                selection,
                optional_text(payload, "baseline_id"),
                optional_text(payload, "render_bundle_id"),
            )
        )

    def _update_baseline(self, payload: dict[str, object]) -> None:
        require_keys(
            payload,
            {
                "project_id",
                "expected_baseline_id",
                "filename",
                "content_base64",
                "reason",
                "request_id",
            },
        )
        result = self.server.service.update_manuscript(
            text(payload, "project_id"),
            text(payload, "expected_baseline_id"),
            text(payload, "filename"),
            captured_bytes(payload),
            text(payload, "reason"),
            text(payload, "request_id"),
            surface="browser",
        )
        self._json(result)

    def _bind(self, payload: dict[str, object]) -> None:
        require_keys(payload, {"project_id", "world_version_id", "expected_binding_id"})
        self._json(
            self.server.service.bind(
                text(payload, "project_id"),
                text(payload, "world_version_id"),
                optional_text(payload, "expected_binding_id"),
                surface="browser",
            )
        )

    def _revise(self, payload: dict[str, object]) -> None:
        require_keys(payload, {"version_id", "rule_id", "expected", "reason"})
        expected = payload.get("expected")
        if type(expected) is not int and not isinstance(expected, str):
            raise ValueError("expected must be an integer or font name")
        self._json(
            self.server.service.revise(
                text(payload, "version_id"),
                text(payload, "rule_id"),
                expected,
                text(payload, "reason"),
            )
        )

    def _register_render_bundle(self, payload: dict[str, object]) -> None:
        from research_file_workbench.projects.render_service import register_render_bytes

        require_keys(
            payload,
            {
                "project_id",
                "baseline_id",
                "reason",
                "render_record",
                "page_index",
                "pdf",
                "pages",
                "document_annotation",
                "page_evidence",
            },
        )
        pages = payload["pages"]
        if not isinstance(pages, list):
            raise RequestError("请选择页面图片。")
        page_images: dict[int, bytes] = {}
        for item in pages:
            if not isinstance(item, dict):
                raise RequestError("页面图片记录不完整。")
            require_keys(item, {"page_number", "content_base64"})
            number = item["page_number"]
            if type(number) is not int or number < 1 or number in page_images:
                raise RequestError("页码必须唯一且大于零。")
            page_images[number] = captured_bytes(item)
        self._json(
            register_render_bytes(
                self.server.service.project_root(text(payload, "project_id")),
                baseline_id=text(payload, "baseline_id"),
                render_record=named_upload(payload, "render_record"),
                page_index=named_upload(payload, "page_index"),
                pdf_bytes=named_upload(payload, "pdf"),
                page_images=page_images,
                actor_id="local-operator",
                confirmation_reason=text(payload, "reason"),
                document_annotation=None
                if payload["document_annotation"] is None
                else named_upload(payload, "document_annotation"),
                page_evidence=None
                if payload["page_evidence"] is None
                else named_upload(payload, "page_evidence"),
            )
        )

    def _render_baseline(self, payload: dict[str, object]) -> None:
        require_keys(
            payload,
            {
                "project_id",
                "baseline_id",
                "reason",
                "libreoffice_executable",
            },
        )
        self._json(
            self.server.service.render_baseline(
                text(payload, "project_id"),
                text(payload, "baseline_id"),
                libreoffice_executable=text(payload, "libreoffice_executable"),
                reason=text(payload, "reason"),
            )
        )

    def _request_json(self) -> dict[str, object]:
        self._request_body_handled = True
        return decode_request_json(
            self.headers.get_content_type(),
            self.headers.get("Transfer-Encoding"),
            self.headers.get_all("Content-Length", []),
            self.rfile.read,
        )

    def do_PUT(self) -> None:  # noqa: N802
        self._method_not_allowed()

    def do_DELETE(self) -> None:  # noqa: N802
        self._method_not_allowed()

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._method_not_allowed()

    def send_error(self, code: int, message: str | None = None, explain: str | None = None) -> None:
        if code == HTTPStatus.NOT_IMPLEMENTED:
            self._method_not_allowed()
            return
        super().send_error(code, message, explain)

    def _method_not_allowed(self) -> None:
        self.close_connection = True
        self._json_error(
            HTTPStatus.METHOD_NOT_ALLOWED, "只支持 GET 和 POST 请求。", allow="GET, POST"
        )

    def _require_token(self) -> None:
        require_session_token(self.headers.get("X-RFW-Token", ""), self.server.session_token)

    def _discard_request_body(self) -> None:
        if self._request_body_handled:
            return
        self._request_body_handled = True
        discard_request_body(self.headers.get("Content-Length"), self.rfile.read)

    def _require_local_origin(self) -> None:
        port = self.server.server_port
        address = cast(str, self.server.server_address[0])
        hosts = {f"{address}:{port}"}
        if address == "127.0.0.1":
            hosts.add(f"localhost:{port}")
        require_local_origin(
            self.headers.get("Host", ""),
            self.headers.get("Origin"),
            self.headers.get("Sec-Fetch-Site"),
            hosts,
        )

    def _static(self, path: str) -> None:
        if path not in self.server.assets:
            self._json_error(HTTPStatus.NOT_FOUND, "页面不存在。")
            return
        content, content_type = self.server.assets[path]
        self._send(HTTPStatus.OK, content, content_type)

    def _json(self, value: dict[str, object]) -> None:
        self._send(HTTPStatus.OK, encode_json_body(value), "application/json; charset=utf-8")

    def _json_error(
        self,
        status: HTTPStatus,
        message: str,
        *,
        allow: str | None = None,
        code: str | None = None,
        result: dict[str, object] | None = None,
    ) -> None:
        payload: dict[str, object] = {"error": message}
        if result is not None:
            payload.update(result)
        if code is not None:
            payload["code"] = code
        self._send(
            status,
            encode_json_body(payload),
            "application/json; charset=utf-8",
            allow=allow,
        )

    def _send(
        self, status: HTTPStatus, content: bytes, content_type: str, *, allow: str | None = None
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        if allow is not None:
            self.send_header("Allow", allow)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; object-src 'none'; frame-ancestors 'none'",
        )
        self.end_headers()
        self.wfile.write(content)

    def _error(self, exc: Exception) -> None:
        self._discard_request_body()
        self.close_connection = True
        if isinstance(exc, (OSError, WorldStoreError, ProjectStoreError, JsonDocumentError)):
            self._error_internal()
            return
        self._json_error(HTTPStatus.BAD_REQUEST, "请求无效，请检查字段、查询参数和内容格式。")

    def _error_internal(self) -> None:
        self.close_connection = True
        self._json_error(HTTPStatus.INTERNAL_SERVER_ERROR, "工作台内部数据无法验证，请检查应用库。")
