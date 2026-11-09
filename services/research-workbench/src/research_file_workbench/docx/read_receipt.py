"""Build and persist typed receipts for the ranges returned by an S1 read.

Receipt models and scalar validation live in dedicated modules.  This module
keeps the application-facing builder and filesystem boundary together while
re-exporting the established public model names.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path

from research_file_workbench.common.clock import utc_now_iso
from research_file_workbench.common.hashing import sha256_text
from research_file_workbench.common.json_io import load_json_object, write_json_object
from research_file_workbench.docx.read_receipt_models import (
    READ_RECEIPT_VERSION,
    ReadCaller,
    ReadPagination,
    ReadRange,
    ReadReceipt,
)
from research_file_workbench.docx.read_receipt_validation import (
    ParseStatus,
    ReadReceiptError,
    _first_seen,
    _require_text,
    _require_text_sequence,
    _require_unique,
    _validate_timestamp,
)

__all__ = [
    "READ_RECEIPT_VERSION",
    "ParseStatus",
    "ReadPagination",
    "ReadCaller",
    "ReadRange",
    "ReadReceipt",
    "ReadReceiptError",
    "build_read_receipt",
    "load_read_receipt",
    "write_read_receipt",
]


def build_read_receipt(
    task_id: str,
    returned_ranges: Sequence[ReadRange],
    *,
    actor_id: str,
    client_id: str,
    returned_versions: Sequence[str] | None = None,
    truncation: bool = False,
    unread_ranges: Sequence[ReadRange] = (),
    pagination: ReadPagination | None = None,
    caller: ReadCaller | None = None,
    read_record_id: str | None = None,
    created_at: str | None = None,
    method_version: str = READ_RECEIPT_VERSION,
    dependencies: Sequence[str] = (),
) -> ReadReceipt:
    """Build a receipt from ranges actually returned to the caller.

    ``returned_versions`` is normally derived from ``returned_ranges``.  If a
    caller supplies it, the exact sequence is checked against those ranges so
    a version cannot be claimed read without a corresponding returned range.
    """
    ranges, unread, versions = _normalize_ranges(returned_ranges, unread_ranges, returned_versions)
    timestamp, dependency_values = _normalize_receipt_inputs(
        task_id, actor_id, client_id, method_version, created_at, dependencies
    )
    if read_record_id is None:
        read_record_id = _build_read_record_id(
            task_id,
            versions,
            ranges,
            truncation,
            unread,
            actor_id,
            client_id,
            timestamp,
            method_version,
            dependency_values,
            pagination,
            caller,
        )
    return ReadReceipt(
        read_record_id=read_record_id,
        task_id=task_id,
        returned_versions=tuple(versions),
        ranges=ranges,
        truncation=truncation,
        unread_ranges=unread,
        actor_id=actor_id,
        client_id=client_id,
        created_at=timestamp,
        method_version=method_version,
        dependencies=dependency_values,
        pagination=pagination,
        caller=caller,
    )


def _normalize_ranges(
    returned_ranges: Sequence[ReadRange],
    unread_ranges: Sequence[ReadRange],
    returned_versions: Sequence[str] | None,
) -> tuple[tuple[ReadRange, ...], tuple[ReadRange, ...], tuple[str, ...]]:
    ranges = tuple(returned_ranges)
    unread = tuple(unread_ranges)
    if not all(isinstance(item, ReadRange) for item in ranges + unread):
        raise ReadReceiptError("ranges and unread_ranges must contain ReadRange values")
    derived_versions = _first_seen(item.version_id for item in ranges)
    versions = derived_versions if returned_versions is None else tuple(returned_versions)
    _require_text_sequence(versions, "returned_versions")
    _require_unique(versions, "returned_versions")
    if tuple(versions) != derived_versions:
        raise ReadReceiptError(
            "returned_versions must exactly match the ordered versions in returned_ranges"
        )
    return ranges, unread, versions


def _normalize_receipt_inputs(
    task_id: str,
    actor_id: str,
    client_id: str,
    method_version: str,
    created_at: str | None,
    dependencies: Sequence[str],
) -> tuple[str, tuple[str, ...]]:
    timestamp = utc_now_iso() if created_at is None else created_at
    _validate_timestamp(timestamp)
    _require_text(task_id, "task_id")
    _require_text(actor_id, "actor_id")
    _require_text(client_id, "client_id")
    _require_text(method_version, "method_version")
    dependency_values = tuple(dependencies)
    _require_text_sequence(dependency_values, "dependencies")
    return timestamp, dependency_values


def write_read_receipt(path: Path, receipt: ReadReceipt) -> None:
    """Atomically persist one receipt as a JSON object."""
    write_json_object(path, receipt.to_json())


def load_read_receipt(path: Path) -> ReadReceipt:
    """Load and validate one persisted receipt."""
    try:
        return ReadReceipt.from_json(load_json_object(path))
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
        if isinstance(exc, ReadReceiptError):
            raise
        raise ReadReceiptError(f"Invalid read receipt at {path}: {exc}") from exc


def _build_read_record_id(
    task_id: str,
    versions: tuple[str, ...],
    ranges: tuple[ReadRange, ...],
    truncation: bool,
    unread_ranges: tuple[ReadRange, ...],
    actor_id: str,
    client_id: str,
    created_at: str,
    method_version: str,
    dependencies: tuple[str, ...],
    pagination: ReadPagination | None,
    caller: ReadCaller | None,
) -> str:
    payload = {
        "task_id": task_id,
        "returned_versions": list(versions),
        "ranges": [item.to_json() for item in ranges],
        "truncation": truncation,
        "unread_ranges": [item.to_json() for item in unread_ranges],
        "actor_id": actor_id,
        "client_id": client_id,
        "created_at": created_at,
        "method_version": method_version,
        "dependencies": list(dependencies),
        "pagination": pagination.to_json() if pagination is not None else None,
        "caller": caller.to_json() if caller is not None else None,
    }
    digest = sha256_text(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    )
    return f"read-record-{digest}"
