"""Source observation indexing for DOCX queries."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import cast

from research_file_workbench.common.hashing import sha256_text
from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.docx.models import DocxReadResult
from research_file_workbench.docx.report import READER_VERSION


@dataclass(frozen=True, slots=True)
class Observation:
    """One source-bound observation addressable by the query boundary."""

    object_id: str
    object_type: str
    region: str | None
    region_scope: str
    content: JsonObject
    range_locator: str

    def metadata(self) -> JsonObject:
        return {
            "object_id": self.object_id,
            "object_type": self.object_type,
            "region": self.region,
            "region_scope": self.region_scope,
            "part_path": self.content["part_path"],
            "node_locator": self.content["node_locator"],
            "range_locator": self.range_locator,
        }


def digest_value(value: object) -> str:
    """Return the canonical identity digest used by query bindings and observations."""
    return sha256_text(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")))


def index_observations(result: DocxReadResult, report: JsonObject) -> list[Observation]:
    """Index report collections into unique source-bound observations."""
    from research_file_workbench.docx.query import _COLLECTIONS, OBJECT_TYPES, ReadQueryError

    text_regions = {item.node_locator: item.region for item in result.paragraph_scopes}
    observations: list[Observation] = []
    identities: set[str] = set()
    for object_type, collection in zip(OBJECT_TYPES, _COLLECTIONS, strict=True):
        for content in cast(list[JsonObject], report[collection]):
            locator = cast(str, content["node_locator"])
            field_identity = (
                [content["field_kind"], content["nested_level"], content["occurrence_index"]]
                if object_type == "field"
                else None
            )
            identity = digest_value(
                [result.source_sha256, READER_VERSION, object_type, locator, field_identity]
            )
            if identity in identities:
                raise ReadQueryError("Reader produced duplicate object identities")
            identities.add(identity)
            region, region_scope = _region(content, text_regions)
            range_locator = f"{locator}/field[{identity}]" if object_type == "field" else locator
            observations.append(
                Observation(
                    f"object-{identity}", object_type, region, region_scope, content, range_locator
                )
            )
    return observations


def _region(content: JsonObject, text_regions: dict[str, str]) -> tuple[str | None, str]:
    explicit = content.get("region")
    if isinstance(explicit, str):
        return explicit, "object"
    locator = cast(str, content["node_locator"])
    parent_locator = content.get("paragraph_locator")
    if isinstance(parent_locator, str) and parent_locator in text_regions:
        return text_regions[parent_locator], "paragraph"
    parents = [
        (parent, region)
        for parent, region in text_regions.items()
        if locator == parent or locator.startswith(parent + "/")
    ]
    if parents:
        return max(parents, key=lambda item: len(item[0]))[1], "paragraph"
    part = cast(str, content["part_path"]).casefold()
    parts = {
        "word/document.xml": "body",
        "word/footnotes.xml": "footnote",
        "word/endnotes.xml": "endnote",
    }
    if part in parts:
        return parts[part], "part"
    for region in ("header", "footer"):
        if part.startswith(f"word/{region}") and part.endswith(".xml"):
            return region, "part"
    return None, "unverified"
