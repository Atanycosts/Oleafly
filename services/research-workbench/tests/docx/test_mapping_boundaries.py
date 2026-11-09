"""Declared locator and candidate constraints cannot be weakened into unique mappings."""

from copy import deepcopy
from pathlib import Path

import pytest

from research_file_workbench.common.json_io import load_json_object
from research_file_workbench.docx.page_mapping import join_page_evidence
from research_file_workbench.docx.query import ReadQuery, query_docx
from research_file_workbench.docx.reader import read_docx

ROOT = Path(__file__).resolve().parents[2]
SAMPLE = "s1-figures-tables"


@pytest.fixture
def mapping_inputs():
    result = read_docx(ROOT / f"tests/fixtures/docx/normal/{SAMPLE}/{SAMPLE}.docx")
    annotation = load_json_object(ROOT / f"annotations/s1/{SAMPLE}/document-annotation.json")
    evidence = load_json_object(ROOT / f"annotations/s1/{SAMPLE}/page-evidence.json")
    return result, annotation, evidence


@pytest.mark.parametrize(
    "locator",
    [
        "word/document.xml#drawing[999]; wp:inline",
        "word/document.xml#drawing[1] and word/document.xml#drawing[999]; wp:inline",
        "word/document.xml#drawing[wrong]; wp:inline",
        "word/document.xml#; wp:inline",
        "word/document.xml body paragraph 2; wp:docPr id=1 and wp:docPr id=999",
        "word/document.xml body paragraph 2; wp:docPr id=999 and wp:docPr id=1",
        "word/document.xml body paragraph 2; wp:docPr id='wrong'",
        "word/document.xml body paragraph 2; wp:docPr id=",
        "word/document.xml body paragraph 2; r:embed=rId9 and r:embed=rIdMissing",
        "word/document.xml body paragraph 2 and body paragraph 99; wp:inline",
    ],
)
def test_false_or_contradictory_image_constraints_never_become_reviewed(mapping_inputs, locator):
    result, annotation, evidence = mapping_inputs
    annotation["objects"][0]["locator"] = locator
    mapping = join_page_evidence(result, annotation, evidence).to_json()["mappings"][0]
    assert mapping["mapping_status"] == "unmapped"
    assert mapping["reader_candidate_locators"] == []


def test_exact_node_and_repeated_agreeing_attributes_identify_the_same_image(mapping_inputs):
    result, annotation, evidence = mapping_inputs
    annotation["objects"][0]["locator"] = (
        "word/document.xml#drawing[1]; body paragraph 2; "
        "wp:docPr id='1' and docPr id=1; r:embed='rId9'"
    )
    mapping = join_page_evidence(result, annotation, evidence).to_json()["mappings"][0]
    assert mapping["mapping_status"] == "reviewed"
    assert mapping["reader_candidate_locators"] == ["word/document.xml#drawing[1]"]


@pytest.mark.parametrize("extra_candidate", ["missing", "duplicate", "existing"])
def test_multiple_declared_candidates_cannot_collapse_to_one_reviewed_object(
    mapping_inputs, extra_candidate
):
    result, annotation, evidence = mapping_inputs
    mapping = join_page_evidence(result, annotation, evidence).to_json()
    mapping["mappings"] = mapping["mappings"][:1]
    entry = mapping["mappings"][0]
    descriptor = deepcopy(entry["reader_candidates"][0])
    if extra_candidate == "missing":
        descriptor["node_locator"] = "word/document.xml#drawing[999]"
    elif extra_candidate == "existing":
        descriptor["node_locator"] = "word/document.xml#drawing[2]"
    entry["reader_candidates"].append(descriptor)
    entry["reader_candidate_locators"].append(descriptor["node_locator"])
    response = query_docx(
        result,
        ReadQuery(page_number=1, object_type="image"),
        task_id="task-candidate-boundary",
        actor_id="operator-test",
        client_id="client-test",
        page_mapping=mapping,
    )
    assert response["items"] == []
    assert response["read_receipt"]["ranges"] == []
    assert any(
        gap.get("object_annotation_id") == entry["object_annotation_id"]
        for gap in response["coverage_gaps"]
    )
