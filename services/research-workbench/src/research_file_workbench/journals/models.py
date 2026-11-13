"""Source inputs and the bounded journal page-geometry vocabulary."""

import re
from dataclasses import dataclass
from typing import cast

from research_file_workbench.common.hashing import sha256_bytes, sha256_text
from research_file_workbench.common.json_io import JsonObject, encode_json_object

ANALYZER_VERSION = "journal-world-analyzer-1.5.0"
CHECKER_VERSION = "journal-geometry-checker-1.2.0"
WORLD_SCHEMA_VERSION = "journal-world-1.1.0"
COMPONENT_SCHEMA_VERSION = "journal-rule-component-1.0.0"
SOURCE_KINDS = {"template_docx", "guide_text", "guide_docx", "guide_pdf", "rule_component_json"}
PROPERTY_LABELS = {
    "page_width_twips": "Page width",
    "page_height_twips": "Page height",
    "top_margin_twips": "Top margin",
    "right_margin_twips": "Right margin",
    "bottom_margin_twips": "Bottom margin",
    "left_margin_twips": "Left margin",
    "columns": "Column count",
    "body_font_size_halfpoints": "Body type size",
    "body_line_spacing_twips": "Body line spacing",
    "body_font_family": "Body font family",
}
ASSURANCE_LIMITATION = (
    "Confirmed means an explicit requirement recognized in an operator-supplied guide for the "
    "declared context; publisher identity, completeness and currency are not authenticated."
)


class WorldAnalysisError(ValueError):
    """Raised when supplied inputs cannot satisfy the journal-world contract."""


@dataclass(frozen=True, slots=True)
class SourceInput:
    """One immutable captured source; names are labels and never executable paths."""

    name: str
    kind: str
    content: bytes

    def __post_init__(self) -> None:
        if not isinstance(self.name, str) or not self.name.strip() or "\x00" in self.name:
            raise WorldAnalysisError("Source name must be a nonblank label")
        if not isinstance(self.kind, str) or self.kind not in SOURCE_KINDS:
            raise WorldAnalysisError(f"Unsupported journal source kind: {self.kind}")
        if not isinstance(self.content, bytes):
            raise WorldAnalysisError("Source content must be captured bytes")

    @property
    def source_id(self) -> str:
        """Identify captured bytes independently of their operator-supplied name."""
        return f"source-{sha256_bytes(self.content)}"


def record_digest(record: JsonObject) -> str:
    """Hash canonical JSON using the existing shared JSON and digest primitives."""
    return sha256_text(encode_json_object(record))


def world_manifest(world: JsonObject) -> JsonObject:
    """Return identity-bearing fields, excluding only defined storage metadata."""
    return {
        key: value
        for key, value in world.items()
        if key not in {"version_id", "version_ordinal", "created_at"}
    }


def world_version_id(world: JsonObject) -> str:
    """Identify source analysis and explicit decisions independently of storage timestamps."""
    return f"world-{record_digest(world_manifest(world))}"


def validate_world_identity(world: JsonObject) -> None:
    """Validate retained shape and content identity without requiring today's methods."""
    if world.get("version_id") != world_version_id(world):
        raise WorldAnalysisError("Journal world content does not match its version")
    required = {
        "schema_version",
        "journal_id",
        "journal_name",
        "scope",
        "analyzer_version",
        "reader_version",
        "sources",
        "rules",
        "coverage_gaps",
        "limitations",
        "version_id",
    }
    require_keys(world, required, {"manual_decisions", "version_ordinal", "created_at"})
    if world["schema_version"] != WORLD_SCHEMA_VERSION:
        raise WorldAnalysisError("Unsupported journal world schema")
    for key in ("journal_name", "analyzer_version", "reader_version"):
        require_text(world[key], key)
    require_identifier(world["journal_id"], "journal_id")
    validate_scope(world["scope"])
    require_strings(world["limitations"], "world limitations")
    sources = require_objects(world["sources"], "world sources", nonempty=True)
    source_ids: set[str] = set()
    identities: set[tuple[str, str, str]] = set()
    for source in sources:
        require_keys(source, {"source_id", "sha256", "name", "kind", "status", "limitations"})
        digest = require_text(source["sha256"], "source digest")
        if (
            re.fullmatch(r"[0-9a-f]{64}", digest) is None
            or source["source_id"] != f"source-{digest}"
        ):
            raise WorldAnalysisError("Source identity and digest disagree")
        name = require_text(source["name"], "source name")
        kind = require_text(source["kind"], "source kind")
        status = require_text(source["status"], "source analysis status")
        if kind not in SOURCE_KINDS or status not in {
            "analyzed",
            "analyzed_with_gaps",
            "unsupported",
        }:
            raise WorldAnalysisError("Source kind or analysis status is invalid")
        identity = (digest, kind, name)
        if identity in identities:
            raise WorldAnalysisError("World contains duplicate source descriptors")
        identities.add(identity)
        source_ids.add(source["source_id"])
        require_strings(source["limitations"], "source limitations")
    rules = require_objects(world["rules"], "world rules")
    rule_ids: set[str] = set()
    for rule in rules:
        _validate_rule(rule, cast(str, world["journal_id"]), source_ids)
        rule_id = cast(str, rule["rule_id"])
        if rule_id in rule_ids:
            raise WorldAnalysisError("World contains duplicate rule identities")
        rule_ids.add(rule_id)
    for gap in require_objects(world["coverage_gaps"], "coverage gaps"):
        require_keys(gap, {"code", "source_id", "property", "locator", "message"})
        require_text(gap["code"], "gap code")
        require_text(gap["message"], "gap message")
        if (
            gap["source_id"] is not None
            and require_text(gap["source_id"], "gap source") not in source_ids
        ):
            raise WorldAnalysisError("Coverage gap names an absent source")
        if (
            gap["property"] is not None
            and require_text(gap["property"], "gap property") not in PROPERTY_LABELS
        ):
            raise WorldAnalysisError("Coverage gap names an unsupported property")
        if gap["locator"] is not None:
            require_text(gap["locator"], "gap locator")
    for decision in require_objects(world.get("manual_decisions", []), "manual decisions"):
        require_keys(decision, {"base_version_id", "rule_id", "expected", "reason", "actor_id"})
        if require_text(decision["rule_id"], "decision rule ID") not in rule_ids:
            raise WorldAnalysisError("Manual decision names an absent rule")
        _validate_decision(decision)


def validate_world_for_execution(world: JsonObject) -> None:
    """Require current analysis semantics and consistent local confirmation evidence."""
    validate_world_identity(world)
    if world["analyzer_version"] != ANALYZER_VERSION:
        raise WorldAnalysisError("Journal analyzer changed; reanalyze sources before a new check")
    from research_file_workbench.docx.report import READER_VERSION
    from research_file_workbench.journals.guide_rules import recognize_guide

    if world["reader_version"] != READER_VERSION:
        raise WorldAnalysisError("DOCX reader changed; reanalyze sources before a new check")
    sources = require_objects(world["sources"], "world sources")
    guide_ids = {
        source["source_id"]
        for source in sources
        if source["kind"] in {"guide_text", "guide_docx", "guide_pdf"}
    }
    decisions = require_objects(world.get("manual_decisions", []), "manual decisions")
    for rule in require_objects(world["rules"], "world rules"):
        method = rule["confirmation_method"]
        basis = require_text(rule["basis_status"], "rule basis status")
        if basis == "confirmed" and method == "explicit_supplied_guide_pattern":
            matching = False
            for evidence in require_objects(rule["evidence"], "rule evidence"):
                if evidence["source_id"] not in guide_ids:
                    continue
                extracted, _ = recognize_guide(
                    cast(str, evidence["source_id"]),
                    [(cast(str, evidence["locator"]), cast(str, evidence["quote"]))],
                )
                matching |= any(
                    item["property"] == rule["property"] and item["expected"] == rule["expected"]
                    for item in extracted
                )
            if not matching:
                raise WorldAnalysisError("Confirmed rule has no matching supplied guide evidence")
        elif basis == "confirmed" and method == "human_decision":
            resolution = require_object(rule.get("resolution"), "rule resolution")
            selected = [item for item in decisions if item["rule_id"] == rule["rule_id"]]
            if (
                not selected
                or any(resolution.get(key) != value for key, value in selected[-1].items())
                or rule["expected"] != selected[-1]["expected"]
            ):
                raise WorldAnalysisError("Human-confirmed rule has no matching latest decision")
        elif (basis, method) not in {
            ("candidate", "candidate_observation"),
            ("conflict", "conflicting_sources"),
        }:
            raise WorldAnalysisError("Rule basis and confirmation method disagree")


def _validate_rule(rule: JsonObject, journal_id: str, source_ids: set[str]) -> None:
    require_keys(
        rule,
        {
            "rule_id",
            "property",
            "label",
            "expected",
            "unit",
            "basis_status",
            "confirmation_method",
            "scope",
            "evidence",
            "limitations",
        },
        {"resolution"},
    )
    property_name = require_text(rule["property"], "rule property")
    if property_name not in PROPERTY_LABELS or rule["unit"] != property_unit(property_name):
        raise WorldAnalysisError("Rule property or unit is unsupported")
    scope = validate_scope(rule["scope"], rule=True)
    identity: JsonObject = {"journal_id": journal_id, "scope": scope, "property": property_name}
    if rule["rule_id"] != f"rule-{record_digest(identity)}":
        raise WorldAnalysisError("Rule ID does not identify its property and scope")
    require_text(rule["label"], "rule label")
    require_text(rule["confirmation_method"], "confirmation method")
    basis = require_text(rule["basis_status"], "rule basis status")
    if basis not in {"candidate", "confirmed", "conflict"}:
        raise WorldAnalysisError("Rule has an invalid basis status")
    if basis == "conflict":
        if rule["expected"] is not None:
            raise WorldAnalysisError("Conflict rule cannot choose an expected value")
    else:
        require_expected(property_name, rule["expected"])
    require_strings(rule["limitations"], "rule limitations")
    for evidence in require_objects(rule["evidence"], "rule evidence", nonempty=True):
        require_keys(evidence, {"source_id", "locator", "quote"})
        if require_text(evidence["source_id"], "evidence source ID") not in source_ids:
            raise WorldAnalysisError("Rule evidence names an absent source")
        require_text(evidence["locator"], "evidence locator")
        require_text(evidence["quote"], "evidence quote")
    if "resolution" in rule:
        resolution = require_object(rule["resolution"], "rule resolution")
        require_keys(
            resolution,
            {
                "base_version_id",
                "rule_id",
                "expected",
                "reason",
                "actor_id",
                "previous_basis_status",
                "previous_expected",
            },
        )
        _validate_decision(resolution)
        require_expected(property_name, resolution["expected"])
        previous_basis = require_text(resolution["previous_basis_status"], "previous rule basis")
        if resolution["rule_id"] != rule["rule_id"] or previous_basis not in {
            "candidate",
            "confirmed",
            "conflict",
        }:
            raise WorldAnalysisError("Rule resolution has an invalid source rule or basis")
        if previous_basis == "conflict":
            if resolution["previous_expected"] is not None:
                raise WorldAnalysisError("Prior conflicting rule cannot have a chosen value")
        else:
            require_expected(property_name, resolution["previous_expected"])


def _validate_decision(decision: JsonObject) -> None:
    for key in ("base_version_id", "rule_id", "reason", "actor_id"):
        require_text(decision[key], key)
    if re.fullmatch(r"world-[0-9a-f]{64}", cast(str, decision["base_version_id"])) is None:
        raise WorldAnalysisError("Manual decision requires an exact prior world version")
    if type(decision["expected"]) is not int and not isinstance(decision["expected"], str):
        raise WorldAnalysisError("Manual decision expected value must be an integer or font name")


def require_object(value: object, label: str) -> JsonObject:
    """Converge an external structured record at the journal boundary."""
    if not isinstance(value, dict):
        raise WorldAnalysisError(f"{label} must be an object")
    return cast(JsonObject, value)


def require_objects(value: object, label: str, *, nonempty: bool = False) -> list[JsonObject]:
    """Converge a structured record collection without ignoring invalid members."""
    if not isinstance(value, list) or (nonempty and not value):
        raise WorldAnalysisError(f"{label} must be an object list")
    return [require_object(item, label) for item in value]


def require_text(value: object, label: str) -> str:
    """Validate a nonempty label without treating it as a filesystem path."""
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        raise WorldAnalysisError(f"{label} must be nonblank text without null characters")
    return value


def require_identifier(value: object, label: str) -> str:
    """Validate the stable kebab-case journal or component identifier vocabulary."""
    text = require_text(value, label)
    if re.fullmatch(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*", text) is None:
        raise WorldAnalysisError(f"{label} must be a kebab-case identifier")
    return text


def require_strings(value: object, label: str) -> list[str]:
    """Validate an explicit text array, preserving intentional empty arrays."""
    if not isinstance(value, list):
        raise WorldAnalysisError(f"{label} must be a string list")
    return [require_text(item, label) for item in value]


def require_keys(record: JsonObject, required: set[str], optional: set[str] | None = None) -> None:
    """Reject missing and unknown declarative fields at the boundary."""
    if not required.issubset(record) or set(record) - required - (optional or set()):
        raise WorldAnalysisError("Record fields do not match the declared journal schema")


def validate_scope(value: object, *, rule: bool = False) -> JsonObject:
    """Validate world or rule scope without inferring a manuscript context."""
    scope = require_object(value, "scope")
    keys = {"article_type", "stage", "language"}
    if rule:
        keys.add("section_scope")
    require_keys(scope, keys)
    for key in keys:
        require_text(scope[key], f"scope {key}")
    if rule and scope["section_scope"] != "all_sections":
        raise WorldAnalysisError("Only explicit all_sections rule scope is supported")
    return scope


def property_unit(property_name: str) -> str:
    """Return the stored unit for one supported page-geometry property."""
    if property_name == "body_font_family":
        return "font_family"
    if property_name == "columns":
        return "count"
    if property_name == "body_font_size_halfpoints":
        return "half_points"
    if property_name == "body_line_spacing_twips":
        return "spacing_twips"
    return "twips"


def require_expected(property_name: str, expected: object) -> int | str:
    """Require a value in the supported property's declared domain."""
    if property_name not in PROPERTY_LABELS:
        raise WorldAnalysisError(f"Unsupported journal property: {property_name}")
    if property_name == "body_font_family":
        family = require_text(expected, "font family")
        if len(family) > 512 or family != family.strip() or any(ord(c) < 32 for c in family):
            raise WorldAnalysisError(
                "Font family must be a trimmed name without control characters"
            )
        return family
    minimum = 0 if property_name.endswith("margin_twips") else 1
    if type(expected) is not int or expected < minimum:
        raise WorldAnalysisError(f"Invalid expected value for {property_name}")
    return expected


def coverage_gap(
    code: str,
    message: str,
    *,
    source_id: str | None = None,
    property_name: str | None = None,
    locator: str | None = None,
) -> JsonObject:
    """Describe an explicitly unsupported or unavailable part of analysis coverage."""
    return {
        "code": code,
        "source_id": source_id,
        "property": property_name,
        "locator": locator,
        "message": message,
    }
