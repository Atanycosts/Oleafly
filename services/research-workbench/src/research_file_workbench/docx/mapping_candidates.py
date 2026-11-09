"""Match independently declared locators against concrete source observations."""

import re
from dataclasses import dataclass

from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.docx.models import DocxReadResult
from research_file_workbench.docx.xml_support import region_for_part

# Annotation locators use these bounded tokens; prose is never executed or inferred as XML.
_MARKER = re.compile(r"\bRFW-[A-Za-z0-9][A-Za-z0-9-]*\b")
_PART = re.compile(r"\b(?:word|customXml)/(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+\.xml\b")
_PARAGRAPH = re.compile(r"\b(body )?paragraph ([0-9]+)\b", re.IGNORECASE)
_SECTION = re.compile(r"\bsection ([0-9]+)\b", re.IGNORECASE)
_DOCPR = re.compile(r"(?:wp:)?docPr\s+id\s*=\s*([^\s,;]*)", re.IGNORECASE)
_RELATIONSHIP = re.compile(r"(?<![\w:])r:(?:id|embed)\s*=\s*([^\s,;]*)")
_REFERENCE = re.compile(r"(?<![\w:])w:id\s*=\s*([^\s,;]*)")
_BREAK = re.compile(r"w:br\s+w:type\s*=\s*([^\s,;]*)")
_NODE = re.compile(_PART.pattern + r"#[^\s,;]+")
_NODE_PATH = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\[[0-9]+\](?:/[A-Za-z_][A-Za-z0-9_]*\[[0-9]+\])*")


@dataclass(frozen=True)
class MappingCandidate:
    """An exact object occurrence, independent of its displayed paragraph text."""

    locator: str
    object_type: str
    occurrence_index: int | None = None

    def to_json(self) -> JsonObject:
        return {
            "node_locator": self.locator,
            "object_type": self.object_type,
            "occurrence_index": self.occurrence_index,
        }


def find_candidates(result: DocxReadResult, annotation: JsonObject) -> list[MappingCandidate]:
    """Require every supported locator constraint; absent proof produces no candidate."""
    locator = annotation.get("locator")
    if not isinstance(locator, str):
        return []
    exact_nodes = _NODE.findall(locator)
    if locator.count("#") != len(exact_nodes) or any(
        _NODE_PATH.fullmatch(node.split("#", 1)[1]) is None for node in exact_nodes
    ):
        return []
    candidates = _find_candidates(result, annotation)
    return [
        candidate
        for candidate in candidates
        if all(
            candidate.locator == node or candidate.locator.startswith(node + "/")
            for node in exact_nodes
        )
    ]


def _attribute_values(
    locator: str, pattern: re.Pattern[str], value_pattern: str
) -> set[str] | None:
    values: set[str] = set()
    for match in pattern.finditer(locator):
        value = match.group(1)
        if value.startswith(("'", '"')):
            if len(value) < 2 or value[-1] != value[0]:
                return None
            value = value[1:-1]
        if re.fullmatch(value_pattern, value) is None:
            return None
        values.add(value)
    return values


def _find_candidates(result: DocxReadResult, annotation: JsonObject) -> list[MappingCandidate]:
    locator = annotation.get("locator")
    kind = annotation.get("kind")
    if not isinstance(locator, str) or not isinstance(kind, str):
        return []
    declared_parts = set(_PART.findall(locator))
    if not declared_parts:
        return []
    part = next(iter(declared_parts)) if len(declared_parts) == 1 else None
    source_part = _PART.search(locator)
    if kind != "duplicate_text" and source_part is not None:
        part = source_part.group(0)
    region = annotation.get("region")
    markers = _MARKER.findall(locator)
    paragraph_matches = list(_PARAGRAPH.finditer(locator))
    if kind == "adjacent_anchor" and " immediately before " in locator:
        paragraph_matches = list(_PARAGRAPH.finditer(locator.split(" immediately before ")[0]))
    docpr_ids = _attribute_values(locator, _DOCPR, r"[0-9]+")
    relationship_ids = _attribute_values(locator, _RELATIONSHIP, r"[A-Za-z0-9_-]+")
    reference_ids = _attribute_values(locator, _REFERENCE, r"[0-9]+")
    if docpr_ids is None or relationship_ids is None or reference_ids is None:
        return []
    scopes = {scope.node_locator: scope for scope in result.paragraph_scopes}
    texts = {block.node_locator: block.text for block in result.text_blocks}

    def matches(
        item_part: str, parent: str | None, text: str = "", *, check_paragraph: bool = True
    ) -> bool:
        if (part is not None and item_part != part) or item_part not in declared_parts:
            return False
        scope = scopes.get(parent or "")
        actual_region = scope.region if scope is not None else region_for_part(item_part)
        if region is not None and actual_region != region:
            return False
        if check_paragraph and paragraph_matches:
            if scope is None:
                return False
            for paragraph_match in paragraph_matches:
                index = (
                    scope.body_container_index
                    if paragraph_match.group(1) is not None
                    else scope.region_index
                )
                if index != int(paragraph_match.group(2)):
                    return False
        observed = text + " " + texts.get(parent or "", "")
        return all(marker in observed for marker in markers)

    candidates: list[MappingCandidate] = []
    if kind in {"inline_drawing", "anchored_drawing"}:
        expected = "inline" if kind == "inline_drawing" else "anchored"
        for image in result.images:
            if image.container != expected or not matches(
                image.part_path, image.paragraph_locator, image.name or ""
            ):
                continue
            if any(image.docpr_id != value for value in docpr_ids):
                continue
            if any(image.relationship_id != value for value in relationship_ids):
                continue
            candidates.append(MappingCandidate(image.node_locator, "image"))
        return candidates
    if kind in {"inline_equation", "display_equation"}:
        expected = "inline" if kind == "inline_equation" else "display"
        return [
            MappingCandidate(item.node_locator, "math")
            for item in result.math_objects
            if item.kind == expected
            and matches(item.part_path, item.paragraph_locator, item.text + item.omml_source)
        ]
    if kind in {"nested_field", "zotero_field", "cross_reference"}:
        expected_field = {"nested_field": None, "zotero_field": "addin", "cross_reference": "ref"}[
            kind
        ]
        for field in result.fields:
            if kind == "nested_field" and (
                field.nested_level != 0 or len(field.boundary_sequence) <= 3
            ):
                continue
            if expected_field is not None and field.field_kind != expected_field:
                continue
            if kind == "zotero_field" and "ZOTERO" not in field.instruction.upper():
                continue
            if matches(field.part_path, field.node_locator, field.instruction + field.result_text):
                candidates.append(
                    MappingCandidate(field.node_locator, "field", field.occurrence_index)
                )
        return candidates
    if kind in {
        "footnote_reference",
        "endnote_reference",
        "comment_anchor",
        "external_target",
        "bookmark",
    }:
        expected_reference = "hyperlink" if kind == "external_target" else kind
        for reference in result.references:
            if reference.kind != expected_reference or not matches(
                reference.part_path, reference.paragraph_locator, reference.reference_name or ""
            ):
                continue
            if any(reference.reference_id != value for value in reference_ids):
                continue
            if any(reference.relationship_id != value for value in relationship_ids):
                continue
            candidates.append(MappingCandidate(reference.node_locator, "reference"))
        return candidates
    complex_kind = "chart" if kind == "embedded_chart" else kind
    if complex_kind in {"chart", "ole", "group_drawing", "unknown_extension"}:
        for complex_object in result.complex_objects:
            metadata = " ".join(value for _, value in complex_object.metadata)
            if complex_object.kind != complex_kind or not matches(
                complex_object.part_path, complex_object.paragraph_locator, metadata
            ):
                continue
            if not relationship_ids.issubset(complex_object.relationship_ids):
                continue
            candidates.append(MappingCandidate(complex_object.node_locator, "complex_object"))
        return candidates
    if kind in {"repeated_header", "multi_page_table", "merged_cell"}:
        for table in result.tables:
            cells = [cell for row in table.rows for cell in row]
            if not matches(table.part_path, None, " ".join(cell.text for cell in cells)):
                continue
            if kind == "repeated_header" and not table.repeat_header_rows:
                continue
            if kind == "merged_cell" and not any(
                cell.grid_span > 1 and all(marker in cell.text for marker in markers)
                for cell in cells
            ):
                continue
            candidates.append(MappingCandidate(table.node_locator, "table"))
        return candidates
    section_ids = {int(match.group(1)) for match in _SECTION.finditer(locator)}
    if kind == "layout_marker" and section_ids:
        return [
            MappingCandidate(section.node_locator, "section")
            for section in result.sections
            if all(section.section_index == value for value in section_ids)
            and matches(section.part_path, section.attached_locator, check_paragraph=False)
        ]
    break_types = _attribute_values(locator, _BREAK, r"[A-Za-z]+")
    if break_types is None:
        return []
    if kind == "layout_marker" and break_types:
        return [
            MappingCandidate(item.node_locator, "break")
            for item in result.breaks
            if all(item.break_type == value for value in break_types)
            and matches(item.part_path, item.node_locator.split("/break[")[0])
        ]
    text_kinds = {
        "paragraph",
        "pagination_anchor",
        "duplicate_text",
        "adjacent_anchor",
        "caption",
        "hidden_text",
        "revision",
        "footnote",
        "endnote",
        "header",
        "footer",
        "textbox",
        "layout_marker",
        "style_inheritance",
        "numbering",
        "font_control",
        "missing_font",
        "broken_relationship",
        "missing_internal_target",
        "missing_external_dependency",
    }
    if kind not in text_kinds:
        return []
    for block in result.text_blocks:
        if not matches(block.part_path, block.node_locator, block.text):
            continue
        if kind == "caption" and not block.caption:
            continue
        if kind == "hidden_text" and not block.hidden:
            continue
        if kind == "revision" and block.revision_state == "none":
            continue
        candidates.append(MappingCandidate(block.node_locator, "text_block"))
    return candidates
