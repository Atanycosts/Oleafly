"""Run the Node regression against an isolated Workbench HTTP library."""

from __future__ import annotations

import json
import sys
from base64 import b64decode
from contextlib import closing
from http.client import HTTPConnection
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from typing import Any

from research_file_workbench.docx.reader import read_docx_bytes
from research_file_workbench.docx.report import docx_read_result_to_report
from research_file_workbench.workbench.server import WorkbenchHttpServer
from research_file_workbench.workbench.service import WorkbenchService


def post(
    server: WorkbenchHttpServer, route: str, body: dict[str, Any]
) -> tuple[int, Any]:
    with closing(HTTPConnection(*server.server_address, timeout=5)) as connection:
        connection.request(
            "POST",
            route,
            body=json.dumps(body),
            headers={
                "Content-Type": "application/json",
                "X-RFW-Token": server.session_token,
            },
        )
        response = connection.getresponse()
        return response.status, json.load(response)


def query_retained(
    server: WorkbenchHttpServer, payload: dict[str, Any]
) -> dict[str, Any]:
    status, project = post(
        server,
        "/api/projects",
        {
            "name": "Address regression",
            "filename": "address-regression.docx",
            "content_base64": payload["content_base64"],
        },
    )
    assert status == 200, project
    target = {
        "project_id": project["project_id"],
        "baseline_id": project["baseline_id"],
    }
    retained_snapshot = None
    if "snapshot" in payload:
        status, result = post(
            server, "/api/docx-format", {**target, "snapshot": payload["snapshot"]}
        )
        assert status == 200, result
        status, result = post(
            server, "/api/docx-query", {"target": target, "operation": "snapshot"}
        )
        assert status == 200, result
        retained_snapshot = result["snapshot"]

    outcomes = {}
    for label, query in payload["queries"].items():
        status, result = post(server, "/api/docx-query", {"target": target, **query})
        outcomes[label] = (
            {"ok": True, "status": status, "result": result}
            if status == 200
            else {"ok": False, "status": status, "error": result["error"]}
        )
    return {"queries": outcomes, "retainedSnapshot": retained_snapshot}


def main() -> None:
    payload = json.load(sys.stdin)
    content = b64decode(payload["content_base64"])
    runs = Path(__file__).resolve().parents[2] / "services/research-workbench/var"
    runs.mkdir(exist_ok=True)
    with TemporaryDirectory(prefix="docx-node-address-", dir=runs) as directory:
        service = WorkbenchService.create(Path(directory) / "library")
        with WorkbenchHttpServer(("127.0.0.1", 0), service) as server:
            thread = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05})
            thread.start()
            try:
                outcome = query_retained(server, payload)
            finally:
                server.shutdown()
                thread.join()

    read = read_docx_bytes(content, source_label="address-regression.docx")
    report = docx_read_result_to_report(read)
    print(
        json.dumps(
            {
                **outcome,
                "textBlocks": [
                    {
                        "part_path": block.part_path,
                        "node_locator": block.node_locator,
                        "text": block.text,
                        "byte_start": block.byte_start,
                        "byte_end": block.byte_end,
                    }
                    for block in read.text_blocks
                ],
                "tables": report["tables"],
                "unsupportedRecords": report["unsupported_records"],
                "issues": list(read.issues),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
