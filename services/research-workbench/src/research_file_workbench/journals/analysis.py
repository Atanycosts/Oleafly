"""Deterministic analysis of supplied journal templates, guides and rule components."""

from collections.abc import Sequence
from typing import cast

from research_file_workbench.common.hashing import sha256_bytes
from research_file_workbench.common.json_io import JsonObject, encode_json_object
from research_file_workbench.docx.reader import read_docx_bytes
from research_file_workbench.docx.report import READER_VERSION
from research_file_workbench.journals.components import analyze_component
from research_file_workbench.journals.guide_rules import recognize_guide
from research_file_workbench.journals.models import (
    ANALYZER_VERSION,
    ASSURANCE_LIMITATION,
    PROPERTY_LABELS,
    WORLD_SCHEMA_VERSION,
    SourceInput,
    WorldAnalysisError,
    coverage_gap,
    property_unit,
    record_digest,
    require_expected,
    require_identifier,
    require_objects,
    require_text,
    validate_world_for_execution,
    validate_world_identity,
    world_manifest,
    world_version_id,
)
from research_file_workbench.journals.pdf_analysis import analyze_pdf_bytes


def analyze_world(
    journal_id: str,
    journal_name: str,
    sources: Sequence[SourceInput],
    *,
    article_type: str = "research_article",
    stage: str = "initial_submission",
    language: str = "en",
) -> JsonObject:
    """Analyze immutable operator-supplied sources without opening files or changing manuscripts."""
    require_identifier(journal_id, "journal_id")
    for name, value in (
        ("journal_name", journal_name),
        ("article_type", article_type),
        ("stage", stage),
        ("language", language),
    ):
        require_text(value, name)
    if not sources or any(not isinstance(source, SourceInput) for source in sources):
        raise WorldAnalysisError("Analysis requires at least one captured SourceInput")
    scope: JsonObject = {"article_type": article_type, "stage": stage, "language": language}
    source_records: list[JsonObject] = []
    observations: list[JsonObject] = []
    gaps: list[JsonObject] = []
    seen: set[tuple[str, str, str]] = set()
    for source in sorted(sources, key=lambda item: (item.source_id, item.kind, item.name)):
        identity = (source.source_id, source.kind, source.name)
        if identity in seen:
            continue
        seen.add(identity)
        extracted, source_gaps = _source_rules(source, journal_id, scope)
        observations.extend(extracted)
        gaps.extend(source_gaps)
        source_records.append(
            {
                "source_id": source.source_id,
                "sha256": sha256_bytes(source.content),
                "name": source.name,
                "kind": source.kind,
                "status": "analyzed_with_gaps" if source_gaps else "analyzed",
                "limitations": [
                    "Captured bytes do not authenticate the supplied source or its currency."
                ],
            }
        )
    rules = _aggregate_rules(journal_id, scope, observations)
    present = {rule["property"] for rule in rules}
    for property_name in PROPERTY_LABELS:
        if property_name not in present:
            gaps.append(
                coverage_gap(
                    "property_not_established",
                    "No applicable expectation was established for this property.",
                    property_name=property_name,
                )
            )
    world: JsonObject = {
        "schema_version": WORLD_SCHEMA_VERSION,
        "journal_id": journal_id,
        "journal_name": journal_name,
        "scope": scope,
        "analyzer_version": ANALYZER_VERSION,
        "reader_version": READER_VERSION,
        "sources": source_records,
        "rules": rules,
        "coverage_gaps": sorted(gaps, key=encode_json_object),
        "limitations": [
            ASSURANCE_LIMITATION,
            "Coverage is limited to declared page geometry and body font requirements; "
            "font availability and full-journal compliance are not established by analysis.",
        ],
    }
    world["version_id"] = world_version_id(world)
    validate_world_for_execution(world)
    return world


def _source_rules(
    source: SourceInput, journal_id: str, scope: JsonObject
) -> tuple[list[JsonObject], list[JsonObject]]:
    if source.kind == "guide_pdf":
        blocks, issues = analyze_pdf_bytes(source.content, source.source_id)
        gaps = [
            coverage_gap("pdf_reader_issue", issue, source_id=source.source_id) for issue in issues
        ]
        pdf_lines = [
            (f"page:{block.page_number}/block:{block.block_number}", block.text) for block in blocks
        ]
        # A PDF without any text blocks has its own pdf_reader_issue gap; running the
        # recognizer on an empty list would add a misleading empty_guide gap.
        extracted, text_gaps = (
            recognize_guide(source.source_id, pdf_lines) if pdf_lines else ([], [])
        )
        return extracted, [*gaps, *text_gaps]
    if source.kind == "rule_component_json":
        return analyze_component(source, journal_id, scope)
    if source.kind == "guide_text":
        try:
            text = source.content.decode("utf-8-sig")
        except UnicodeError as exc:
            raise WorldAnalysisError("Text guidance must be valid UTF-8") from exc
        return recognize_guide(
            source.source_id,
            [(f"line:{index}", line) for index, line in enumerate(text.splitlines(), start=1)],
        )
    result = read_docx_bytes(source.content, source_label=source.source_id)
    gaps = [
        coverage_gap("docx_reader_issue", issue, source_id=source.source_id)
        for issue in result.issues
    ]
    if source.kind == "guide_docx":
        lines: list[tuple[str, str]] = []
        for block in result.text_blocks:
            if (
                block.hidden
                or block.revision_state != "none"
                or block.contains_field_code
                or block.contains_omml
            ):
                gaps.append(
                    coverage_gap(
                        "ambiguous_guide_paragraph",
                        "Hidden, revised, field or math text is not confirmed as guidance.",
                        source_id=source.source_id,
                        locator=block.node_locator,
                    )
                )
            else:
                lines.append((block.node_locator, block.text))
        extracted, text_gaps = recognize_guide(
            source.source_id,
            lines,
            context_lines=[(block.node_locator, block.text) for block in result.text_blocks],
        )
        return extracted, [*gaps, *text_gaps]
    observations: list[JsonObject] = []
    if not result.sections:
        gaps.append(
            coverage_gap(
                "template_sections_missing",
                "Template has no declared section geometry.",
                source_id=source.source_id,
            )
        )
    for property_name in PROPERTY_LABELS:
        if property_name == "body_font_family":
            continue
        values = [getattr(section, property_name) for section in result.sections]
        if not values or any(value is None for value in values):
            gaps.append(
                coverage_gap(
                    "template_property_missing",
                    "At least one template section has no explicit value; inherited layout is "
                    "not inferred.",
                    source_id=source.source_id,
                    property_name=property_name,
                )
            )
            continue
        if len(set(values)) != 1:
            gaps.append(
                coverage_gap(
                    "mixed_template_sections",
                    "Template sections disagree; source section numbers do not establish "
                    "manuscript section correspondence.",
                    source_id=source.source_id,
                    property_name=property_name,
                )
            )
            continue
        try:
            require_expected(property_name, values[0])
        except WorldAnalysisError:
            gaps.append(
                coverage_gap(
                    "unsupported_template_geometry",
                    "The declared template value is outside the supported geometry rule domain.",
                    source_id=source.source_id,
                    property_name=property_name,
                )
            )
            continue
        observations.append(
            {
                "property": property_name,
                "expected": values[0],
                "basis_status": "candidate",
                "confirmation_method": "template_wide_observation",
                "evidence": [
                    {
                        "source_id": source.source_id,
                        "locator": section.node_locator,
                        "quote": f"{property_name}={values[0]} (declared OOXML)",
                    }
                    for section in result.sections
                ],
                "limitations": [
                    "Template geometry is an observation, not a normative journal requirement."
                ],
            }
        )
    return observations, gaps


def _aggregate_rules(
    journal_id: str, scope: JsonObject, observations: list[JsonObject]
) -> list[JsonObject]:
    rules: list[JsonObject] = []
    for property_name, label in PROPERTY_LABELS.items():
        relevant = [item for item in observations if item["property"] == property_name]
        if not relevant:
            continue
        values = {cast(int | str, item["expected"]) for item in relevant}
        confirmed = [item for item in relevant if item["basis_status"] == "confirmed"]
        state = "conflict" if len(values) > 1 else "confirmed" if confirmed else "candidate"
        evidence = {
            encode_json_object(item): item
            for observation in relevant
            for item in cast(list[JsonObject], observation["evidence"])
        }
        limitations = {
            limitation
            for observation in relevant
            for limitation in cast(list[str], observation["limitations"])
        }
        if state == "confirmed":
            limitations.add(ASSURANCE_LIMITATION)
        if state == "conflict":
            limitations.add(
                "Supplied source expectations disagree; no value is selected as authoritative."
            )
        rule_scope = {**scope, "section_scope": "all_sections"}
        identity: JsonObject = {
            "journal_id": journal_id,
            "scope": rule_scope,
            "property": property_name,
        }
        rules.append(
            {
                "rule_id": f"rule-{record_digest(identity)}",
                "property": property_name,
                "label": label,
                "expected": next(iter(values)) if len(values) == 1 else None,
                "unit": property_unit(property_name),
                "basis_status": state,
                "confirmation_method": "conflicting_sources"
                if state == "conflict"
                else "explicit_supplied_guide_pattern"
                if confirmed
                else "candidate_observation",
                "scope": rule_scope,
                "evidence": [evidence[key] for key in sorted(evidence)],
                "limitations": sorted(limitations),
            }
        )
    return rules


def validate_world_sources(world: JsonObject, sources: dict[str, bytes]) -> None:
    """Rebuild new world analysis and decisions from captured bytes before publication.

    Historical retrieval uses identity validation only. Rebuilding here prevents a manifest's
    self-declared hash or confirmation labels from substituting for its supplied source evidence.
    """
    validate_world_identity(world)
    descriptors = require_objects(world["sources"], "world sources", nonempty=True)
    if set(sources) != {item["source_id"] for item in descriptors}:
        raise WorldAnalysisError("World source bytes and descriptors must match exactly")
    captured: list[SourceInput] = []
    for item in descriptors:
        source_id = cast(str, item["source_id"])
        payload = sources[source_id]
        if not isinstance(payload, bytes) or sha256_bytes(payload) != item["sha256"]:
            raise WorldAnalysisError("World source bytes do not match their version")
        captured.append(SourceInput(cast(str, item["name"]), cast(str, item["kind"]), payload))
    scope = cast(JsonObject, world["scope"])
    rebuilt = analyze_world(
        cast(str, world["journal_id"]),
        cast(str, world["journal_name"]),
        captured,
        article_type=cast(str, scope["article_type"]),
        stage=cast(str, scope["stage"]),
        language=cast(str, scope["language"]),
    )
    from research_file_workbench.journals.revisions import revise_rule

    for decision in require_objects(world.get("manual_decisions", []), "manual decisions"):
        if decision["base_version_id"] != rebuilt["version_id"]:
            raise WorldAnalysisError(
                "Manual decision history does not continue the captured analysis"
            )
        rebuilt = revise_rule(
            rebuilt,
            cast(str, decision["rule_id"]),
            cast(int | str, decision["expected"]),
            cast(str, decision["reason"]),
            cast(str, decision["actor_id"]),
        )
    if world_manifest(rebuilt) != world_manifest(world):
        raise WorldAnalysisError("World rules or evidence differ from captured source analysis")
