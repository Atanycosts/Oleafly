"""Table header templates are projected only from consistent top-level body tables."""

from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.workbench.template_service import _table_header_templates
from tests.journals.test_analysis import template_bytes
from tests.workbench.test_template_service import snapshot


def _object_id(path: list[int]) -> str:
    return "/word/document.xml#" + ".".join(map(str, path))


def _base_snapshot() -> JsonObject:
    facts = snapshot(template_bytes(((11906, 16838, 1440, 2),)))
    facts["objects"] = []
    return facts


def _table(
    path: list[int],
    columns: int,
    *,
    top_level_body: bool = True,
    floating: bool = False,
    kind: str = "table",
) -> JsonObject:
    table: JsonObject = {"columnWidthsPt": [100] * columns}
    if floating:
        table["float"] = None
    return {
        "object_id": _object_id(path),
        "part": "/word/document.xml",
        "path": path,
        "kind": kind,
        "role": kind,
        "role_basis": [],
        "text": "",
        "properties": {"table": table},
        "declared": {},
        "evidence": {"top_level_body": top_level_body},
    }


def _row(
    table_path: list[int],
    row_index: int,
    row_count: int,
    is_header: object,
    *,
    physical_index: int | None = None,
    conditions: list[str] | None = None,
) -> JsonObject:
    path = [*table_path, row_index if physical_index is None else physical_index]
    return {
        "object_id": _object_id(path),
        "part": "/word/document.xml",
        "path": path,
        "kind": "tr",
        "role": "unknown",
        "role_basis": [],
        "text": "",
        "properties": {"row": {"isHeader": is_header}},
        "declared": {},
        "evidence": {},
        "table_context": {
            "table_object_id": _object_id(table_path),
            "row_index": row_index,
            "row_count": row_count,
            "conditions": conditions or [],
        },
    }


def _paragraph(
    table_path: list[int],
    row_index: int,
    row_count: int,
    column_index: int,
    text: str,
) -> JsonObject:
    path = [*table_path, row_index, column_index, 0]
    return {
        "object_id": _object_id(path),
        "part": "/word/document.xml",
        "path": path,
        "kind": "paragraph",
        "role": "unknown",
        "role_basis": [],
        "text": text,
        "properties": {"paragraph": {}},
        "declared": {},
        "evidence": {},
        "table_context": {
            "table_object_id": _object_id(table_path),
            "row_index": row_index,
            "row_count": row_count,
            "column_index": column_index,
            "column_count": 2,
            "conditions": [],
        },
    }


def test_table_header_templates_use_isheader_prefix_from_the_first_agreeing_table():
    facts = _base_snapshot()
    first = [0, 10, 0]
    second = [0, 11, 0]
    third = [0, 12, 0]
    facts["objects"] = [
        _table(first, 2),
        _row(first, 0, 3, True, conditions=["firstRow"]),
        _row(first, 1, 3, True),
        _row(first, 2, 3, False),
        _paragraph(first, 0, 3, 0, "Header A"),
        _paragraph(first, 0, 3, 1, "Header B"),
        _table(second, 2),
        _row(second, 0, 3, True),
        _row(second, 1, 3, True),
        _row(second, 2, 3, False),
        _paragraph(second, 0, 3, 0, "Other header"),
        _table(third, 3),
        _row(third, 0, 2, True, conditions=["firstRow"]),
        _row(third, 1, 2, False),
        _paragraph(third, 0, 2, 0, "Three columns"),
    ]

    assert _table_header_templates(facts) == [
        {
            "column_count": 2,
            "rows": [
                {
                    "object_id": _object_id([*first, 0]),
                    "location": "Table 1 · R1 · Header A · Header B",
                },
                {
                    "object_id": _object_id([*first, 1]),
                    "location": "Table 1 · R2",
                },
            ],
        },
        {
            "column_count": 3,
            "rows": [
                {
                    "object_id": _object_id([*third, 0]),
                    "location": "Table 3 · R1 · Three columns",
                }
            ],
        },
    ]


def test_table_header_templates_accept_tblpr_and_tblgrid_physical_offsets():
    facts = _base_snapshot()
    table_path = [0, 40, 0]
    facts["objects"] = [
        _table(table_path, 2),
        _row(table_path, 0, 3, True, physical_index=2),
        _row(table_path, 1, 3, True, physical_index=3),
        _row(table_path, 2, 3, False, physical_index=4),
        _paragraph(table_path, 0, 3, 0, "Header"),
    ]

    assert _table_header_templates(facts) == [
        {
            "column_count": 2,
            "rows": [
                {
                    "object_id": _object_id([*table_path, 2]),
                    "location": "Table 1 · R1 · Header",
                },
                {
                    "object_id": _object_id([*table_path, 3]),
                    "location": "Table 1 · R2",
                },
            ],
        }
    ]


def test_table_header_templates_reject_noncontiguous_or_unknown_header_flags():
    facts = _base_snapshot()
    noncontiguous = [0, 41, 0]
    unknown = [0, 42, 0]
    missing = [0, 43, 0]
    physical_order = [0, 44, 0]
    wrong_length = [0, 45, 0]
    wrong_prefix = [0, 46, 0]
    missing_header = _row(missing, 0, 2, True, physical_index=2)
    del missing_header["properties"]["row"]["isHeader"]
    extra_path_segment = _row(wrong_length, 0, 2, True, physical_index=2)
    extra_path_segment["path"] = [*wrong_length, 2, 0]
    different_parent = _row(wrong_prefix, 0, 2, True, physical_index=2)
    different_parent["path"] = [0, 46, 1, 2]
    facts["objects"] = [
        _table(noncontiguous, 2),
        _row(noncontiguous, 0, 3, True, physical_index=2),
        _row(noncontiguous, 1, 3, False, physical_index=3),
        _row(noncontiguous, 2, 3, True, physical_index=4),
        _table(unknown, 3),
        _row(unknown, 0, 2, "true", physical_index=2),
        _row(unknown, 1, 2, False, physical_index=3),
        _table(missing, 4),
        missing_header,
        _row(missing, 1, 2, False, physical_index=3),
        _table(physical_order, 5),
        _row(physical_order, 0, 2, True, physical_index=3),
        _row(physical_order, 1, 2, False, physical_index=2),
        _table(wrong_length, 6),
        extra_path_segment,
        _row(wrong_length, 1, 2, False, physical_index=3),
        _table(wrong_prefix, 7),
        different_parent,
        _row(wrong_prefix, 1, 2, False, physical_index=3),
    ]

    assert _table_header_templates(facts) == []


def test_table_header_templates_omit_a_column_count_when_any_table_disagrees():
    facts = _base_snapshot()
    objects: list[JsonObject] = []
    for table_path, columns, headers, row_count in (
        ([0, 20, 0], 2, [True, True, False], 3),
        ([0, 21, 0], 2, [True, False, False], 3),
        ([0, 22, 0], 3, [True, False], 2),
        ([0, 23, 0], 3, [True, True], 2),
        ([0, 24, 0], 4, [True, False], 2),
        ([0, 26, 0], 6, [True, False], 2),
        ([0, 27, 0], 6, [False, False], 2),
        ([0, 28, 0], 5, [True, False], 2),
    ):
        objects.append(_table(table_path, columns))
        objects.extend(
            _row(table_path, row_index, row_count, is_header)
            for row_index, is_header in enumerate(headers)
        )
    incomplete = [0, 25, 0]
    objects.extend(
        [
            _table(incomplete, 4),
            _row(incomplete, 0, 3, True),
            _row(incomplete, 2, 3, False),
        ]
    )
    facts["objects"] = objects

    assert [item["column_count"] for item in _table_header_templates(facts)] == [5]


def test_table_header_templates_exclude_non_body_float_nested_and_choice_tables():
    facts = _base_snapshot()
    valid = [0, 30, 0]
    objects: list[JsonObject] = [
        _table([0, 29, 0, 2], 2, top_level_body=False),
        _table(valid, 2),
        _row(valid, 0, 2, True),
        _row(valid, 1, 2, False),
        _table([0, 31, 0], 2, top_level_body=False),
        _row([0, 31, 0], 0, 3, True),
        _row([0, 31, 0], 1, 3, True),
        _row([0, 31, 0], 2, 3, False),
        _table([0, 32], 2),
        _row([0, 32], 0, 2, True),
        _row([0, 32], 1, 2, False),
        _table([0, 33, 0], 2, floating=True),
        _row([0, 33, 0], 0, 2, True),
        _row([0, 33, 0], 1, 2, False),
        _table([0, 34, 0], 0),
        _row([0, 34, 0], 0, 2, True),
        _row([0, 34, 0], 1, 2, False),
        _table([0, 35, 0], 2, kind="choice"),
        _row([0, 35, 0], 0, 2, True),
        _row([0, 35, 0], 1, 2, False),
        _table([0, 36, 0], 3),
        _row([0, 36, 0], 0, 2, False, conditions=["firstRow"]),
        _row([0, 36, 0], 1, 2, False),
    ]
    facts["objects"] = objects

    assert _table_header_templates(facts) == [
        {
            "column_count": 2,
            "rows": [
                {
                    "object_id": _object_id([*valid, 0]),
                    "location": "Table 2 · R1",
                }
            ],
        }
    ]
