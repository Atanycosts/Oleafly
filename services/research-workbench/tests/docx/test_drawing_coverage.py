"""Guard that no fixture drawing is silently dropped by object registration.

``read_images`` registers a drawing only when it has an inline/anchor container and an ``a:blip``
picture resource, and ``read_complex_objects`` registers charts, OLE objects, grouped drawings and
unknown extensions. A drawing that offers neither shape would vanish with no image and no complex
object behind it. This module counts ``<w:drawing>`` elements in the raw package XML, independently
of reader output, and checks that the reader's own registrations account for every one of them.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from xml.etree import ElementTree
from zipfile import ZipFile

import pytest

from research_file_workbench.docx import read_docx
from research_file_workbench.docx.parsing.package import (
    inventory_parts,
    package_part_names,
    read_content_types,
    read_relationships,
)
from research_file_workbench.docx.xml_support import iter_selected, tag_local_name

PROJECT_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_ROOT = PROJECT_ROOT / "tests" / "fixtures" / "docx"
FIXTURE_SOURCES = tuple(sorted(FIXTURE_ROOT.rglob("*.docx")))

# Element names read_complex_objects treats as an embedded object.
COMPLEX_OBJECT_LOCAL_NAMES = frozenset({"chart", "OLEObject", "wgp", "unknownObject"})

# Drawings measured in the reviewed fixtures; they keep the coverage assertion non-vacuous.
EXPECTED_DRAWING_COUNTS = {"s1-figures-tables": 2, "s1-native-complex-objects": 2}


@dataclass(frozen=True)
class DrawingCoverage:
    """Raw drawing totals for one fixture and the locators nothing accounts for."""

    drawing_total: int
    covered_total: int
    image_covered_total: int
    object_covered_total: int
    uncovered: tuple[str, ...]


@pytest.mark.parametrize("source", FIXTURE_SOURCES, ids=[source.stem for source in FIXTURE_SOURCES])
def test_every_fixture_drawing_is_accounted_for(source: Path) -> None:
    coverage = _measure_drawing_coverage(source)

    assert coverage.uncovered == ()
    assert coverage.covered_total == coverage.drawing_total
    expected_total = EXPECTED_DRAWING_COUNTS.get(source.stem)
    if expected_total is not None:
        assert coverage.drawing_total == expected_total


def test_reviewed_fixtures_still_contain_registered_drawings() -> None:
    coverage_by_fixture = {
        source.stem: _measure_drawing_coverage(source) for source in FIXTURE_SOURCES
    }

    assert set(EXPECTED_DRAWING_COUNTS) <= set(coverage_by_fixture)
    for fixture_name, expected_total in EXPECTED_DRAWING_COUNTS.items():
        assert coverage_by_fixture[fixture_name].drawing_total == expected_total
    # Both registration paths must stay exercised, not only the picture-resource path.
    assert sum(item.image_covered_total for item in coverage_by_fixture.values()) > 0
    assert sum(item.object_covered_total for item in coverage_by_fixture.values()) > 0


def _measure_drawing_coverage(source: Path) -> DrawingCoverage:
    """Count package drawings and how the reader's registrations account for each one."""
    result = read_docx(source)
    registered_images = {image.node_locator for image in result.images}
    registered_objects = {item.node_locator for item in result.complex_objects}
    drawing_total = 0
    covered_total = 0
    image_covered_total = 0
    object_covered_total = 0
    uncovered: list[str] = []
    # Every parsed XML part is inspected, including parts outside the reader's supported regions:
    # a drawing there is genuinely unregistered and must fail this check rather than go unnoticed.
    for part_path, root in _part_roots(source).items():
        image_locators = _selected_drawing_locators(part_path, root)
        object_locators = _embedded_object_locators(part_path, root)
        raw_index = 0
        for element in root.iter():
            if tag_local_name(element.tag) != "drawing":
                continue
            raw_index += 1
            drawing_total += 1
            image_covered = image_locators.get(id(element)) in registered_images
            object_covered = any(
                object_locators.get(id(descendant)) in registered_objects
                for descendant in element.iter()
            )
            if image_covered:
                image_covered_total += 1
            if object_covered:
                object_covered_total += 1
            if image_covered or object_covered:
                covered_total += 1
            else:
                uncovered.append(f"{part_path}#drawing[{raw_index}]")
    return DrawingCoverage(
        drawing_total=drawing_total,
        covered_total=covered_total,
        image_covered_total=image_covered_total,
        object_covered_total=object_covered_total,
        uncovered=tuple(uncovered),
    )


def _part_roots(source: Path) -> dict[str, ElementTree.Element]:
    """Parse the same XML roots reader.py parses, without using its observations."""
    with ZipFile(source) as archive:
        names = package_part_names(archive)
        content_types, _content_type_issues = read_content_types(archive, names)
        _parts, xml_roots, _xml_payloads, _part_issues = inventory_parts(
            archive, names, content_types
        )
        _relationships, _relationship_issues = read_relationships(names, xml_roots)
    return xml_roots


def _selected_drawing_locators(part_path: str, root: ElementTree.Element) -> dict[int, str]:
    """Bind selected drawings to the locators read_images assigns to registered images."""
    return {
        id(element): f"{part_path}#drawing[{index}]"
        for index, element in enumerate(
            (item for item in iter_selected(root) if tag_local_name(item.tag) == "drawing"),
            start=1,
        )
    }


def _embedded_object_locators(part_path: str, root: ElementTree.Element) -> dict[int, str]:
    """Bind embedded-object candidates to the locators read_complex_objects assigns."""
    return {
        id(element): f"{part_path}#complex[{index}]"
        for index, element in enumerate(root.iter(), start=1)
        if tag_local_name(element.tag) in COMPLEX_OBJECT_LOCAL_NAMES
    }
