"""Small local HTTP surface for the journal-world workbench.

Request routing lives in :mod:`request_handler`; this module keeps the public
server lifecycle API and historical import paths stable.
"""

from __future__ import annotations

import ipaddress
import secrets
from http.server import ThreadingHTTPServer
from pathlib import Path

from research_file_workbench.common.hashing import sha256_bytes, sha256_text
from research_file_workbench.workbench.http_boundary import (
    HTTP_CONTRACT_VERSION,
    STATIC_ROOT,
    static_files,
)
from research_file_workbench.workbench.request_handler import WorkbenchRequestHandler
from research_file_workbench.workbench.service import WorkbenchService

__all__ = [
    "HTTP_CONTRACT_VERSION",
    "STATIC_ROOT",
    "WorkbenchHttpServer",
    "WorkbenchRequestHandler",
    "serve",
    "static_files",
]


class WorkbenchHttpServer(ThreadingHTTPServer):
    """Threaded local server carrying one application service and one session token."""

    def __init__(self, address: tuple[str, int], service: WorkbenchService) -> None:
        host_address = ipaddress.ip_address(address[0])
        if host_address.version != 4 or not host_address.is_loopback:
            raise ValueError("本地工作台只能绑定 IPv4 回环地址。")
        service.store.validate_library()
        self.assets = {
            route: ((STATIC_ROOT / filename).read_bytes(), content_type)
            for route, (filename, content_type) in static_files().items()
        }
        self.asset_version = sha256_text(
            "\n".join(f"{name}:{sha256_bytes(body)}" for name, (body, _) in self.assets.items())
        )
        super().__init__(address, WorkbenchRequestHandler)
        self.service = service
        self.session_token = secrets.token_urlsafe(32)


def serve(root: Path, *, host: str = "127.0.0.1", port: int = 8765) -> None:
    """Serve one initialized workbench library until interrupted."""
    service = WorkbenchService(root)
    server = WorkbenchHttpServer((host, port), service)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        return
    finally:
        server.server_close()
