"""Commit a checked DOCX format candidate and its template binding atomically."""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path
from typing import TYPE_CHECKING, cast

from research_file_workbench.common.hashing import sha256_bytes
from research_file_workbench.common.json_io import (
    JsonObject,
    decode_json_object,
    encode_json_object,
)
from research_file_workbench.common.sqlite import sqlite_file_uri
from research_file_workbench.docx.reader import read_docx_bytes
from research_file_workbench.docx.report import READER_VERSION
from research_file_workbench.journals.models import (
    record_digest,
    require_identifier,
    require_keys,
)
from research_file_workbench.journals.store_bindings import (
    bind_project as bind_project_record,
)
from research_file_workbench.journals.store_bindings import (
    get_binding as get_binding_record,
)
from research_file_workbench.journals.store_records import (
    BindingConflictError,
    check_record,
    required_row,
    verified_payload,
    world_record,
)
from research_file_workbench.projects import baseline_records
from research_file_workbench.projects.format_records import FormatSnapshotReference
from research_file_workbench.projects.models import (
    BaselineConflictError,
    BaselineRequest,
    ProjectStoreError,
    require_record_text,
)
from research_file_workbench.projects.project_database import connect_project, project_info
from research_file_workbench.projects.service import (
    DATABASE_NAME,
    open_project,
    source_evidence,
)
from research_file_workbench.projects.template_candidate_review_records import (
    clear_review_for_check,
    require_review_for_check,
)

if TYPE_CHECKING:
    from research_file_workbench.projects.store import ProjectStore
    from research_file_workbench.workbench.service import WorkbenchService

__all__ = ["adopt_template_candidate"]

_ACTOR_ID = "local-operator"
_SURFACE = "browser"


def adopt_template_candidate(service: WorkbenchService, payload: JsonObject) -> JsonObject:
    """Replace the working baseline and bind the checked candidate's template together."""
    require_keys(
        payload,
        {
            "project_id",
            "expected_baseline_id",
            "expected_binding_id",
            "candidate_project_id",
            "candidate_baseline_id",
            "expected_candidate_binding_id",
            "candidate_source_sha256",
            "candidate_check_id",
            "request_id",
        },
    )
    project_id = require_identifier(payload["project_id"], "project ID")
    candidate_project_id = require_identifier(
        payload["candidate_project_id"], "candidate project ID"
    )
    if project_id == candidate_project_id:
        raise ValueError("候选项目必须与工作稿项目不同。")
    expected_baseline_id = require_identifier(
        payload["expected_baseline_id"], "expected baseline ID"
    )
    expected_binding = payload["expected_binding_id"]
    if expected_binding is not None:
        expected_binding = require_identifier(expected_binding, "expected binding ID")
    candidate_baseline_id = require_identifier(
        payload["candidate_baseline_id"], "candidate baseline ID"
    )
    expected_candidate_binding_id = require_identifier(
        payload["expected_candidate_binding_id"], "expected candidate binding ID"
    )
    candidate_source_sha256 = _sha256(payload["candidate_source_sha256"])
    candidate_check_id = require_identifier(payload["candidate_check_id"], "candidate check ID")
    request_id = require_identifier(payload["request_id"], "adoption request ID")
    request_digest = record_digest(
        {
            "project_id": project_id,
            "expected_baseline_id": expected_baseline_id,
            "expected_binding_id": expected_binding,
            "candidate_project_id": candidate_project_id,
            "candidate_baseline_id": candidate_baseline_id,
            "expected_candidate_binding_id": expected_candidate_binding_id,
            "candidate_source_sha256": candidate_source_sha256,
            "candidate_check_id": candidate_check_id,
        }
    )
    request_record: JsonObject = {
        "request_id": request_id,
        "request_digest": request_digest,
        "project_id": project_id,
        "expected_baseline_id": expected_baseline_id,
        "expected_binding_id": expected_binding,
        "candidate_project_id": candidate_project_id,
        "candidate_baseline_id": candidate_baseline_id,
        "expected_candidate_binding_id": expected_candidate_binding_id,
        "candidate_source_sha256": candidate_source_sha256,
        "candidate_check_id": candidate_check_id,
        "actor_id": _ACTOR_ID,
        "surface": _SURFACE,
    }

    target_root = service.project_root(project_id)
    open_project(target_root)
    replay = _committed_request(target_root / DATABASE_NAME, request_id, request_digest)
    if replay is not None:
        return replay
    candidate_root = service.project_root(candidate_project_id)
    candidate_project = open_project(candidate_root)
    candidate_baseline = candidate_project.get_baseline(candidate_baseline_id)
    if candidate_baseline["source_sha256"] != candidate_source_sha256:
        raise ValueError("候选来源哈希与留存版本不一致。")
    candidate_bytes = candidate_project.read_artifact(f"artifact-version-{candidate_source_sha256}")
    if sha256_bytes(candidate_bytes) != candidate_source_sha256:
        raise ValueError("候选来源字节与声明哈希不一致。")
    parsed = read_docx_bytes(
        candidate_bytes,
        source_label=f"{candidate_project_id}/{candidate_baseline_id}",
    )
    if parsed.source_sha256 != candidate_source_sha256:
        raise ValueError("候选读取结果与留存来源不一致。")
    if any(part.status == "failed" for part in parsed.parts):
        raise ValueError("候选包含无法解析的内容，请重新检查。")
    evidence = source_evidence(parsed)

    with connect_project(target_root / DATABASE_NAME) as connection, connection:
        _attach_candidate(connection, candidate_root)
        connection.execute("BEGIN IMMEDIATE")

        replay = _lookup_request(connection, request_id, request_digest)
        if replay is not None:
            return replay

        target = project_info(connection)
        if target["project_id"] != project_id:
            raise ProjectStoreError("Adoption target belongs to a different project")
        current_baseline_id = target["current_baseline_id"]
        if current_baseline_id != expected_baseline_id:
            raise BaselineConflictError(
                "工作稿版本已变化，请刷新后重试。",
                result={
                    "expected_baseline_id": expected_baseline_id,
                    "previous_baseline_id": current_baseline_id,
                    "request_id": request_id,
                },
            )
        target_baseline = baseline_records.get_baseline(connection, expected_baseline_id)
        _verify_candidate_baseline(
            connection,
            candidate_project_id,
            candidate_baseline_id,
            candidate_source_sha256,
        )

        service.store.attach_to(connection)
        current_binding = get_binding_record(connection, project_id)
        current_binding_id = (
            cast(str, current_binding["binding_id"]) if current_binding is not None else None
        )
        if current_binding_id != expected_binding:
            raise BindingConflictError("模板绑定已变化，请刷新后重试。")
        world_id, candidate_check = _candidate_world_check(
            connection,
            candidate_project_id,
            candidate_root,
            candidate_baseline_id,
            expected_candidate_binding_id,
            candidate_source_sha256,
            candidate_check_id,
        )
        review = require_review_for_check(connection, candidate_check_id)
        if (
            review["target_baseline_id"] != current_baseline_id
            or review["target_source_sha256"] != target_baseline["source_sha256"]
        ):
            raise BaselineConflictError("工作稿已不是生成候选时的版本，无法采用此候选。")
        if review["target_binding_id"] != current_binding_id:
            raise BindingConflictError("模板绑定已不是生成候选时的版本，无法采用此候选。")
        _verify_candidate_snapshot(
            candidate_project,
            candidate_check,
            candidate_baseline_id,
            candidate_source_sha256,
        )
        world_record(
            connection,
            required_row(connection, "world", "version_id", world_id),
        )

        baseline_request = BaselineRequest(
            project_id=project_id,
            actor_id=_ACTOR_ID,
            request_id=f"candidate-adoption-{request_digest}",
            expected_baseline_id=expected_baseline_id,
            source_sha256=candidate_source_sha256,
        )
        baseline_result = baseline_records.apply_baseline(
            connection,
            baseline_request,
            source_bytes=candidate_bytes,
            source_path=require_record_text(target_baseline.get("source_path"), "source_path"),
            confirmation_reason=(
                "Adopted isolated DOCX format candidate "
                f"{candidate_project_id}/{candidate_baseline_id}."
            ),
            evidence=evidence,
            reader_version=READER_VERSION,
        )
        if baseline_result.get("status") != "APPLIED":
            raise BaselineConflictError(
                "候选采用请求未能应用，请重新读取当前状态。", result=baseline_result
            )
        result_baseline_id = require_record_text(
            baseline_result.get("result_baseline_id"), "result_baseline_id"
        )
        binding = bind_project_record(
            connection,
            project_id,
            target_root.resolve().as_posix(),
            result_baseline_id,
            world_id,
            expected_binding_id=expected_binding,
            actor_id=_ACTOR_ID,
            surface=_SURFACE,
        )
        result: JsonObject = {
            "result_baseline_id": result_baseline_id,
            "binding": binding,
        }
        connection.execute(
            "INSERT INTO template_candidate_adoption VALUES (?,?,?,?)",
            (
                request_id,
                request_digest,
                encode_json_object(request_record),
                encode_json_object(result),
            ),
        )
        clear_review_for_check(connection, candidate_check_id)
        return result


def _attach_candidate(connection: sqlite3.Connection, candidate_root: Path) -> None:
    """Attach the candidate project read-only so its final binding stays fixed."""
    connection.execute(
        "ATTACH DATABASE ? AS candidate",
        (sqlite_file_uri(candidate_root / DATABASE_NAME, "ro"),),
    )


def _committed_request(
    database_path: Path, request_id: str, request_digest: str
) -> JsonObject | None:
    """Recover or reject a request before revalidating a candidate that may have moved."""
    with connect_project(database_path) as connection:
        return _lookup_request(connection, request_id, request_digest)


def _lookup_request(
    connection: sqlite3.Connection, request_id: str, request_digest: str
) -> JsonObject | None:
    """Return the committed adoption result, including after target state moved."""
    row = connection.execute(
        ("SELECT request_digest,result_json FROM template_candidate_adoption WHERE request_id=?"),
        (request_id,),
    ).fetchone()
    if row is None:
        return None
    if row["request_digest"] != request_digest:
        raise BindingConflictError("采用请求标识已用于不同的稿件或候选。")
    result = decode_json_object(row["result_json"])
    if not isinstance(result.get("result_baseline_id"), str) or not isinstance(
        result.get("binding"), dict
    ):
        raise ProjectStoreError("Stored candidate adoption result is invalid")
    return result


def _verify_candidate_baseline(
    connection: sqlite3.Connection,
    candidate_project_id: str,
    candidate_baseline_id: str,
    candidate_source_sha256: str,
) -> None:
    """Hold the candidate project snapshot while checking its current exact baseline."""
    project = connection.execute(
        "SELECT project_id,current_baseline_id FROM candidate.project"
    ).fetchone()
    if project is None:
        raise ValueError("候选项目不存在。")
    if project["project_id"] != candidate_project_id:
        raise ProjectStoreError("Candidate database belongs to a different project")
    if project["current_baseline_id"] != candidate_baseline_id:
        raise BaselineConflictError(
            "候选项目的当前版本已变化，请重新选择最终候选。",
            result={
                "candidate_baseline_id": candidate_baseline_id,
                "previous_baseline_id": project["current_baseline_id"],
            },
        )
    baseline = connection.execute(
        (
            "SELECT b.baseline_id,b.artifact_version_id,b.payload,"
            "a.sha256 AS artifact_sha256 FROM candidate.baseline b "
            "LEFT JOIN candidate.artifact a ON a.version_id=b.artifact_version_id "
            "WHERE b.baseline_id=?"
        ),
        (candidate_baseline_id,),
    ).fetchone()
    if baseline is None:
        raise ValueError("候选版本不存在。")
    record = decode_json_object(baseline["payload"])
    if (
        record.get("baseline_id") != baseline["baseline_id"]
        or record.get("project_id") != candidate_project_id
        or record.get("artifact_version_ids") != [baseline["artifact_version_id"]]
    ):
        raise ProjectStoreError("Stored candidate baseline identity is inconsistent")
    if (
        baseline["artifact_sha256"] != candidate_source_sha256
        or record.get("source_sha256") != candidate_source_sha256
    ):
        raise ValueError("候选来源哈希与留存版本不一致。")


def _verify_candidate_snapshot(
    candidate_project: ProjectStore,
    check: JsonObject,
    candidate_baseline_id: str,
    candidate_source_sha256: str,
) -> None:
    """Read the final check's exact snapshot registration before the target write."""
    comparison = check.get("template_comparison")
    dependencies = check.get("dependencies")
    if (
        not isinstance(comparison, dict)
        or comparison.get("source_sha256") != candidate_source_sha256
        or not isinstance(dependencies, dict)
    ):
        raise BindingConflictError("候选最终检查与所选版本或模板绑定不一致，请重新检查。")
    method = check.get("reader_version")
    artifact = dependencies.get("snapshot_artifact_version_id")
    if not isinstance(method, str) or not isinstance(artifact, str):
        raise BindingConflictError("候选最终检查缺少精确格式快照，请重新检查。")
    candidate_project.get_format_snapshot(
        candidate_baseline_id,
        reference=FormatSnapshotReference(
            baseline_id=candidate_baseline_id,
            source_sha256=candidate_source_sha256,
            snapshot_artifact_version_id=artifact,
            method_version=method,
        ),
    )


def _candidate_world_check(
    connection: sqlite3.Connection,
    candidate_project_id: str,
    candidate_root: Path,
    candidate_baseline_id: str,
    expected_candidate_binding_id: str,
    candidate_source_sha256: str,
    candidate_check_id: str,
) -> tuple[str, JsonObject]:
    """Validate the exact checked template world for the final candidate."""
    binding_row = connection.execute(
        (
            "SELECT b.* FROM project_binding p JOIN binding b "
            "ON b.binding_id=p.binding_id WHERE p.project_id=?"
        ),
        (candidate_project_id,),
    ).fetchone()
    if binding_row is None:
        raise BindingConflictError("候选尚未绑定已检查的模板版本。")
    binding = verified_payload(binding_row)
    if binding["binding_id"] != expected_candidate_binding_id:
        raise BindingConflictError("候选的模板绑定已变化，请重新检查。")
    if (
        binding["baseline_id"] != candidate_baseline_id
        or binding.get("project_root") != candidate_root.resolve().as_posix()
    ):
        raise BindingConflictError("候选的模板绑定不属于最终版本，请重新检查。")
    world_id = require_record_text(binding.get("world_version_id"), "world_version_id")
    check_row = connection.execute(
        "SELECT * FROM check_record WHERE check_id=?", (candidate_check_id,)
    ).fetchone()
    if check_row is None:
        raise BindingConflictError("候选尚未完成最终版本与模板绑定的检查。")
    check = check_record(connection, check_row)
    comparison = check.get("template_comparison")
    if (
        check.get("project_id") != candidate_project_id
        or check.get("baseline_id") != candidate_baseline_id
        or check.get("binding_id") != binding["binding_id"]
        or check.get("world_version_id") != world_id
        or check.get("source_sha256") != candidate_source_sha256
        or not isinstance(comparison, dict)
        or cast(JsonObject, comparison).get("source_sha256") != candidate_source_sha256
    ):
        raise BindingConflictError("候选最终检查与所选版本或模板绑定不一致，请重新检查。")
    return world_id, check


def _sha256(value: object) -> str:
    text = require_record_text(value, "candidate_source_sha256")
    if re.fullmatch(r"[0-9a-f]{64}", text) is None:
        raise ValueError("candidate_source_sha256 must be 64 lowercase hexadecimal characters")
    return text
