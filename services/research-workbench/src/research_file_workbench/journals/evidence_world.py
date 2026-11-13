"""Assemble source fragments and ranked relations into a review envelope."""

from collections.abc import Mapping
from typing import cast

from research_file_workbench.common.hashing import sha256_bytes
from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.docx.report import READER_VERSION
from research_file_workbench.journals.evidence_fragments import (
    EVIDENCE_METHOD_VERSION,
    source_fragments,
)
from research_file_workbench.journals.evidence_relations import (
    RELATION_METHOD_VERSION,
    relations,
)
from research_file_workbench.journals.models import (
    WorldAnalysisError,
    require_object,
    require_objects,
    validate_world_identity,
)
from research_file_workbench.journals.pdf_analysis import PDF_SOURCE_VERSION


def build_world_evidence(world: JsonObject, sources: Mapping[str, bytes]) -> JsonObject:
    """Derive review fragments from exact retained bytes without changing rule authority.

    Source hashes are checked before extraction. Historical rule quotes stay unchanged;
    exact locators link them to fragments. Text similarity only ranks review suggestions.
    """
    validate_world_identity(world)
    descriptors = require_objects(world["sources"], "world sources", nonempty=True)
    if set(sources) != {source["source_id"] for source in descriptors}:
        raise WorldAnalysisError("World evidence requires the exact retained source set")
    for source in descriptors:
        payload = sources[cast(str, source["source_id"])]
        if not isinstance(payload, bytes) or sha256_bytes(payload) != source["sha256"]:
            raise WorldAnalysisError("World evidence source bytes do not match their identity")

    # Note on the two status axes: source records carry the world-analysis `status` for rule
    # recognition (gaps from unparsed blocks make it "analyzed_with_gaps") alongside the
    # review-only `extraction_status` for fragment extraction; both now cover PDF sources.
    fragments: dict[str, JsonObject] = {}
    source_records: list[JsonObject] = []
    extracted: dict[tuple[str, str], tuple[list[JsonObject], list[str]]] = {}
    for source in descriptors:
        source_id, kind = cast(str, source["source_id"]), cast(str, source["kind"])
        key = (source_id, kind)
        if key not in extracted:
            if kind == "template_docx" and "template" in world:
                template = require_object(world["template"], "selected template")
                extracted[key] = source_fragments(
                    source_id,
                    "docx_format_snapshot",
                    sources[str(template["snapshot_source_id"])],
                )
            elif kind == "docx_format_snapshot":
                # The snapshot supplies core facts for the normalized source above.
                extracted[key] = ([], [])
            else:
                extracted[key] = source_fragments(source_id, kind, sources[source_id])
        source_items, issues = extracted[key]
        for fragment in source_items:
            fragments[cast(str, fragment["fragment_id"])] = fragment
        source_records.append(
            {
                **source,
                "fragment_count": len(source_items),
                "extraction_status": "extracted_with_gaps" if issues else "extracted",
                "reader_issues": issues,
            }
        )

    ordered = list(fragments.values())
    # A captured file can serve several source roles while sharing one content ID.
    # Keep each descriptor, and count the unique fragments visible for its source.
    for record in source_records:
        record["fragment_count"] = sum(
            fragment["source_id"] == record["source_id"] for fragment in ordered
        )
    links = _rule_links(world, ordered)
    rules = require_objects(world["rules"], "world rules")
    return {
        "method_version": EVIDENCE_METHOD_VERSION,
        "relation_method_version": RELATION_METHOD_VERSION,
        "reader_version": READER_VERSION,
        "pdf_source_version": PDF_SOURCE_VERSION,
        "offset_unit": "unicode_code_points",
        "world_version_id": world["version_id"],
        "sources": source_records,
        "fragments": ordered,
        "rule_links": links,
        "relations": relations(rules, ordered, links),
        "limitations": [
            "Sentence boundaries follow punctuation and do not interpret requirement scope.",
            "Similarity is lexical cosine for review ordering, not probability or compliance.",
            "Associations never merge fragments or change retained rule basis and verdicts.",
            "DOCX text is the reader's source projection, not a rendered-page transcription.",
            "PDF sources yield page- and region-bound fragments; only blocks matching the "
            "narrow explicit requirement grammar are confirmed as rules.",
        ],
    }


def _rule_links(world: JsonObject, fragments: list[JsonObject]) -> list[JsonObject]:
    by_locator: dict[tuple[str, str], list[str]] = {}
    for fragment in fragments:
        key = (cast(str, fragment["source_id"]), cast(str, fragment["locator"]))
        by_locator.setdefault(key, []).append(cast(str, fragment["fragment_id"]))
    links: list[JsonObject] = []
    for rule in require_objects(world["rules"], "world rules"):
        for index, evidence in enumerate(require_objects(rule["evidence"], "rule evidence")):
            key = (cast(str, evidence["source_id"]), cast(str, evidence["locator"]))
            linked = by_locator.get(key, [])
            links.append(
                {
                    "rule_id": rule["rule_id"],
                    "evidence_index": index,
                    **evidence,
                    "fragment_ids": linked,
                    "link_status": "located" if linked else "unavailable",
                }
            )
    return links
