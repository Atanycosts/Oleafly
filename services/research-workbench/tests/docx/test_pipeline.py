import json
from pathlib import Path

from research_file_workbench.docx import run_s1_readonly

PROJECT_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_ROOT = PROJECT_ROOT / "tests" / "fixtures" / "docx"


def test_s1_pipeline_creates_snapshot_reports_and_zero_pollution(tmp_path: Path) -> None:
    source = FIXTURE_ROOT / "normal/s1-regions-fields/s1-regions-fields.docx"
    author_root = tmp_path / "author"
    author_root.mkdir()
    author_copy = author_root / "source.docx"
    author_copy.write_bytes(source.read_bytes())
    output = tmp_path / "app" / "run"

    report = run_s1_readonly(
        author_copy,
        application_root=tmp_path / "app",
        output_directory=output,
        author_workspace_root=author_root,
    )

    assert report["status"] == "partial"
    assert report["stage_status"] == {
        "structural_read": "completed_with_limitations",
        "page_mapping": "pending_independent_review",
        "page_evidence": "not_supplied",
    }
    assert report["author_workspace_unchanged"] is True
    assert Path(report["source"]["snapshot_path"]).is_file()
    assert (output / "structure-report.json").is_file()
    assert (output / "workspace-comparison.json").is_file()
    json.loads((output / "run-report.json").read_text(encoding="utf-8"))
    assert sorted(item.name for item in author_root.iterdir()) == ["source.docx"]


def test_s1_pipeline_writes_page_mapping_when_independent_evidence_is_supplied(
    tmp_path: Path,
) -> None:
    source = FIXTURE_ROOT / "normal/s1-figures-tables/s1-figures-tables.docx"
    author_root = tmp_path / "author"
    author_root.mkdir()
    author_copy = author_root / source.name
    author_copy.write_bytes(source.read_bytes())
    annotation = PROJECT_ROOT / "annotations/s1/s1-figures-tables/document-annotation.json"
    evidence = PROJECT_ROOT / "annotations/s1/s1-figures-tables/page-evidence.json"
    output = tmp_path / "app" / "run"

    report = run_s1_readonly(
        author_copy,
        application_root=tmp_path / "app",
        output_directory=output,
        author_workspace_root=author_root,
        document_annotation=annotation,
        page_evidence=evidence,
    )

    assert report["page_mapping_report"]
    assert report["stage_status"]["structural_read"] == "completed_with_limitations"
    assert report["stage_status"]["page_mapping"] == "reviewed"
    mapping = json.loads((output / "page-mapping-report.json").read_text(encoding="utf-8"))
    assert mapping["status"] == "reviewed"


def test_s1_pipeline_indexes_application_owned_page_images(tmp_path: Path) -> None:
    source = FIXTURE_ROOT / "normal/s1-regions-fields/s1-regions-fields.docx"
    author_root = tmp_path / "author"
    author_root.mkdir()
    author_copy = author_root / source.name
    author_copy.write_bytes(source.read_bytes())
    page_directory = tmp_path / "app" / "pages"
    page_directory.mkdir(parents=True)
    page = next((PROJECT_ROOT / "reports/phase0/fixtures/s1-regions-fields").rglob("*.png"))
    (page_directory / "page-01.png").write_bytes(page.read_bytes())
    output = tmp_path / "app" / "run"

    report = run_s1_readonly(
        author_copy,
        application_root=tmp_path / "app",
        output_directory=output,
        author_workspace_root=author_root,
        page_image_directory=page_directory,
    )

    assert report["page_evidence_index"]
    page_index = json.loads((output / "page-evidence-index.json").read_text(encoding="utf-8"))
    assert page_index["status"] == "unverified"
    assert page_index["page_count"] == 1
