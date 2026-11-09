"""Serialization of DOCX style observations."""

from __future__ import annotations

from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.docx.models import DocxStyle


def style_to_json(item: DocxStyle) -> JsonObject:
    """Project one style declaration and its known computed values."""
    computed_sources = [
        {"field": field_name, "source": source} for field_name, source in item.computed_sources
    ]
    return {
        "style_id": item.style_id,
        "style_type": item.style_type,
        "based_on": item.based_on,
        "source_chain": list(item.source_chain),
        "declared_values": {
            "style_id": item.style_id,
            "style_type": item.style_type,
            "based_on": item.based_on,
        },
        "computed_values": {
            "font_ascii": item.font_ascii,
            "font_size_pt": item.font_size_pt,
            "italic": item.italic,
            "space_after_twips": item.space_after_twips,
            "num_id": item.num_id,
        },
        "font_ascii": item.font_ascii,
        "font_size_pt": item.font_size_pt,
        "italic": item.italic,
        "space_after_twips": item.space_after_twips,
        "num_id": item.num_id,
        "computed_sources": computed_sources,
        "unconfirmed_fields": list(item.unconfirmed_fields),
        "parse_status": "partial" if item.unconfirmed_fields else "parsed",
        "limitations": [
            "Style resolution is limited to the declared inheritance chain and available fields."
        ],
    }
