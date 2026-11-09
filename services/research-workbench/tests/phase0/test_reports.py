import json
from pathlib import Path

from research_file_workbench.common.filesystem import snapshot_directory
from research_file_workbench.common.hashing import sha256_file
from research_file_workbench.phase0.reports import build_phase0_reports
from tests.phase0.project_factory import (
    apply_phase0_test_contracts,
    copy_public_phase0_contracts,
)

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def test_build_reports_only_writes_declared_project_reports(tmp_path: Path) -> None:
    project_root = tmp_path / "project"
    contracts = project_root / "contracts" / "phase0"
    copy_public_phase0_contracts(PROJECT_ROOT, project_root)
    apply_phase0_test_contracts(project_root)

    author_root = tmp_path / "author"
    author_root.mkdir()
    file_paths = {
        "main-annotated-docx": author_root / "main.docx",
        "ijam-english-working-docx": author_root / "english.docx",
        "chinese-historical-review-pdf": author_root / "history.pdf",
        "zotero-readonly-database": author_root / "zotero.sqlite",
        "author-terminology-rules": author_root / "terminology.md",
        "current-evidence-ledger": author_root / "evidence.md",
        "ijam-legacy-word-template": author_root / "template.doc",
    }
    for artifact_id, path in file_paths.items():
        path.write_text(artifact_id, encoding="utf-8")
    directory_paths = {
        "latex-template-directory": author_root / "latex",
        "candidate-figure-directory": author_root / "figures",
    }
    for artifact_id, path in directory_paths.items():
        path.mkdir()
        (path / "registered.txt").write_text(artifact_id, encoding="utf-8")

    source_catalog_path = contracts / "source-catalog.json"
    source_catalog = json.loads(source_catalog_path.read_text(encoding="utf-8"))
    source_catalog["author_workspace_root"] = author_root.as_posix()
    for artifact in source_catalog["artifacts"]:
        artifact_id = artifact["artifact_id"]
        if artifact_id in file_paths:
            artifact["path"] = file_paths[artifact_id].as_posix()
            artifact["sha256"] = sha256_file(file_paths[artifact_id])
        else:
            artifact["path"] = directory_paths[artifact_id].as_posix()
            snapshot = snapshot_directory(directory_paths[artifact_id])
            files = [entry for entry in snapshot.entries if entry.entry_type == "file"]
            artifact["manifest_sha256"] = snapshot.manifest_sha256
            artifact["expected_file_count"] = len(files)
            artifact["expected_total_file_size"] = sum(entry.size or 0 for entry in files)
    source_catalog_path.write_text(
        json.dumps(source_catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    renderer = tmp_path / "wps.exe"
    renderer.write_bytes(b"renderer")
    render_contract_path = contracts / "render-environments.json"
    render_contract = json.loads(render_contract_path.read_text(encoding="utf-8"))
    wps_profile = render_contract["profiles"][0]
    wps_profile["executable_path"] = renderer.as_posix()
    wps_profile["executable_sha256"] = sha256_file(renderer)
    render_contract_path.write_text(
        json.dumps(render_contract, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    baseline_pdf = project_root / "fixtures" / "rendered" / "baseline.pdf"
    baseline_pdf.parent.mkdir(parents=True)
    baseline_pdf.write_bytes(b"pdf")
    page_directory = project_root / "fixtures" / "rendered" / "pages"
    page_directory.mkdir()
    (page_directory / "page-01.png").write_bytes(b"page")
    baseline_contract_path = contracts / "render-baselines.json"
    baseline_contract = json.loads(baseline_contract_path.read_text(encoding="utf-8"))
    baseline = baseline_contract["baselines"][0]
    baseline["pdf_path"] = baseline_pdf.as_posix()
    baseline["pdf_sha256"] = sha256_file(baseline_pdf)
    baseline["page_image_directory"] = page_directory.as_posix()
    baseline["page_count"] = 1
    baseline_contract_path.write_text(
        json.dumps(baseline_contract, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    before = snapshot_directory(author_root)
    paths = build_phase0_reports(project_root)
    after = snapshot_directory(author_root)

    assert before.manifest_sha256 == after.manifest_sha256
    assert set(paths) == {
        "source-inventory.json",
        "render-environment.json",
        "author-workspace-baseline.json",
        "contract-validation.json",
    }
    assert {path.name for path in (project_root / "reports" / "phase0").iterdir()} == set(paths)
