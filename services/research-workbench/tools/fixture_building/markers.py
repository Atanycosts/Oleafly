"""Stable marker names shared by DOCX fixture builders and annotations."""

from dataclasses import dataclass


@dataclass(frozen=True)
class FixtureIdentity:
    """Identify one generated fixture and its marker namespace."""

    sample_id: str
    file_code: str
    relative_path: str

    def marker(self, object_name: str, index: int = 1) -> str:
        """Return a stable, human-visible marker for one fixture object."""
        normalized_name = object_name.upper().replace("_", "-")
        return f"RFW-FX-{self.file_code}-{normalized_name}-{index:03d}"


REGIONS_FIELDS = FixtureIdentity(
    sample_id="s1-regions-fields",
    file_code="RF",
    relative_path="normal/s1-regions-fields/s1-regions-fields.docx",
)
SECTIONS_LAYOUT = FixtureIdentity(
    sample_id="s1-sections-layout",
    file_code="SL",
    relative_path="normal/s1-sections-layout/s1-sections-layout.docx",
)
FIGURES_TABLES = FixtureIdentity(
    sample_id="s1-figures-tables",
    file_code="FT",
    relative_path="normal/s1-figures-tables/s1-figures-tables.docx",
)
EMBEDDED_OBJECTS = FixtureIdentity(
    sample_id="s1-embedded-objects",
    file_code="EO",
    relative_path="normal/s1-embedded-objects/s1-embedded-objects.docx",
)
BROKEN_RELATIONSHIPS = FixtureIdentity(
    sample_id="s1-broken-relationships",
    file_code="BR",
    relative_path="faults/s1-broken-relationships/s1-broken-relationships.docx",
)
MISSING_FONT = FixtureIdentity(
    sample_id="s1-missing-font",
    file_code="MF",
    relative_path="environment/s1-missing-font/s1-missing-font.docx",
)
PAGINATION_AMBIGUITY = FixtureIdentity(
    sample_id="s1-pagination-ambiguity",
    file_code="PA",
    relative_path="normal/s1-pagination-ambiguity/s1-pagination-ambiguity.docx",
)

ALL_FIXTURES = (
    REGIONS_FIELDS,
    SECTIONS_LAYOUT,
    FIGURES_TABLES,
    EMBEDDED_OBJECTS,
    BROKEN_RELATIONSHIPS,
    MISSING_FONT,
    PAGINATION_AMBIGUITY,
)
