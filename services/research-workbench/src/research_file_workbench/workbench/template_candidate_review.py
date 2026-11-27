"""Persist and restore one reviewed DOCX format candidate for a target project."""

from __future__ import annotations

import re
from typing import cast

from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.journals.models import (
    require_identifier,
    require_keys,
    require_object,
    require_objects,
    require_text,
)
from research_file_workbench.journals.store_records import BindingConflictError
from research_file_workbench.projects.format_records import FormatSnapshotReference
from research_file_workbench.projects.models import BaselineConflictError, ProjectStoreError
from research_file_workbench.projects.service import open_project
from research_file_workbench.projects.store import ProjectStore
from research_file_workbench.projects.template_candidate_review_records import (
    CandidateReviewConflictError,
)
from research_file_workbench.workbench.service import WorkbenchService
from research_file_workbench.workbench.template_service import remaining_template_review_groups

__all__ = [
    "CandidateReviewConflictError",
    "get_template_candidate_review",
    "get_template_candidate_summary",
    "save_template_candidate_review",
]

_SUMMARY_VERSION = 1
_COLLECTION_FIELDS = {
    "confirmed": "confirmed_items",
    "unconfirmed": "unconfirmed_items",
    "remaining": "remaining_groups",
}
_REVIEW_FIELDS = {
    "candidate_project_id",
    "input_baseline_id",
    "input_source_sha256",
    "candidate_baseline_id",
    "candidate_source_sha256",
    "candidate_binding_id",
    "candidate_check_id",
    "world_version_id",
    "snapshot_artifact_version_id",
    "snapshot_method_version",
    "target_baseline_id",
    "target_source_sha256",
    "target_binding_id",
    "original_source_sha256",
    "confirmed_items",
    "unconfirmed_items",
}
_ITEM_FIELDS = {"id", "property", "role", "group"}
_ITEM_OPTIONAL_FIELDS = {
    "para_id",
    "location",
    "before",
    "expected",
    "template_location",
    "template_object_id",
    "row",
}
_GROUP_FIELDS = {"category", "action"}
_GROUP_OPTIONAL_FIELDS = {"heading_level", "object_number", "table_area"}
_TABLE_AREAS = {"header", "body", "exception"}


def get_template_candidate_review(service: WorkbenchService, project_id: str) -> JsonObject:
    """Restore exact reviewed metadata while deriving current adoptability."""
    project_id = require_identifier(project_id, "project ID")
    target_root = service.project_root(project_id)
    if not target_root.is_dir():
        raise ValueError("论文不在当前工作台库中。")
    project = open_project(target_root)
    review = project.get_template_candidate_review()
    if review is None:
        return {"review": None}
    try:
        review.pop("checklist", None)
        _validate_review(review)
        reason, _, _ = _verify_review(service, project_id, review)
    except ValueError as exc:
        raise ProjectStoreError("Stored format candidate review is invalid") from exc
    return _envelope(review, reason)


def save_template_candidate_review(service: WorkbenchService, payload: JsonObject) -> JsonObject:
    """Save reviewed metadata only after all pinned identities still agree."""
    require_keys(payload, {"project_id", "expected_candidate_check_id", "review"})
    project_id = require_identifier(payload["project_id"], "project ID")
    expected_check_id = _optional_identifier(
        payload["expected_candidate_check_id"], "expected candidate check ID"
    )
    review = require_object(payload["review"], "format candidate review")
    _validate_review(review)
    target_root = service.project_root(project_id)
    if not target_root.is_dir():
        raise ValueError("论文不在当前工作台库中。")
    reason, check, snapshot = _verify_review(service, project_id, review)
    if reason == "candidate_baseline_changed":
        raise BaselineConflictError("The candidate baseline changed before the review was saved.")
    if reason == "candidate_binding_changed":
        raise BindingConflictError(
            "The candidate template binding changed before the review was saved."
        )
    checklist = _build_checklist(service, review, check, snapshot)
    open_project(target_root).save_template_candidate_review(
        {**review, "checklist": checklist}, expected_check_id
    )
    return _envelope(review, reason)


def get_template_candidate_summary(
    service: WorkbenchService,
    project_id: str,
    *,
    check_id: str | None,
    collection: str | None,
    offset: int,
    limit: int,
) -> JsonObject:
    """Read one pending checklist; the captured candidate is never changed or adopted."""
    if check_id is not None:
        require_identifier(check_id, "candidate check ID")
    if collection is not None and collection not in _COLLECTION_FIELDS:
        raise ValueError("Unsupported candidate checklist collection")
    if offset and check_id is None:
        raise ValueError("Candidate checklist pages after offset zero require check_id")
    target_root = service.project_root(project_id)
    if not target_root.is_dir():
        raise ValueError("论文不在当前工作台库中。")
    target = open_project(target_root)
    review = target.get_template_candidate_review()
    if check_id is not None and (review is None or review["candidate_check_id"] != check_id):
        raise CandidateReviewConflictError("待审候选已更换或采用，请重新读取清单。")
    if review is None:
        return {"schema_version": _SUMMARY_VERSION, "summary": None}

    retained = review.pop("checklist", None)
    try:
        if retained is None:
            _validate_review(review)
            reason, check, snapshot = _verify_review(service, project_id, review)
            checklist = _build_checklist(service, review, check, snapshot)
        else:
            checklist = require_object(retained, "candidate checklist")
            if checklist["schema_version"] != _SUMMARY_VERSION:
                raise ValueError("Unsupported stored candidate checklist version")
            reason = _review_conflict(
                service, project_id, review, target, _candidate(service, review)
            )
    except (KeyError, ValueError) as exc:
        raise ProjectStoreError("Stored format candidate checklist is invalid") from exc

    summary: JsonObject = {
        **{
            field: review[field]
            for field in _REVIEW_FIELDS - {"confirmed_items", "unconfirmed_items"}
        },
        **{
            field: checklist[field]
            for field in (
                "template",
                "checker_version",
                "counts",
                "source_coverage_gaps",
                "candidate_reader_gaps",
            )
        },
        "target_project_id": project_id,
        "status": "conflict" if reason is not None else "ready",
    }
    if reason is not None:
        summary["reason"] = reason
    response: JsonObject = {"schema_version": _SUMMARY_VERSION, "summary": summary}
    if collection is not None:
        fields = review if collection != "remaining" else checklist
        items = cast(list[JsonObject], fields[_COLLECTION_FIELDS[collection]])
        end = min(offset + limit, len(items))
        response["page"] = {
            "collection": collection,
            "items": items[offset:end],
            "total": len(items),
            "next_offset": end if end < len(items) else None,
        }
    return response


def _build_checklist(
    service: WorkbenchService, review: JsonObject, check: JsonObject, snapshot: JsonObject
) -> JsonObject:
    """Combine the exact final check and the saved write audit, not new verdicts."""
    world = service.store.get_world_metadata(_review_id(review, "world_version_id"))
    template = require_object(world["template"], "checked template")
    original = next(
        source
        for source in require_objects(world["sources"], "checked template sources")
        if source["source_id"] == template["source_id"]
    )
    comparison = require_object(check["template_comparison"], "template comparison")
    finding_counts = require_object(comparison["finding_summary"], "finding summary")
    remaining = remaining_template_review_groups(service, check, snapshot)
    candidate_gaps: list[JsonObject] = []
    for gap in require_objects(comparison["unsupported"], "candidate unsupported observations"):
        object_ids = cast(list[str], gap["object_ids"])
        candidate_gaps.append(
            {
                "code": gap["code"],
                "detail": gap["detail"],
                "object_count": len(object_ids),
                "example_object_id": object_ids[0] if object_ids else None,
            }
        )
    return {
        "schema_version": _SUMMARY_VERSION,
        "template": {
            **{
                field: world[field]
                for field in (
                    "version_id",
                    "version_ordinal",
                    "journal_id",
                    "journal_name",
                    "scope",
                )
            },
            **{
                field: template[field]
                for field in (
                    "source_id",
                    "normalized_source_id",
                    "snapshot_source_id",
                    "source_sha256",
                    "original_sha256",
                    "authority",
                )
            },
            "name": original["name"],
        },
        "checker_version": check["checker_version"],
        "counts": {
            "confirmed": len(cast(list[JsonObject], review["confirmed_items"])),
            "unconfirmed": len(cast(list[JsonObject], review["unconfirmed_items"])),
            "remaining": len(remaining),
            "observed_difference": finding_counts["observed_difference"],
            "cannot_determine": finding_counts["cannot_determine"],
        },
        "source_coverage_gaps": check["coverage_gaps"],
        "candidate_reader_gaps": candidate_gaps,
        "remaining_groups": remaining,
    }


def _verify_review(
    service: WorkbenchService, target_project_id: str, review: JsonObject
) -> tuple[str | None, JsonObject, JsonObject]:
    """Validate exact retained evidence and return the first current-state conflict."""
    target = open_project(service.project_root(target_project_id))
    target_baseline = target.get_baseline(_review_id(review, "target_baseline_id"))
    _require_sha_match(
        target_baseline, _review_sha(review, "target_source_sha256"), "target baseline"
    )
    target_binding = _binding(
        service,
        target_project_id,
        cast(str | None, review["target_binding_id"]),
        "target",
    )
    if target_binding is not None and target_binding["project_id"] != target_project_id:
        raise ValueError("The target binding belongs to a different manuscript project.")

    candidate_project_id = _review_id(review, "candidate_project_id")
    candidate = _candidate(service, review)
    baselines = candidate.list_baselines()
    if not baselines:
        raise ProjectStoreError("Candidate project has no retained baseline")
    initial = baselines[0]
    if initial["baseline_id"] != review["input_baseline_id"]:
        raise ValueError("The recorded candidate input is not the project's initial baseline.")
    _require_sha_match(initial, _review_sha(review, "input_source_sha256"), "candidate input")
    candidate_baseline = candidate.get_baseline(_review_id(review, "candidate_baseline_id"))
    _require_sha_match(
        candidate_baseline,
        _review_sha(review, "candidate_source_sha256"),
        "candidate baseline",
    )
    candidate_binding = _binding(
        service,
        candidate_project_id,
        _review_id(review, "candidate_binding_id"),
        "candidate",
    )
    if candidate_binding is None:
        raise ValueError("The candidate binding is missing from the review.")
    if (
        candidate_binding["project_id"] != candidate_project_id
        or candidate_binding["baseline_id"] != review["candidate_baseline_id"]
        or candidate_binding["world_version_id"] != review["world_version_id"]
    ):
        raise ValueError("The candidate binding differs from the reviewed candidate check.")

    check = service.store.get_check(_review_id(review, "candidate_check_id"))
    comparison = require_object(check.get("template_comparison"), "template comparison")
    dependencies = require_object(check.get("dependencies"), "check dependencies")
    if (
        check.get("project_id") != candidate_project_id
        or check.get("baseline_id") != review["candidate_baseline_id"]
        or check.get("binding_id") != review["candidate_binding_id"]
        or check.get("world_version_id") != review["world_version_id"]
        or check.get("source_sha256") != review["candidate_source_sha256"]
        or check.get("reader_version") != review["snapshot_method_version"]
        or comparison.get("source_sha256") != review["candidate_source_sha256"]
        or dependencies.get("snapshot_artifact_version_id")
        != review["snapshot_artifact_version_id"]
    ):
        raise ValueError("The candidate check differs from the reviewed candidate record.")
    snapshot = candidate.get_format_snapshot(
        cast(str, review["candidate_baseline_id"]),
        reference=FormatSnapshotReference(
            baseline_id=cast(str, review["candidate_baseline_id"]),
            source_sha256=cast(str, review["candidate_source_sha256"]),
            snapshot_artifact_version_id=cast(str, review["snapshot_artifact_version_id"]),
            method_version=cast(str, review["snapshot_method_version"]),
        ),
    )
    return _review_conflict(service, target_project_id, review, target, candidate), check, snapshot


def _candidate(service: WorkbenchService, review: JsonObject) -> ProjectStore:
    candidate_root = service.project_root(_review_id(review, "candidate_project_id"))
    if not candidate_root.is_dir():
        raise ValueError("候选项目不在当前工作台库中。")
    return open_project(candidate_root)


def _review_conflict(
    service: WorkbenchService,
    target_project_id: str,
    review: JsonObject,
    target: ProjectStore,
    candidate: ProjectStore,
) -> str | None:
    if target.info()["current_baseline_id"] != review["target_baseline_id"]:
        return "target_baseline_changed"
    target_current_binding = service.store.get_binding(target_project_id)
    if _binding_id(target_current_binding) != review["target_binding_id"]:
        return "target_binding_changed"
    if candidate.info()["current_baseline_id"] != review["candidate_baseline_id"]:
        return "candidate_baseline_changed"
    if (
        _binding_id(service.store.get_binding(_review_id(review, "candidate_project_id")))
        != (review["candidate_binding_id"])
    ):
        return "candidate_binding_changed"
    return None


def _binding(
    service: WorkbenchService, project_id: str, binding_id: str | None, label: str
) -> JsonObject | None:
    if binding_id is None:
        return None
    binding = next(
        (
            item
            for item in service.store.list_bindings(project_id)
            if item["binding_id"] == binding_id
        ),
        None,
    )
    if binding is None:
        raise ValueError(f"The {label} binding is no longer retained.")
    return binding


def _binding_id(binding: JsonObject | None) -> str | None:
    return None if binding is None else cast(str, binding["binding_id"])


def _envelope(review: JsonObject, reason: str | None) -> JsonObject:
    result: JsonObject = {
        "review": review,
        "status": "conflict" if reason is not None else "ready",
    }
    if reason is not None:
        result["reason"] = reason
    return result


def _validate_review(review: JsonObject) -> None:
    require_keys(review, _REVIEW_FIELDS)
    for name in (
        "candidate_project_id",
        "input_baseline_id",
        "candidate_baseline_id",
        "candidate_binding_id",
        "candidate_check_id",
        "world_version_id",
        "snapshot_artifact_version_id",
        "target_baseline_id",
    ):
        require_identifier(review[name], name)
    _optional_identifier(review["target_binding_id"], "target_binding_id")
    require_text(review["snapshot_method_version"], "snapshot_method_version")
    for name in ("input_source_sha256", "candidate_source_sha256", "target_source_sha256"):
        _sha256(review[name], name)
    if review["original_source_sha256"] is not None:
        _sha256(review["original_source_sha256"], "original_source_sha256")
    _validate_items(review["confirmed_items"], "confirmed items")
    _validate_items(review["unconfirmed_items"], "unconfirmed items")


def _validate_items(value: object, label: str) -> None:
    for item in require_objects(value, label):
        require_keys(item, _ITEM_FIELDS, _ITEM_OPTIONAL_FIELDS)
        require_text(item["id"], f"{label} id")
        require_text(item["property"], f"{label} property")
        require_text(item["role"], f"{label} role")
        for name in ("para_id", "location", "template_location", "template_object_id"):
            if name in item:
                require_text(item[name], f"{label} {name}")
        if "row" in item:
            _positive_integer(item["row"], f"{label} row")
        group = require_object(item["group"], f"{label} group")
        require_keys(group, _GROUP_FIELDS, _GROUP_OPTIONAL_FIELDS)
        require_text(group["category"], f"{label} category")
        require_text(group["action"], f"{label} action")
        if "heading_level" in group:
            _positive_integer(group["heading_level"], f"{label} heading level")
        if "object_number" in group:
            _positive_integer(group["object_number"], f"{label} object number")
        if "table_area" in group and (
            not isinstance(group["table_area"], str) or group["table_area"] not in _TABLE_AREAS
        ):
            raise ValueError(f"{label} table area must be header, body or exception")


def _positive_integer(value: object, label: str) -> int:
    if type(value) is not int or value < 1:
        raise ValueError(f"{label} must be a positive integer")
    return value


def _optional_identifier(value: object, label: str) -> str | None:
    return None if value is None else require_identifier(value, label)


def _sha256(value: object, label: str) -> str:
    text = require_text(value, label)
    if re.fullmatch(r"[0-9a-f]{64}", text) is None:
        raise ValueError(f"{label} must be 64 lowercase hexadecimal characters")
    return text


def _review_id(review: JsonObject, name: str) -> str:
    return require_identifier(review[name], name)


def _review_sha(review: JsonObject, name: str) -> str:
    return _sha256(review[name], name)


def _require_sha_match(baseline: JsonObject, expected: str, label: str) -> None:
    if baseline["source_sha256"] != expected:
        raise ValueError(f"The retained {label} source hash differs from the review.")
