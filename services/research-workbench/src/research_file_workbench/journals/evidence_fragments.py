"""Extract source-bound review fragments from retained journal source bytes."""

from typing import cast

from research_file_workbench.common.json_io import JsonObject, decode_json_object
from research_file_workbench.docx.query import object_observations
from research_file_workbench.docx.reader import read_docx_bytes
from research_file_workbench.docx.report import READER_VERSION
from research_file_workbench.journals.models import (
    WorldAnalysisError,
    record_digest,
    require_objects,
)
from research_file_workbench.journals.pdf_analysis import (
    PDF_SOURCE_VERSION,
    analyze_pdf_bytes,
)

EVIDENCE_METHOD_VERSION = "journal-source-evidence-1.1.0"


def source_fragments(
    source_id: str, source_kind: str, payload: bytes
) -> tuple[list[JsonObject], list[str]]:
    """Extract fragments and reader issues for one retained source payload."""
    if source_kind == "guide_pdf":
        return _pdf_fragments(source_id, payload)
    if source_kind == "guide_text":
        return _text_source_fragments(source_id, payload)
    if source_kind == "rule_component_json":
        return _component_fragments(source_id, payload)
    return _docx_fragments(source_id, payload)


def _pdf_fragments(source_id: str, payload: bytes) -> tuple[list[JsonObject], list[str]]:
    blocks, issues = analyze_pdf_bytes(payload, source_id)
    fragments: list[JsonObject] = []
    for block in blocks:
        locator = f"page:{block.page_number}/block:{block.block_number}"
        kind = "pdf_heading" if block.kind == "heading" else "pdf_block"
        fragments.extend(
            _text_fragments(
                source_id,
                kind,
                locator,
                block.text,
                content={
                    "page": block.page_number,
                    "bbox": list(block.bbox),
                    "column_band": block.column_band,
                    "font_size": block.font_size,
                    "bold": block.bold,
                },
                reader_version=PDF_SOURCE_VERSION,
            )
        )
    return fragments, issues


def _text_source_fragments(source_id: str, payload: bytes) -> tuple[list[JsonObject], list[str]]:
    try:
        text = payload.decode("utf-8-sig")
    except UnicodeError as exc:
        raise WorldAnalysisError("Text guidance must be valid UTF-8") from exc
    fragments: list[JsonObject] = []
    for index, line in enumerate(text.splitlines(), start=1):
        if line.strip():
            fragments.extend(_text_fragments(source_id, "paragraph", f"line:{index}", line))
    return fragments, []


def _component_fragments(source_id: str, payload: bytes) -> tuple[list[JsonObject], list[str]]:
    component = decode_json_object(payload)
    root = _fragment(
        source_id,
        "component",
        "json:/",
        cast(str, component["component_id"]),
        content={
            "component_id": component["component_id"],
            "component_version": component["component_version"],
            "applicability": component["applicability"],
        },
    )
    fragments = [root]
    component_id = cast(str, root["fragment_id"])
    for index, rule in enumerate(require_objects(component["rules"], "component rules")):
        fragments.append(
            _fragment(
                source_id,
                "component_rule",
                f"json:/rules/{index}",
                f"{rule['property']} = {rule['expected']} {rule['unit']}",
                parent_id=component_id,
                content=rule,
            )
        )
    for index, source in enumerate(
        require_objects(component["sources"], "component source declarations")
    ):
        fragments.extend(
            _text_fragments(
                source_id,
                "source_quote",
                f"json:/sources/{index}",
                cast(str, source["quote"]),
                parent_id=component_id,
                content=source,
            )
        )
    return fragments, []


def _docx_fragments(source_id: str, payload: bytes) -> tuple[list[JsonObject], list[str]]:
    result = read_docx_bytes(payload, source_label=source_id)
    fragments: list[JsonObject] = []
    for observation in object_observations(result):
        content = cast(JsonObject, observation["content"])
        kind = cast(str, observation["object_type"])
        locator = cast(str, observation["range_locator"])
        if kind == "text_block":
            fragments.extend(
                _text_fragments(
                    source_id,
                    "paragraph",
                    locator,
                    cast(str, content["text"]),
                    part_path=cast(str, content["part_path"]),
                    content=content,
                )
            )
        else:
            fragments.append(
                _fragment(
                    source_id,
                    "docx_node",
                    locator,
                    "",
                    part_path=cast(str, content["part_path"]),
                    content={"object_type": kind, **content},
                )
            )
    for table in result.tables:
        table_id = fragment_id(source_id, "docx_node", table.node_locator)
        for row in table.rows:
            for cell in row:
                fragments.extend(
                    _text_fragments(
                        source_id,
                        "table_cell",
                        cell.node_locator,
                        cell.text,
                        parent_id=table_id,
                        part_path=table.part_path,
                        content={
                            "row_index": cell.row_index,
                            "cell_index": cell.cell_index,
                            "grid_span": cell.grid_span,
                            "vertical_merge": cell.vertical_merge,
                        },
                    )
                )
    return fragments, list(result.issues)


def fragment_id(
    source_id: str, kind: str, locator: str, *, reader_version: str = READER_VERSION
) -> str:
    """Build the stable identity for a source fragment.

    DOCX, text and component fragments bind the declared DOCX reader version;
    PDF fragments bind the PDF source extraction version instead, so a change in
    either extraction method produces new fragment identities.
    """
    return "fragment-" + record_digest(
        {
            "method_version": EVIDENCE_METHOD_VERSION,
            "reader_version": reader_version,
            "source_id": source_id,
            "kind": kind,
            "locator": locator,
        }
    )


def _fragment(
    source_id: str,
    kind: str,
    locator: str,
    text: str,
    *,
    parent_id: str | None = None,
    part_path: str | None = None,
    char_start: int | None = None,
    char_end: int | None = None,
    content: JsonObject | None = None,
    reader_version: str = READER_VERSION,
) -> JsonObject:
    return {
        "fragment_id": fragment_id(source_id, kind, locator, reader_version=reader_version),
        "source_id": source_id,
        "kind": kind,
        "locator": locator,
        "parent_fragment_id": parent_id,
        "part_path": part_path,
        "text": text,
        "char_start": char_start,
        "char_end": char_end,
        "content": {} if content is None else content,
    }


def _text_fragments(
    source_id: str,
    kind: str,
    locator: str,
    text: str,
    *,
    parent_id: str | None = None,
    part_path: str | None = None,
    content: JsonObject | None = None,
    reader_version: str = READER_VERSION,
) -> list[JsonObject]:
    parent = _fragment(
        source_id,
        kind,
        locator,
        text,
        parent_id=parent_id,
        part_path=part_path,
        content=content,
        reader_version=reader_version,
    )
    fragments = [parent]
    for index, (start, end) in enumerate(sentence_spans(text), start=1):
        fragments.append(
            _fragment(
                source_id,
                "sentence",
                f"{locator}/sentence[{index}]",
                text[start:end],
                parent_id=cast(str, parent["fragment_id"]),
                part_path=part_path,
                char_start=start,
                char_end=end,
                reader_version=reader_version,
            )
        )
    return fragments


def sentence_spans(text: str) -> list[tuple[int, int]]:
    """Return trimmed sentence spans while preserving source offsets."""
    spans: list[tuple[int, int]] = []
    start = 0
    for index, character in enumerate(text):
        if index < start:
            continue
        boundary = character in "。！？!?" or (
            character == "."
            and (index + 1 == len(text) or text[index + 1].isspace() or text[index + 1] in "\"'”’")
        )
        if index + 1 < len(text) and text[index + 1] in "。！？!?":
            boundary = False
        if boundary:
            end = index + 1
            while end < len(text) and text[end] in "\"'”’":
                end += 1
            spans.append((start, end))
            start = end
    if start < len(text):
        spans.append((start, len(text)))
    trimmed = []
    for start, end in spans:
        while start < end and text[start].isspace():
            start += 1
        while end > start and text[end - 1].isspace():
            end -= 1
        if start < end:
            trimmed.append((start, end))
    return trimmed
