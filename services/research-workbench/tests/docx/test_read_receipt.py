import json

import pytest

from research_file_workbench.docx.read_receipt import (
    ReadPagination,
    ReadRange,
    ReadReceiptError,
    build_read_receipt,
    load_read_receipt,
    write_read_receipt,
)


def test_receipt_records_only_returned_ranges_and_versions() -> None:
    first = ReadRange("artifact-v1", "word/document.xml", "paragraph", 0, 80)
    second = ReadRange("artifact-v1", "word/document.xml", "paragraph", 80, 120)

    receipt = build_read_receipt(
        "task-1",
        [first, second],
        actor_id="operator-1",
        client_id="client-1",
        created_at="2026-09-25T01:02:03+00:00",
        dependencies=["artifact-v1", "reader-v1"],
    )

    value = receipt.to_json()
    json.dumps(value)
    assert value["returned_versions"] == ["artifact-v1"]
    assert len(value["ranges"]) == 2
    assert value["unread_ranges"] == []
    assert value["read_record_id"].startswith("read-record-")


def test_empty_request_produces_explicit_empty_receipt() -> None:
    receipt = build_read_receipt(
        "task-empty",
        [],
        actor_id="operator-1",
        client_id="client-1",
        created_at="2026-09-25T01:02:03+00:00",
    )

    assert receipt.returned_versions == ()
    assert receipt.ranges == ()
    assert receipt.truncation is False
    assert receipt.to_json()["ranges"] == []


def test_pagination_and_partial_range_are_explicit() -> None:
    returned = ReadRange(
        "artifact-v2",
        "word/document.xml",
        "paragraph",
        0,
        100,
        parse_status="partial",
        limitations=("paragraph continuation is on the next page",),
    )
    unread = ReadRange("artifact-v2", "word/document.xml", "paragraph", 100, 200)
    receipt = build_read_receipt(
        "task-page",
        [returned],
        actor_id="operator-1",
        client_id="client-1",
        truncation=True,
        unread_ranges=[unread],
        pagination=ReadPagination(page_number=1, page_size=1, has_more=True, next_cursor="p2"),
        created_at="2026-09-25T01:02:03+00:00",
    )

    assert receipt.to_json()["pagination"]["has_more"] is True
    assert receipt.to_json()["ranges"][0]["parse_status"] == "partial"
    assert receipt.to_json()["ranges"][0]["limitations"]


def test_supplied_versions_must_match_returned_ranges() -> None:
    returned = ReadRange("artifact-v1", "word/document.xml")

    with pytest.raises(ReadReceiptError, match="returned_versions"):
        build_read_receipt(
            "task-1",
            [returned],
            actor_id="operator-1",
            client_id="client-1",
            returned_versions=["artifact-v2"],
        )


def test_directory_listing_cannot_mark_material_as_read() -> None:
    listing = ReadRange("artifact-v1", "materials/", "directory_listing")

    with pytest.raises(ReadReceiptError, match="directory listings"):
        build_read_receipt(
            "task-1",
            [listing],
            actor_id="operator-1",
            client_id="client-1",
        )


def test_partial_status_requires_limitation() -> None:
    with pytest.raises(ReadReceiptError, match="limitations"):
        ReadRange(
            "artifact-v1",
            "word/document.xml",
            parse_status="partial",
        )


def test_pagination_with_more_results_requires_truncation() -> None:
    with pytest.raises(ReadReceiptError, match="truncation"):
        build_read_receipt(
            "task-1",
            [],
            actor_id="operator-1",
            client_id="client-1",
            pagination=ReadPagination(page_number=1, page_size=1, has_more=True, next_cursor="p2"),
        )


def test_persisted_receipt_round_trips_and_validates(tmp_path) -> None:
    receipt = build_read_receipt(
        "task-1",
        [ReadRange("artifact-v1", "word/document.xml")],
        actor_id="operator-1",
        client_id="client-1",
        created_at="2026-09-25T01:02:03+00:00",
    )
    path = tmp_path / "read-receipt.json"

    write_read_receipt(path, receipt)
    loaded = load_read_receipt(path)

    assert loaded == receipt


def test_receipt_identity_binds_method_dependencies_and_pagination() -> None:
    options = {
        "task_id": "task-1",
        "returned_ranges": [ReadRange("artifact-v1", "body")],
        "actor_id": "operator-1",
        "client_id": "client-1",
        "created_at": "2026-09-25T01:02:03+00:00",
    }
    variants = [
        {},
        {"method_version": "method-2"},
        {"dependencies": ["baseline-2"]},
        {"pagination": ReadPagination(1, 20, False, total_ranges=1)},
    ]
    receipts = [build_read_receipt(**options, **variant) for variant in variants]
    assert len({receipt.read_record_id for receipt in receipts}) == len(variants)


@pytest.mark.parametrize("has_more,cursor", [(True, None), (False, "unexpected")])
def test_pagination_cannot_contradict_continuation(has_more: bool, cursor: str | None) -> None:
    with pytest.raises(ReadReceiptError, match="must agree"):
        ReadPagination(1, 20, has_more, cursor)


def test_returned_range_cannot_simultaneously_be_unread() -> None:
    item = ReadRange("artifact-v1", "body")
    with pytest.raises(ReadReceiptError, match="both returned and unread"):
        build_read_receipt(
            "task-1", [item], actor_id="operator", client_id="client", unread_ranges=[item]
        )
