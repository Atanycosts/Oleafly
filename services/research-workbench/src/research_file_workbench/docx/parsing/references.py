"""Source reference targets and selected paragraph ancestry."""

from __future__ import annotations

from typing import Literal
from xml.etree import ElementTree

from research_file_workbench.docx.models import DocxReference, DocxRelationship
from research_file_workbench.docx.xml_support import (
    OFFICE_RELATIONSHIP_NAMESPACE,
    WORD_NAMESPACE,
    iter_selected,
    paragraph_membership,
    region_for_part,
    string_attribute,
    tag_local_name,
)


def read_references(
    xml_roots: dict[str, ElementTree.Element],
    relationships: tuple[DocxRelationship, ...],
) -> tuple[tuple[DocxReference, ...], list[str]]:
    """Preserve source reference targets and their selected paragraph ancestry."""
    references: list[DocxReference] = []
    issues: list[str] = []
    relation_map = {
        (relation.source_part, relation.relationship_id): relation for relation in relationships
    }
    for part_path, root in xml_roots.items():
        if region_for_part(part_path) is None:
            continue
        parent_paragraphs = paragraph_membership(root, part_path)
        for index, element in enumerate(iter_selected(root), start=1):
            local_name = tag_local_name(element.tag)
            reference_id = string_attribute(element, WORD_NAMESPACE, "id")
            relationship_id = string_attribute(
                element,
                OFFICE_RELATIONSHIP_NAMESPACE,
                "id",
            )
            kind: (
                Literal[
                    "footnote_reference",
                    "endnote_reference",
                    "comment_anchor",
                    "bookmark",
                    "hyperlink",
                ]
                | None
            ) = None
            target_part: str | None = None
            reference_name: str | None = None
            limitations: list[str] = []
            if local_name == "footnoteReference":
                kind = "footnote_reference"
                target_part = _find_relationship_target(relation_map, part_path, "footnotes")
            elif local_name == "endnoteReference":
                kind = "endnote_reference"
                target_part = _find_relationship_target(relation_map, part_path, "endnotes")
            elif local_name == "commentReference":
                continue
            elif local_name == "commentRangeStart":
                kind = "comment_anchor"
                target_part = _find_relationship_target(relation_map, part_path, "comments")
            elif local_name == "bookmarkStart":
                kind = "bookmark"
                reference_name = string_attribute(element, WORD_NAMESPACE, "name")
            elif local_name == "hyperlink":
                kind = "hyperlink"
                relation = relation_map.get((part_path, relationship_id or ""))
                if relation is not None and relation.target_mode == "External":
                    target_part = relation.target
                    limitations.append("External target was recorded but not contacted.")
                else:
                    target_part = relation.resolved_target if relation is not None else None
                    anchor = string_attribute(element, WORD_NAMESPACE, "anchor")
                    if relationship_id is None and anchor is not None:
                        reference_name = anchor
                        target_part = f"{part_path}#{anchor}"
            if kind is None:
                continue
            parse_status: Literal["parsed", "partial", "unsupported"] = "parsed"
            if (
                kind != "bookmark"
                and not (kind == "hyperlink" and target_part is not None)
                and target_part is None
            ):
                parse_status = "partial"
                limitations.append("Relationship target is missing or unresolved.")
                issues.append(f"reference-without-target:{part_path}#{index}")
            if kind in {"footnote_reference", "endnote_reference", "comment_anchor"}:
                limitations.append("Reference target content is not semantically interpreted.")
            references.append(
                DocxReference(
                    part_path=part_path,
                    node_locator=f"{part_path}#reference[{index}]",
                    kind=kind,
                    reference_id=reference_id,
                    reference_name=reference_name,
                    relationship_id=relationship_id,
                    target_part=target_part,
                    parse_status=parse_status,
                    limitations=tuple(limitations),
                    paragraph_locator=parent_paragraphs.get(id(element)),
                )
            )
    return tuple(references), issues


def _find_relationship_target(
    relation_map: dict[tuple[str, str], DocxRelationship], source_part: str, suffix: str
) -> str | None:
    for relation in relation_map.values():
        if relation.source_part == source_part and relation.relationship_type.casefold().endswith(
            f"/{suffix}"
        ):
            return relation.resolved_target
    return None
