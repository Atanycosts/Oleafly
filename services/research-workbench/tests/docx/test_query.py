from __future__ import annotations

import base64
import json
from dataclasses import replace
from pathlib import Path
from typing import cast

import pytest

from research_file_workbench.common.json_io import JsonObject, load_json_object
from research_file_workbench.docx import DocxReadResult, join_page_evidence, read_docx
from research_file_workbench.docx.query import (
    QUERY_VERSION,
    ReadQuery,
    ReadQueryError,
    catalog_docx,
    query_docx,
)
from research_file_workbench.docx.read_receipt import ReadReceipt

PROJECT_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_ROOT = PROJECT_ROOT / "tests" / "fixtures" / "docx"
ANNOTATION_ROOT = PROJECT_ROOT / "annotations" / "s1"


@pytest.fixture
def regions_document() -> DocxReadResult:
    return read_docx(FIXTURE_ROOT / "normal/s1-regions-fields/s1-regions-fields.docx")


@pytest.fixture
def figures_document() -> DocxReadResult:
    return read_docx(FIXTURE_ROOT / "normal/s1-figures-tables/s1-figures-tables.docx")


def _query(
    result: DocxReadResult,
    query: ReadQuery,
    *,
    page_mapping: JsonObject | None = None,
) -> JsonObject:
    return query_docx(
        result,
        query,
        task_id="query-test-task",
        actor_id="query-test-operator",
        client_id="query-test-client",
        page_mapping=page_mapping,
    )


def _items(response: JsonObject) -> list[JsonObject]:
    return cast(list[JsonObject], response["items"])


def _pagination(response: JsonObject) -> JsonObject:
    return cast(JsonObject, response["pagination"])


def _page_mapping(result: DocxReadResult, sample_id: str) -> JsonObject:
    directory = ANNOTATION_ROOT / sample_id
    return join_page_evidence(
        result,
        load_json_object(directory / "document-annotation.json"),
        load_json_object(directory / "page-evidence.json"),
    ).to_json()


def _cursor_with_offset(cursor: str, offset: object) -> str:
    payload = json.loads(base64.urlsafe_b64decode(cursor))
    payload["offset"] = offset
    return base64.urlsafe_b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")


def test_reviewed_field_mapping_returns_exact_occurrence_not_its_paragraph(
    regions_document: DocxReadResult,
) -> None:
    mapping = _page_mapping(regions_document, "s1-regions-fields")
    response = _query(
        regions_document,
        ReadQuery(page_number=1, object_type="field", page_size=100),
        page_mapping=mapping,
    )
    kinds = {item["content"]["field_kind"] for item in response["items"]}
    assert kinds == {"if", "addin", "ref"}
    assert len(response["items"]) == 3
    assert all(item["content"]["nested_level"] == 0 for item in response["items"])


def test_catalog_lists_metadata_without_read_content_or_receipt(
    regions_document: DocxReadResult,
) -> None:
    catalog = catalog_docx(regions_document)

    assert catalog["status"] == "catalog_only"
    assert catalog["query_version"] == QUERY_VERSION
    assert "read_receipt" not in catalog
    assert _items(catalog)
    assert all("content" not in item for item in _items(catalog))
    assert all("region_scope" in item for item in _items(catalog))
    assert "RFW-FX-RF-BODY-001" not in json.dumps(catalog)
    assert len({item["object_id"] for item in _items(catalog)}) == len(_items(catalog))
    assert catalog_docx(regions_document) == catalog


@pytest.mark.parametrize("region", ["body", "header", "footer", "footnote", "endnote", "textbox"])
def test_region_query_returns_only_selected_region_text(
    regions_document: DocxReadResult, region: str
) -> None:
    response = _query(
        regions_document, ReadQuery(region=region, object_type="text_block", page_size=100)
    )
    items = _items(response)
    expected = [block for block in regions_document.text_blocks if block.region == region]

    assert items
    assert {item["region"] for item in items} == {region}
    assert {item["object_type"] for item in items} == {"text_block"}
    assert [item["node_locator"] for item in items] == [block.node_locator for block in expected]
    assert [cast(JsonObject, item["content"])["text"] for item in items] == [
        block.text for block in expected
    ]
    assert response["query_scope"] == {
        "region": region,
        "object_type": "text_block",
        "object_id": None,
        "page_number": None,
    }


def test_first_page_receipt_records_only_returned_objects_and_all_other_objects_as_unread(
    regions_document: DocxReadResult,
) -> None:
    catalog = catalog_docx(regions_document)
    response = _query(
        regions_document, ReadQuery(region="body", object_type="text_block", page_size=2)
    )
    items = _items(response)
    receipt = ReadReceipt.from_json(response["read_receipt"])
    returned_keys = {(item["object_type"], item["range_locator"]) for item in items}
    all_keys = {(item["object_type"], item["range_locator"]) for item in _items(catalog)}

    assert len(items) == 2
    assert {(item.range_type, item.locator) for item in receipt.ranges} == returned_keys
    assert {(item.range_type, item.locator) for item in receipt.unread_ranges} == (
        all_keys - returned_keys
    )
    assert all(item.parse_status == "unverified" for item in receipt.unread_ranges)
    assert all(item.limitations for item in receipt.unread_ranges)
    assert receipt.returned_versions == (f"artifact-version-{regions_document.source_sha256}",)
    assert receipt.task_id == "query-test-task"
    assert receipt.actor_id == "query-test-operator"
    assert receipt.client_id == "query-test-client"
    assert receipt.method_version == QUERY_VERSION
    assert receipt.truncation is True
    assert receipt.pagination is not None
    assert receipt.pagination.to_json() == response["pagination"]
    assert _pagination(response)["page_number"] == 1
    assert _pagination(response)["has_more"] is True
    assert isinstance(_pagination(response)["next_cursor"], str)


def test_continuous_pages_cover_selected_objects_once_with_response_local_receipts(
    regions_document: DocxReadResult,
) -> None:
    expected = [
        block.node_locator for block in regions_document.text_blocks if block.region == "body"
    ]
    query = ReadQuery(region="body", object_type="text_block", page_size=3)
    object_ids: list[object] = []
    locators: list[object] = []
    receipt_locators: set[str] = set()
    page_number = 0

    while True:
        response = _query(regions_document, query)
        items = _items(response)
        receipt = ReadReceipt.from_json(response["read_receipt"])
        page_number += 1
        assert len(items) <= query.page_size
        assert _pagination(response)["page_number"] == page_number
        assert _pagination(response)["total_ranges"] == len(expected)
        assert {item.locator for item in receipt.ranges} == {
            item["range_locator"] for item in items
        }
        assert receipt_locators <= {item.locator for item in receipt.unread_ranges}
        receipt_locators.update(item.locator for item in receipt.ranges)
        object_ids.extend(item["object_id"] for item in items)
        locators.extend(item["node_locator"] for item in items)
        if not _pagination(response)["has_more"]:
            assert _pagination(response)["next_cursor"] is None
            break
        cursor = _pagination(response)["next_cursor"]
        assert isinstance(cursor, str)
        query = replace(query, cursor=cursor)
        assert page_number <= len(expected)

    assert locators == expected
    assert len(object_ids) == len(set(object_ids)) == len(expected)


def test_object_id_query_returns_exactly_one_catalog_object(
    regions_document: DocxReadResult,
) -> None:
    target = next(
        item for item in _items(catalog_docx(regions_document)) if item["region"] == "header"
    )
    response = _query(regions_document, ReadQuery(object_id=cast(str, target["object_id"])))

    assert len(_items(response)) == 1
    assert {key: value for key, value in _items(response)[0].items() if key != "content"} == target
    assert _pagination(response)["has_more"] is False
    assert _pagination(response)["total_ranges"] == 1
    assert len(ReadReceipt.from_json(response["read_receipt"]).ranges) == 1


def test_unknown_or_conflicting_object_id_is_rejected(regions_document: DocxReadResult) -> None:
    with pytest.raises(ReadQueryError):
        _query(regions_document, ReadQuery(object_id="object-does-not-exist"))

    target = next(
        item for item in _items(catalog_docx(regions_document)) if item["region"] == "header"
    )
    with pytest.raises(ReadQueryError):
        _query(
            regions_document,
            ReadQuery(object_id=cast(str, target["object_id"]), region="body"),
        )


def test_cursor_is_rejected_after_source_change(regions_document: DocxReadResult) -> None:
    query = ReadQuery(object_type="text_block", page_size=2)
    cursor = cast(str, _pagination(_query(regions_document, query))["next_cursor"])
    changed_document = replace(regions_document, source_sha256="0" * 64)

    with pytest.raises(ReadQueryError, match="changed"):
        _query(changed_document, replace(query, cursor=cursor))


def test_cursor_cannot_point_past_last_selected_object(regions_document: DocxReadResult) -> None:
    query = ReadQuery(object_type="text_block", page_size=2)
    cursor = cast(str, _pagination(_query(regions_document, query))["next_cursor"])

    with pytest.raises(ReadQueryError):
        _query(
            regions_document,
            replace(query, cursor=_cursor_with_offset(cursor, len(regions_document.text_blocks))),
        )


@pytest.mark.parametrize(
    "changes",
    [{"region": "header"}, {"object_type": "field"}, {"page_size": 3}],
)
def test_cursor_is_rejected_after_selection_or_page_size_change(
    regions_document: DocxReadResult, changes: dict[str, object]
) -> None:
    query = ReadQuery(object_type="text_block", page_size=2)
    cursor = cast(str, _pagination(_query(regions_document, query))["next_cursor"])

    with pytest.raises(ReadQueryError, match="changed"):
        _query(regions_document, replace(query, cursor=cursor, **changes))


@pytest.mark.parametrize("cursor", ["%%%", "e30=", "W10=", "bnVsbA==", "bm90LWpzb24="])
def test_malformed_cursor_is_rejected(regions_document: DocxReadResult, cursor: str) -> None:
    with pytest.raises(ReadQueryError):
        _query(regions_document, ReadQuery(cursor=cursor))


@pytest.mark.parametrize("offset", [-1, 0, 1, 1000000, True, "2", None])
def test_out_of_range_or_invalid_cursor_offset_is_rejected(
    regions_document: DocxReadResult, offset: object
) -> None:
    query = ReadQuery(object_type="text_block", page_size=2)
    cursor = cast(str, _pagination(_query(regions_document, query))["next_cursor"])

    with pytest.raises(ReadQueryError):
        _query(regions_document, replace(query, cursor=_cursor_with_offset(cursor, offset)))


@pytest.mark.parametrize(
    "arguments",
    [
        {"region": "unknown-region"},
        {"object_type": "unknown-object"},
        {"object_id": " "},
        {"cursor": " "},
        {"page_size": 0},
        {"page_size": -1},
        {"page_size": True},
        {"page_size": 1.5},
        {"page_size": None},
        {"page_size": "2"},
        {"page_number": 0},
        {"page_number": True},
        {"page_number": "1"},
    ],
)
def test_query_rejects_invalid_selection_arguments(arguments: dict[str, object]) -> None:
    with pytest.raises(ReadQueryError):
        ReadQuery(**arguments)


def test_page_query_without_mapping_is_rejected(regions_document: DocxReadResult) -> None:
    with pytest.raises(ReadQueryError, match="page-mapping"):
        _query(regions_document, ReadQuery(page_number=1))


def test_valid_empty_selection_has_no_returned_version_or_ranges(
    regions_document: DocxReadResult,
) -> None:
    response = _query(regions_document, ReadQuery(region="header", object_type="table"))
    receipt = ReadReceipt.from_json(response["read_receipt"])

    assert _items(response) == []
    assert receipt.returned_versions == ()
    assert receipt.ranges == ()
    assert receipt.truncation is False
    assert len(receipt.unread_ranges) == len(_items(catalog_docx(regions_document)))
    assert _pagination(response) == {
        "page_number": 1,
        "page_size": 20,
        "has_more": False,
        "next_cursor": None,
        "total_ranges": 0,
    }


def test_reviewed_unique_page_mappings_return_only_known_page_objects(
    figures_document: DocxReadResult,
) -> None:
    mapping = _page_mapping(figures_document, "s1-figures-tables")
    response = _query(
        figures_document,
        ReadQuery(page_number=1, object_type="image"),
        page_mapping=mapping,
    )

    assert {item["node_locator"] for item in _items(response)} == {
        image.node_locator for image in figures_document.images
    }
    assert len(_items(response)) == 2
    assert response["status"] == "partial"
    assert response["coverage_gaps"]
    assert response["limitations"]
    assert len(ReadReceipt.from_json(response["read_receipt"]).ranges) == 2
    assert (
        _items(
            _query(
                figures_document,
                ReadQuery(page_number=3, object_type="image"),
                page_mapping=mapping,
            )
        )
        == []
    )


def test_ambiguous_mapping_is_not_promoted_to_a_page_read() -> None:
    source = FIXTURE_ROOT / "normal/s1-pagination-ambiguity/s1-pagination-ambiguity.docx"
    result = read_docx(source)
    mapping = _page_mapping(result, "s1-pagination-ambiguity")
    ambiguous = next(
        item
        for item in cast(list[JsonObject], mapping["mappings"])
        if item["object_annotation_id"] == "rfw-fx-pa-duplicate-text"
    )
    response = _query(result, ReadQuery(page_number=2, page_size=100), page_mapping=mapping)
    ambiguous_locators = set(cast(list[str], ambiguous["reader_candidate_locators"]))

    assert ambiguous["mapping_status"] == "ambiguous"
    assert ambiguous_locators
    assert not ambiguous_locators.intersection(item["node_locator"] for item in _items(response))
    assert not ambiguous_locators.intersection(
        item.locator for item in ReadReceipt.from_json(response["read_receipt"]).ranges
    )
    gaps = cast(list[JsonObject], response["coverage_gaps"])
    assert any(
        gap.get("object_annotation_id") == "rfw-fx-pa-duplicate-text"
        and gap.get("mapping_status") == "ambiguous"
        for gap in gaps
    )


def test_mapping_requires_both_joined_and_independent_review_status(
    figures_document: DocxReadResult,
) -> None:
    mapping = _page_mapping(figures_document, "s1-figures-tables")
    entries = cast(list[JsonObject], mapping["mappings"])
    target = next(
        item for item in entries if item["object_annotation_id"] == "rfw-fx-ft-inline-image-001"
    )
    target["independent_mapping_status"] = "unreviewed"
    response = _query(
        figures_document, ReadQuery(page_number=1, object_type="image"), page_mapping=mapping
    )

    assert len(_items(response)) == 1
    assert _items(response)[0]["node_locator"] == figures_document.images[1].node_locator
    assert any(
        gap.get("object_annotation_id") == "rfw-fx-ft-inline-image-001"
        for gap in cast(list[JsonObject], response["coverage_gaps"])
    )


def test_mapping_without_pages_keeps_object_in_unmapped_coverage_gap(
    figures_document: DocxReadResult,
) -> None:
    mapping = _page_mapping(figures_document, "s1-figures-tables")
    entries = cast(list[JsonObject], mapping["mappings"])
    target = next(
        item for item in entries if item["object_annotation_id"] == "rfw-fx-ft-inline-image-001"
    )
    target["page_numbers"] = []
    image = next(
        item
        for item in _items(catalog_docx(figures_document))
        if item["object_type"] == "image"
        and item["node_locator"] == figures_document.images[0].node_locator
    )

    response = _query(figures_document, ReadQuery(page_number=1), page_mapping=mapping)

    assert image["object_id"] not in {item["object_id"] for item in _items(response)}
    assert any(
        image["object_id"] in cast(list[str], gap.get("object_ids", []))
        for gap in cast(list[JsonObject], response["coverage_gaps"])
    )


def test_page_mapping_source_and_known_page_bounds_are_enforced(
    figures_document: DocxReadResult,
) -> None:
    mapping = _page_mapping(figures_document, "s1-figures-tables")
    with pytest.raises(ReadQueryError, match="source"):
        _query(
            figures_document,
            ReadQuery(page_number=1),
            page_mapping={**mapping, "source_sha256": "0" * 64},
        )
    with pytest.raises(ReadQueryError, match="page count"):
        _query(
            figures_document,
            ReadQuery(page_number=4),
            page_mapping={**mapping, "page_count": 3},
        )


def test_cursor_is_rejected_after_page_evidence_change(figures_document: DocxReadResult) -> None:
    mapping = _page_mapping(figures_document, "s1-figures-tables")
    query = ReadQuery(page_number=1, object_type="image", page_size=1)
    response = _query(figures_document, query, page_mapping=mapping)
    cursor = cast(str, _pagination(response)["next_cursor"])

    with pytest.raises(ReadQueryError, match="changed"):
        _query(
            figures_document,
            replace(query, cursor=cursor),
            page_mapping={**mapping, "pdf_sha256": "0" * 64},
        )


@pytest.mark.parametrize("status", [None, "unreviewed", [], {}])
def test_invalid_mapping_status_is_rejected(
    figures_document: DocxReadResult, status: object
) -> None:
    mapping = _page_mapping(figures_document, "s1-figures-tables")
    cast(list[JsonObject], mapping["mappings"])[0]["mapping_status"] = status

    with pytest.raises(ReadQueryError):
        _query(figures_document, ReadQuery(page_number=1), page_mapping=mapping)


@pytest.mark.parametrize(
    "relative_path",
    [
        "normal/s1-regions-fields/s1-regions-fields.docx",
        "normal/s1-sections-layout/s1-sections-layout.docx",
        "normal/s1-figures-tables/s1-figures-tables.docx",
        "normal/s1-embedded-objects/s1-embedded-objects.docx",
        "native/s1-native-complex-objects/s1-native-complex-objects.docx",
        "faults/s1-broken-relationships/s1-broken-relationships.docx",
    ],
)
def test_all_fixture_object_types_have_content_and_receipt_ranges(relative_path: str) -> None:
    result = read_docx(FIXTURE_ROOT / relative_path)
    response = _query(result, ReadQuery(page_size=1000))
    receipt = ReadReceipt.from_json(response["read_receipt"])
    expected_count = sum(
        len(collection)
        for collection in (
            result.text_blocks,
            result.tables,
            result.images,
            result.math_objects,
            result.fields,
            result.sections,
            result.breaks,
            result.complex_objects,
            result.references,
        )
    )

    assert len(_items(response)) == len(receipt.ranges) == expected_count
    assert receipt.unread_ranges == ()
    assert _pagination(response)["has_more"] is False
    assert all(item["content"] for item in _items(response))
    assert {(item["object_type"], item["range_locator"]) for item in _items(response)} == {
        (item.range_type, item.locator) for item in receipt.ranges
    }


def test_complex_objects_retain_unsupported_status_and_limitations() -> None:
    source = FIXTURE_ROOT / "native/s1-native-complex-objects/s1-native-complex-objects.docx"
    result = read_docx(source)
    response = _query(result, ReadQuery(object_type="complex_object"))
    contents = [cast(JsonObject, item["content"]) for item in _items(response)]
    receipt = ReadReceipt.from_json(response["read_receipt"])

    assert {"chart", "ole", "group_drawing"} <= {item["kind"] for item in contents}
    assert all(item["parse_status"] == "unsupported" for item in contents)
    assert all(item["limitations"] for item in contents)
    assert all(item.parse_status == "unsupported" and item.limitations for item in receipt.ranges)
    assert len(receipt.ranges) == len(result.complex_objects)
    assert response["status"] == "partial"


def test_nested_fields_with_one_node_locator_keep_distinct_ids_and_read_ranges(
    regions_document: DocxReadResult,
) -> None:
    response = _query(regions_document, ReadQuery(object_type="field"))
    items = _items(response)
    nested_fields = [
        item for item in items if item["node_locator"] == "word/document.xml#paragraph[12]"
    ]
    receipt = ReadReceipt.from_json(response["read_receipt"])

    assert {cast(JsonObject, item["content"])["field_kind"] for item in nested_fields} == {
        "mergefield",
        "if",
    }
    assert len({item["object_id"] for item in nested_fields}) == 2
    assert len({item["range_locator"] for item in nested_fields}) == 2
    assert len(receipt.ranges) == len(regions_document.fields)
    assert len({(item.range_type, item.locator) for item in receipt.ranges}) == len(receipt.ranges)

    for item in nested_fields:
        exact = _query(regions_document, ReadQuery(object_id=cast(str, item["object_id"])))
        assert _items(exact) == [item]


@pytest.mark.parametrize("duplicated_key", ["binding", "offset"])
def test_duplicate_json_cursor_keys_are_rejected(
    regions_document: DocxReadResult, duplicated_key: str
) -> None:
    query = ReadQuery(object_type="text_block", page_size=2)
    cursor = cast(str, _pagination(_query(regions_document, query))["next_cursor"])
    payload = json.loads(base64.urlsafe_b64decode(cursor))
    if duplicated_key == "binding":
        encoded_payload = (
            '{"binding":"not-the-selected-query","binding":'
            + json.dumps(payload["binding"])
            + ',"offset":2}'
        )
    else:
        encoded_payload = '{"binding":' + json.dumps(payload["binding"]) + ',"offset":0,"offset":2}'
    ambiguous = base64.urlsafe_b64encode(encoded_payload.encode()).decode()
    with pytest.raises(ReadQueryError, match="Malformed cursor"):
        _query(regions_document, replace(query, cursor=ambiguous))


def test_cursor_from_the_previous_query_method_is_rejected(
    regions_document: DocxReadResult, monkeypatch: pytest.MonkeyPatch
) -> None:
    from research_file_workbench.docx import query as query_module

    query = ReadQuery(page_size=2)
    with monkeypatch.context() as historical:
        historical.setattr(query_module, "QUERY_VERSION", "s1-read-query-1.5.0")
        cursor = cast(str, _pagination(_query(regions_document, query))["next_cursor"])
    with pytest.raises(ReadQueryError, match="method.*changed"):
        _query(regions_document, replace(query, cursor=cursor))


def test_selection_delivery_tracks_continuation_and_never_claims_coverage(
    regions_document: DocxReadResult,
) -> None:
    """One response may hold its whole selection while coverage stays partial."""
    whole = _query(regions_document, ReadQuery(page_size=100000))

    assert whole["selection_delivery"] == "continuation_exhausted"
    assert whole["status"] == "partial"
    assert _pagination(whole)["has_more"] is False
    assert len(_items(whole)) == _pagination(whole)["total_ranges"]

    continued = _query(regions_document, ReadQuery(page_size=1))

    assert continued["selection_delivery"] == "continuation_available"
    assert continued["status"] == "partial"
    assert _pagination(continued)["has_more"] is True
    assert len(_items(continued)) == 1


def test_walking_a_selection_ends_on_the_exhausted_continuation_state(
    regions_document: DocxReadResult,
) -> None:
    """The continuation axis is derived per response, so a selection can actually finish."""
    query = ReadQuery(object_type="text_block", page_size=2)
    delivered = 0
    pages = 0
    while True:
        response = _query(regions_document, query)
        assert response["status"] == "partial"
        delivered += len(_items(response))
        pages += 1
        cursor = _pagination(response)["next_cursor"]
        if cursor is None:
            assert response["selection_delivery"] == "continuation_exhausted"
            break
        assert response["selection_delivery"] == "continuation_available"
        query = replace(query, cursor=cast(str, cursor))

    assert pages > 1
    assert delivered == _pagination(response)["total_ranges"]


def test_a_cursor_reached_tail_page_reports_continuation_not_possession(
    regions_document: DocxReadResult,
) -> None:
    """An exhausted continuation never claims that the response holds the whole selection.

    The value is derived from ``has_more``, so the last page of a walked selection reports
    ``continuation_exhausted`` while holding only its final slice. The receipt has to keep naming
    what that response did not return, otherwise the value would read as a coverage claim.
    """
    query = ReadQuery(object_type="text_block", page_size=2)
    selected = _pagination(_query(regions_document, query))["total_ranges"]
    response = _query(regions_document, query)
    while True:
        cursor = _pagination(response)["next_cursor"]
        if cursor is None:
            break
        response = _query(regions_document, replace(query, cursor=cast(str, cursor)))

    assert response["selection_delivery"] == "continuation_exhausted"
    assert response["status"] == "partial"
    assert len(_items(response)) < selected
    assert response["read_receipt"]["truncation"] is True
    assert response["read_receipt"]["unread_ranges"]


def test_catalog_metadata_carries_no_selection_delivery(
    regions_document: DocxReadResult,
) -> None:
    """Catalog listing is not a content selection, so it reports no delivery state."""
    catalog = catalog_docx(regions_document)

    assert catalog["status"] == "catalog_only"
    assert "selection_delivery" not in catalog
