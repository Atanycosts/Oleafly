"""Public source-evidence API for retained journal worlds.

The implementation is split by ownership: ``evidence_fragments`` extracts source
observations, ``evidence_relations`` ranks lexical associations, and
``evidence_world`` assembles the stable review envelope.
"""

from research_file_workbench.journals.evidence_fragments import EVIDENCE_METHOD_VERSION
from research_file_workbench.journals.evidence_relations import (
    RELATED_FRAGMENT_LIMIT,
    RELATION_METHOD_VERSION,
)
from research_file_workbench.journals.evidence_world import build_world_evidence

__all__ = [
    "EVIDENCE_METHOD_VERSION",
    "RELATED_FRAGMENT_LIMIT",
    "RELATION_METHOD_VERSION",
    "build_world_evidence",
]
