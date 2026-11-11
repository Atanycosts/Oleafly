"""Pure HTTP boundary validation and encoding helpers for the local workbench.

The request handler owns routing and service orchestration.  This module keeps the
wire-format rules in one place so route code cannot accidentally diverge on text,
query, upload, or request framing validation.
"""

from __future__ import annotations

import base64
import binascii
import os
from collections.abc import Callable, Iterable
from pathlib import Path

from research_file_workbench.common.filesystem import require_no_reparse_points
from research_file_workbench.common.json_io import (
    JsonDocumentError,
    decode_json_object,
    encode_json_object,
)

MAX_REQUEST_BYTES = 96 * 1024 * 1024
REQUEST_TIMEOUT_SECONDS = 30
HTTP_CONTRACT_VERSION = "journal-http-1.7.0"
STATIC_ROOT = Path(__file__).with_name("web")
STATIC_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


class SessionError(PermissionError):
    """Raised when a browser request lacks the current local session token."""


class RequestError(ValueError):
    """Raised when an HTTP request body cannot satisfy its declared framing."""


def static_files() -> dict[str, tuple[str, str]]:
    """Discover packaged assets, refusing links outside the asset root."""
    routes = {"/": ("index.html", STATIC_CONTENT_TYPES[".html"])}
    require_no_reparse_points(STATIC_ROOT)
    for directory, directories, filenames in os.walk(STATIC_ROOT, followlinks=False):
        for name in directories:
            require_no_reparse_points(Path(directory) / name)
        for name in sorted(filenames):
            path = Path(directory) / name
            if path.suffix not in STATIC_CONTENT_TYPES:
                continue
            require_no_reparse_points(path)
            relative = path.relative_to(STATIC_ROOT).as_posix()
            routes[f"/{relative}"] = (relative, STATIC_CONTENT_TYPES[path.suffix])
    return dict(sorted(routes.items()))


def text(record: dict[str, object], key: str) -> str:
    """Return a required non-empty text field from a decoded request object."""
    value = record.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"请求缺少 {key}。")
    return value


def optional_text(record: dict[str, object], key: str) -> str | None:
    """Return an optional non-empty text field, preserving an explicit null."""
    value = record.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"请求字段 {key} 无效。")
    return value


def query_text(query: dict[str, list[str]], key: str) -> str:
    """Return one non-empty query parameter value."""
    values = query.get(key)
    if values is None or len(values) != 1 or not values[0].strip():
        raise ValueError(f"查询缺少 {key}。")
    return values[0]


def require_query_fields(query: dict[str, list[str]], expected: set[str]) -> None:
    """Require exactly the declared query keys, each occurring once and non-empty."""
    if set(query) != expected or any(len(values) != 1 for values in query.values()):
        raise RequestError("查询参数不符合接口定义。")
    for values in query.values():
        if not values[0].strip():
            raise RequestError("查询参数不符合接口定义。")


def captured_bytes(payload: dict[str, object]) -> bytes:
    """Decode a bounded base64 upload from a request object."""
    encoded = text(payload, "content_base64")
    try:
        content = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("上传文件编码无效，请重新选择文件。") from exc
    if len(content) > MAX_REQUEST_BYTES:
        raise ValueError("上传文件超过大小限制。")
    return content


def named_upload(payload: dict[str, object], key: str) -> bytes:
    """Decode one named upload record nested in a request object."""
    value = payload[key]
    if not isinstance(value, dict):
        raise RequestError("上传文件记录不完整。")
    if set(value) != {"content_base64"}:
        raise RequestError("上传文件记录不完整。")
    return captured_bytes(value)


def decode_request_json(
    content_type: str,
    transfer_encoding: str | None,
    content_lengths: Iterable[str],
    read_body: Callable[[int], bytes],
) -> dict[str, object]:
    """Validate request framing and decode one bounded JSON object body."""
    if content_type != "application/json":
        raise ValueError("请求需要使用 JSON 格式。")
    if transfer_encoding is not None:
        raise ValueError("不支持分块请求，请提交完整文件。")
    lengths = list(content_lengths)
    if len(lengths) != 1:
        raise ValueError("请求需要唯一的内容长度。")
    raw_length = lengths[0]
    if not raw_length.isdigit():
        raise ValueError("请求缺少有效长度。")
    length = int(raw_length)
    if length > MAX_REQUEST_BYTES:
        raise ValueError("请求超过大小限制。")
    payload = read_body(length)
    if len(payload) != length:
        raise ValueError("请求内容不完整。")
    try:
        value = decode_json_object(payload)
    except JsonDocumentError as exc:
        raise RequestError("请求内容不是有效的 JSON 对象。") from exc
    return value


def discard_request_body(content_length: str | None, read_body: Callable[[int], bytes]) -> None:
    """Drain a bounded fixed-length body before closing an unauthenticated request."""
    if content_length is None or not content_length.isdigit():
        return
    length = int(content_length)
    if length < 0 or length > MAX_REQUEST_BYTES:
        return
    remaining = length
    while remaining:
        chunk = read_body(min(remaining, 64 * 1024))
        if not chunk:
            return
        remaining -= len(chunk)


def require_session_token(supplied: str, expected: str) -> None:
    """Require an ASCII token that matches the current process session."""
    import secrets

    if not supplied.isascii() or not secrets.compare_digest(supplied, expected):
        raise SessionError("本地会话已失效，请刷新工作区。")


def require_local_origin(
    host: str,
    origin: str | None,
    fetch_site: str | None,
    expected_hosts: set[str],
) -> None:
    """Require browser headers to target the local workbench address."""
    if host not in expected_hosts:
        raise SessionError("请求地址与本地工作台不匹配。")
    expected_origin = f"http://{host}"
    if origin is not None and origin != expected_origin:
        raise SessionError("请从本地工作台页面发起操作。")
    if fetch_site == "cross-site":
        raise SessionError("请从本地工作台页面发起操作。")


def encode_json_body(value: dict[str, object]) -> bytes:
    """Encode a JSON response body using the project canonical encoder."""
    return encode_json_object(value).encode("utf-8")


def encode_error_body(message: str) -> bytes:
    """Encode the standard JSON error envelope."""
    return encode_json_body({"error": message})
