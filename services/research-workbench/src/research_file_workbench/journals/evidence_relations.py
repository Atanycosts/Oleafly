"""Rank lexical associations between retained journal rules and source fragments."""

import math
import re
from collections import Counter
from itertools import combinations
from typing import cast

from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.journals.models import record_digest, require_objects

RELATION_METHOD_VERSION = "journal-lexical-relations-1.0.0"
RELATED_FRAGMENT_LIMIT = 6
_WORDS = re.compile(r"[a-z0-9]+(?:[._-][a-z0-9]+)*|[\u3400-\u9fff]+", re.IGNORECASE)
_STOP_WORDS = frozenset({"a", "an", "and", "are", "be", "for", "in", "is", "of", "or", "the", "to"})


def relations(
    rules: list[JsonObject], fragments: list[JsonObject], links: list[JsonObject]
) -> list[JsonObject]:
    """Build bounded lexical relations without changing authoritative rule evidence."""
    rule_terms = {
        cast(str, rule["rule_id"]): _terms(
            " ".join(
                cast(str, evidence["quote"])
                for evidence in require_objects(rule["evidence"], "rule evidence")
            )
        )
        for rule in rules
    }
    result: list[JsonObject] = []
    for left, right in combinations(sorted(rule_terms), 2):
        score, shared = _similarity(rule_terms[left], rule_terms[right])
        if score:
            result.append(_relation("related_rule", left, right, score, shared))

    exact: dict[str, set[str]] = {rule_id: set() for rule_id in rule_terms}
    for link in links:
        exact[cast(str, link["rule_id"])].update(cast(list[str], link["fragment_ids"]))
    fragments_by_id = {cast(str, item["fragment_id"]): item for item in fragments}
    candidates = [item for item in fragments if item["kind"] in {"sentence", "component_rule"}]
    vectors = {
        cast(str, item["fragment_id"]): _terms(cast(str, item["text"])) for item in candidates
    }
    for rule_id, vector in rule_terms.items():
        ranked: list[tuple[float, str, list[str]]] = []
        for fragment in candidates:
            fragment_id = cast(str, fragment["fragment_id"])
            parent = fragment["parent_fragment_id"]
            if fragment_id in exact[rule_id] or parent in exact[rule_id]:
                continue
            score, shared = _similarity(vector, vectors[fragment_id])
            if score:
                ranked.append((score, fragment_id, shared))
        ranked.sort(key=lambda item: (-item[0], item[1]))
        for score, fragment_id, shared in ranked[:RELATED_FRAGMENT_LIMIT]:
            fragment = fragments_by_id[fragment_id]
            kind = "related_source"
            if fragment["kind"] == "component_rule" and score == 1.0:
                kind = "possible_duplicate"
            result.append(_relation(kind, rule_id, fragment_id, score, shared))

    declarations: dict[str, list[str]] = {}
    for fragment in candidates:
        if fragment["kind"] == "component_rule":
            content = cast(JsonObject, fragment["content"])
            signature = record_digest(
                {key: content[key] for key in ("property", "expected", "unit")}
            )
            declarations.setdefault(signature, []).append(cast(str, fragment["fragment_id"]))
    for same_value in declarations.values():
        ordered = sorted(same_value)
        for index, fragment_id in enumerate(ordered):
            for other_id in ordered[index + 1 : index + 1 + RELATED_FRAGMENT_LIMIT]:
                result.append(
                    _relation(
                        "possible_duplicate",
                        fragment_id,
                        other_id,
                        1.0,
                        sorted(vectors[fragment_id]),
                    )
                )
    return result


def _terms(text: str) -> Counter[str]:
    terms: Counter[str] = Counter()
    for match in _WORDS.finditer(text.casefold()):
        word = match.group()
        if "\u3400" <= word[0] <= "\u9fff" and len(word) > 1:
            terms.update(word[index : index + 2] for index in range(len(word) - 1))
        elif word not in _STOP_WORDS:
            terms[word] += 1
    return terms


def _similarity(left: Counter[str], right: Counter[str]) -> tuple[float, list[str]]:
    shared = sorted(left.keys() & right.keys())
    if not shared:
        return 0.0, []
    numerator = sum(left[term] * right[term] for term in shared)
    denominator = math.sqrt(sum(count * count for count in left.values())) * math.sqrt(
        sum(count * count for count in right.values())
    )
    return min(1.0, numerator / denominator), shared


def _relation(
    kind: str, from_id: str, to_id: str, score: float, shared_terms: list[str]
) -> JsonObject:
    return {
        "kind": kind,
        "from_id": from_id,
        "to_id": to_id,
        "score": round(score, 6),
        "score_kind": "lexical_cosine",
        "shared_terms": shared_terms,
    }
