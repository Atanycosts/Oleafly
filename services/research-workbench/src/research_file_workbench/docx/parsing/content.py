"""Paragraph scope indexing and compatibility exports for DOCX content parsing."""

from __future__ import annotations

from xml.etree import ElementTree

from research_file_workbench.docx.models import DocxParagraphScope
from research_file_workbench.docx.parsing.references import read_references
from research_file_workbench.docx.parsing.tables import read_tables
from research_file_workbench.docx.parsing.text import read_text_blocks
from research_file_workbench.docx.xml_support import (
    WORD_NAMESPACE,
    iter_selected,
    paragraphs,
    region_for_part,
)

__all__ = [
    "read_paragraph_scopes",
    "read_references",
    "read_tables",
    "read_text_blocks",
]


def read_paragraph_scopes(
    xml_roots: dict[str, ElementTree.Element],
) -> tuple[DocxParagraphScope, ...]:
    """Index all selected paragraphs and distinguish direct body numbering from nested text."""
    scopes: list[DocxParagraphScope] = []
    for part_path, root in xml_roots.items():
        region = region_for_part(part_path)
        if region is None:
            continue
        body = root.find(f"{{{WORD_NAMESPACE}}}body") if region == "body" else None
        direct_body_indices = {
            id(paragraph): index
            for index, paragraph in enumerate(
                (child for child in body if child.tag == f"{{{WORD_NAMESPACE}}}p")
                if body is not None
                else (),
                start=1,
            )
        }
        body_container_indices = {
            id(element): body_index
            for paragraph in (body if body is not None else ())
            if (body_index := direct_body_indices.get(id(paragraph))) is not None
            for element in iter_selected(paragraph)
        }
        region_indices: dict[str, int] = {}
        for index, (paragraph, in_textbox) in enumerate(paragraphs(root), start=1):
            paragraph_region = "textbox" if in_textbox else region
            region_index = region_indices.get(paragraph_region, 0) + 1
            region_indices[paragraph_region] = region_index
            scopes.append(
                DocxParagraphScope(
                    node_locator=f"{part_path}#paragraph[{index}]",
                    part_path=part_path,
                    region=paragraph_region,
                    region_index=region_index,
                    body_paragraph_index=direct_body_indices.get(id(paragraph)),
                    body_container_index=body_container_indices.get(id(paragraph)),
                )
            )
    return tuple(scopes)
