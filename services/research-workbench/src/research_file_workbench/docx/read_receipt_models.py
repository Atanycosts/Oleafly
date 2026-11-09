"""Immutable data models for persisted DOCX read receipts."""

from __future__ import annotations

from dataclasses import dataclass
from typing import cast

from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.docx.read_receipt_validation import (
    _DIRECTORY_LISTING_TYPES,
    _PARSE_STATUSES,
    ParseStatus,
    ReadReceiptError,
    _first_seen,
    _object,
    _object_array,
    _optional_nonnegative_int,
    _positive_int,
    _require_text,
    _require_text_sequence,
    _require_unique,
    _string,
    _string_array,
    _validate_timestamp,
)

READ_RECEIPT_VERSION = "s1-read-receipt-1.2.0"


@dataclass(frozen=True, slots=True)
class ReadRange:
    """One concrete range returned from one immutable version.

    ``locator`` names the source object; for a package part it carries that part's path before any
    ``#`` fragment. ``start`` and ``end`` are optional byte offsets into that retained part, with
    ``end`` exclusive. They locate the bytes that produced the object rather than measuring
    anything inside the logical object, because an offset is only meaningful against the exact
    retained bytes. A partial, unsupported, failed, or unverified range must carry a limitation so
    the receipt cannot present it as complete.
    """

    version_id: str
    locator: str
    range_type: str = "document"
    start: int | None = None
    end: int | None = None
    parse_status: ParseStatus = "parsed"
    limitations: tuple[str, ...] = ()
    dependencies: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        _require_text(self.version_id, "version_id")
        _require_text(self.locator, "locator")
        _require_text(self.range_type, "range_type")
        if self.start is not None and (
            not isinstance(self.start, int) or isinstance(self.start, bool) or self.start < 0
        ):
            raise ReadReceiptError("start must be a nonnegative integer or null")
        if self.end is not None and (
            not isinstance(self.end, int) or isinstance(self.end, bool) or self.end < 0
        ):
            raise ReadReceiptError("end must be a nonnegative integer or null")
        if self.start is not None and self.end is not None and self.end < self.start:
            raise ReadReceiptError("end must be greater than or equal to start")
        if self.parse_status not in _PARSE_STATUSES:
            raise ReadReceiptError(f"Unknown parse_status: {self.parse_status}")
        _require_text_sequence(
            self.limitations,
            "limitations",
            allow_empty=self.parse_status == "parsed",
        )
        _require_text_sequence(self.dependencies, "dependencies")

    def to_json(self) -> JsonObject:
        """Return this range in a JSON-compatible representation."""
        return {
            "version_id": self.version_id,
            "range_type": self.range_type,
            "locator": self.locator,
            "start": self.start,
            "end": self.end,
            "parse_status": self.parse_status,
            "limitations": list(self.limitations),
            "dependencies": list(self.dependencies),
        }

    @classmethod
    def from_json(cls, value: object) -> ReadRange:
        """Validate and construct a range read from JSON."""
        document = _object(value, "range")
        version_id = _string(document, "version_id")
        locator = _string(document, "locator")
        range_type = _string(document, "range_type")
        start = _optional_nonnegative_int(document, "start")
        end = _optional_nonnegative_int(document, "end")
        status_value = _string(document, "parse_status")
        if status_value not in _PARSE_STATUSES:
            raise ReadReceiptError(f"Unknown parse_status: {status_value}")
        return cls(
            version_id=version_id,
            locator=locator,
            range_type=range_type,
            start=start,
            end=end,
            parse_status=cast(ParseStatus, status_value),
            limitations=tuple(_string_array(document, "limitations", allow_empty=True)),
            dependencies=tuple(_string_array(document, "dependencies", allow_empty=True)),
        )


@dataclass(frozen=True, slots=True)
class ReadPagination:
    """Pagination facts attached to a receipt, when the caller paged a read."""

    page_number: int
    page_size: int
    has_more: bool
    next_cursor: str | None = None
    total_ranges: int | None = None

    def __post_init__(self) -> None:
        if (
            not isinstance(self.page_number, int)
            or isinstance(self.page_number, bool)
            or not isinstance(self.page_size, int)
            or isinstance(self.page_size, bool)
            or self.page_number < 1
            or self.page_size < 1
        ):
            raise ReadReceiptError("page_number and page_size must be positive")
        if not isinstance(self.has_more, bool):
            raise ReadReceiptError("has_more must be a boolean")
        if self.next_cursor is not None:
            _require_text(self.next_cursor, "next_cursor")
        if self.has_more != (self.next_cursor is not None):
            raise ReadReceiptError("pagination.has_more and next_cursor must agree")
        if self.total_ranges is not None and (
            not isinstance(self.total_ranges, int)
            or isinstance(self.total_ranges, bool)
            or self.total_ranges < 0
        ):
            raise ReadReceiptError("total_ranges must be nonnegative or null")

    def to_json(self) -> JsonObject:
        """Return pagination facts in a JSON-compatible representation."""
        return {
            "page_number": self.page_number,
            "page_size": self.page_size,
            "has_more": self.has_more,
            "next_cursor": self.next_cursor,
            "total_ranges": self.total_ranges,
        }

    @classmethod
    def from_json(cls, value: object) -> ReadPagination:
        """Validate and construct pagination facts read from JSON."""
        document = _object(value, "pagination")
        page_number = _positive_int(document, "page_number")
        page_size = _positive_int(document, "page_size")
        has_more = document.get("has_more")
        if not isinstance(has_more, bool):
            raise ReadReceiptError("pagination.has_more must be a boolean")
        next_cursor = document.get("next_cursor")
        if next_cursor is not None and not isinstance(next_cursor, str):
            raise ReadReceiptError("pagination.next_cursor must be a string or null")
        total_ranges = _optional_nonnegative_int(document, "total_ranges")
        return cls(page_number, page_size, has_more, next_cursor, total_ranges)


@dataclass(frozen=True, slots=True)
class ReadCaller:
    """Correlation metadata supplied by an integrated local task runner."""

    system: str
    project_id: str
    task_id: str
    generation: int

    def __post_init__(self) -> None:
        _require_text(self.system, "caller.system")
        _require_text(self.project_id, "caller.project_id")
        _require_text(self.task_id, "caller.task_id")
        if type(self.generation) is not int or self.generation < 1:
            raise ReadReceiptError("caller.generation must be a positive integer")

    def to_json(self) -> JsonObject:
        return {
            "system": self.system,
            "project_id": self.project_id,
            "task_id": self.task_id,
            "generation": self.generation,
        }

    @classmethod
    def from_json(cls, value: object) -> ReadCaller:
        document = _object(value, "read caller")
        generation = document.get("generation")
        if type(generation) is not int:
            raise ReadReceiptError("caller.generation must be a positive integer")
        return cls(
            system=_string(document, "system"),
            project_id=_string(document, "project_id"),
            task_id=_string(document, "task_id"),
            generation=generation,
        )


@dataclass(frozen=True, slots=True)
class ReadReceipt:
    """Immutable record of one read response and its known unread ranges."""

    read_record_id: str
    task_id: str
    returned_versions: tuple[str, ...]
    ranges: tuple[ReadRange, ...]
    truncation: bool
    unread_ranges: tuple[ReadRange, ...]
    actor_id: str
    client_id: str
    created_at: str
    method_version: str = READ_RECEIPT_VERSION
    dependencies: tuple[str, ...] = ()
    pagination: ReadPagination | None = None
    caller: ReadCaller | None = None

    def __post_init__(self) -> None:
        _require_text(self.read_record_id, "read_record_id")
        _require_text(self.task_id, "task_id")
        _require_text(self.actor_id, "actor_id")
        _require_text(self.client_id, "client_id")
        _require_text(self.method_version, "method_version")
        if not isinstance(self.truncation, bool):
            raise ReadReceiptError("truncation must be a boolean")
        _validate_timestamp(self.created_at)
        _require_text_sequence(self.returned_versions, "returned_versions")
        _require_text_sequence(self.dependencies, "dependencies")
        _require_unique(self.returned_versions, "returned_versions")
        _validate_range_collection(self.ranges, "ranges")
        _validate_range_collection(self.unread_ranges, "unread_ranges")
        returned = {
            (item.version_id, item.range_type, item.locator, item.start, item.end)
            for item in self.ranges
        }
        unread = {
            (item.version_id, item.range_type, item.locator, item.start, item.end)
            for item in self.unread_ranges
        }
        if returned & unread:
            raise ReadReceiptError("The same range cannot be both returned and unread")
        range_versions = _first_seen(item.version_id for item in self.ranges)
        if tuple(self.returned_versions) != range_versions:
            raise ReadReceiptError(
                "returned_versions must exactly match versions represented by returned ranges"
            )
        if any(item.range_type in _DIRECTORY_LISTING_TYPES for item in self.ranges):
            raise ReadReceiptError("directory listings cannot be recorded as returned ranges")
        if self.pagination is not None and self.pagination.has_more and not self.truncation:
            raise ReadReceiptError("pagination.has_more requires truncation=true")

    def to_json(self) -> JsonObject:
        """Return the complete receipt in the minimum-schema shape."""
        value: JsonObject = {
            "read_record_id": self.read_record_id,
            "task_id": self.task_id,
            "returned_versions": list(self.returned_versions),
            "ranges": [item.to_json() for item in self.ranges],
            "truncation": self.truncation,
            "unread_ranges": [item.to_json() for item in self.unread_ranges],
            "actor_id": self.actor_id,
            "client_id": self.client_id,
            "created_at": self.created_at,
            "method_version": self.method_version,
            "dependencies": list(self.dependencies),
        }
        if self.pagination is not None:
            value["pagination"] = self.pagination.to_json()
        if self.caller is not None:
            value["caller"] = self.caller.to_json()
        return value

    @classmethod
    def from_json(cls, value: object) -> ReadReceipt:
        """Validate and construct a receipt read from JSON."""
        document = _object(value, "read receipt")
        required = {
            "read_record_id",
            "task_id",
            "returned_versions",
            "ranges",
            "truncation",
            "unread_ranges",
            "actor_id",
            "client_id",
            "created_at",
        }
        missing = sorted(required - document.keys())
        if missing:
            raise ReadReceiptError(f"Missing read receipt fields: {', '.join(missing)}")
        ranges = tuple(ReadRange.from_json(item) for item in _object_array(document, "ranges"))
        unread_ranges = tuple(
            ReadRange.from_json(item) for item in _object_array(document, "unread_ranges")
        )
        truncation = document.get("truncation")
        if not isinstance(truncation, bool):
            raise ReadReceiptError("truncation must be a boolean")
        pagination_value = document.get("pagination")
        pagination = (
            None if pagination_value is None else ReadPagination.from_json(pagination_value)
        )
        returned_versions = tuple(_string_array(document, "returned_versions", allow_empty=True))
        return cls(
            read_record_id=_string(document, "read_record_id"),
            task_id=_string(document, "task_id"),
            returned_versions=returned_versions,
            ranges=ranges,
            truncation=truncation,
            unread_ranges=unread_ranges,
            actor_id=_string(document, "actor_id"),
            client_id=_string(document, "client_id"),
            created_at=_string(document, "created_at"),
            method_version=_string(document, "method_version")
            if "method_version" in document
            else READ_RECEIPT_VERSION,
            dependencies=tuple(
                _string_array(document, "dependencies", allow_empty=True)
                if "dependencies" in document
                else []
            ),
            pagination=pagination,
            caller=(ReadCaller.from_json(document["caller"]) if "caller" in document else None),
        )


def _validate_range_collection(ranges: tuple[ReadRange, ...], name: str) -> None:
    if not all(isinstance(item, ReadRange) for item in ranges):
        raise ReadReceiptError(f"{name} must contain ReadRange values")
    identities = [
        (item.version_id, item.range_type, item.locator, item.start, item.end) for item in ranges
    ]
    _require_unique(tuple(str(identity) for identity in identities), name)
