"""End-to-end journal-world workflow over application-owned temporary storage."""

from pathlib import Path

import pytest

from research_file_workbench.common.json_io import load_json_object
from research_file_workbench.journals import models
from research_file_workbench.journals.models import SourceInput
from research_file_workbench.projects.models import BaselineConflictError
from research_file_workbench.workbench import service as service_module
from research_file_workbench.workbench.service import WorkbenchService
from tests.journals.test_analysis import docx_bytes, template_bytes


def test_import_bind_check_revision_and_disposition_preserve_history(tmp_path: Path) -> None:
    service = WorkbenchService.create(tmp_path / "library")
    world = service.import_world(
        "journal-test",
        "Test Journal",
        [
            SourceInput("template.docx", "template_docx", template_bytes()),
            SourceInput("guide.txt", "guide_text", b"All manuscript pages must use A4 paper."),
        ],
    )
    assert world["rules"]
    project = service.import_manuscript("Manuscript", "manuscript.docx", template_bytes())
    binding = service.bind(project["project_id"], world["version_id"], None)
    check = service.run_check(project["project_id"])
    assert check["validity"] == "CURRENT"
    width_rule = next(rule for rule in world["rules"] if rule["property"] == "page_width_twips")
    disposition = service.disposition(
        check["check_id"], width_rule["rule_id"], "note", "Reviewed against the supplied guide."
    )
    assert disposition["verdict"] == "compliant"
    revised = service.revise(
        world["version_id"], width_rule["rule_id"], 12240, "Use the confirmed revision guide."
    )
    assert revised["version_id"] != world["version_id"]
    assert service.store.get_binding(project["project_id"])["binding_id"] == binding["binding_id"]
    assert service.store.get_world(world["version_id"])["version_id"] == world["version_id"]
    assert service.check_record(check["check_id"])["validity"] == "CURRENT"
    assert service.diff_worlds(world["version_id"], revised["version_id"])["changes"]
    assert "world" not in service.store.get_check(check["check_id"])
    assert service.check_record(check["check_id"])["update_available"] is True
    service.bind(project["project_id"], revised["version_id"], binding["binding_id"])
    assert service.check_record(check["check_id"])["validity"] == "STALE"


def test_write_records_carry_the_driving_surface(tmp_path: Path) -> None:
    """Bindings, checks and dispositions retain which local surface drove the record."""
    service = WorkbenchService.create(tmp_path / "library")
    world = service.import_world(
        "journal-test",
        "Test Journal",
        [
            SourceInput("template.docx", "template_docx", template_bytes()),
            SourceInput("guide.txt", "guide_text", b"All manuscript pages must use A4 paper."),
        ],
    )
    assert world["rules"]
    project = service.import_manuscript(
        "Manuscript", "manuscript.docx", template_bytes(), surface="mcp"
    )
    binding = service.bind(project["project_id"], world["version_id"], None, surface="mcp")
    assert binding["actor_id"] == "local-operator"
    assert binding["surface"] == "mcp"
    check = service.run_check(project["project_id"], surface="cli")
    assert check["actor_id"] == "local-operator"
    assert check["surface"] == "cli"
    width_rule = next(rule for rule in world["rules"] if rule["property"] == "page_width_twips")
    disposition = service.disposition(
        check["check_id"],
        width_rule["rule_id"],
        "note",
        "Reviewed against the guide.",
        surface="mcp",
    )
    assert disposition["surface"] == "mcp"


def test_manuscript_update_refusals_carry_their_reasons(tmp_path: Path) -> None:
    """Retained refusal records surface as typed refusals naming the current baseline."""
    service = WorkbenchService.create(tmp_path / "library")
    content = docx_bytes("<w:p><w:r><w:t>Body text.</w:t></w:r></w:p>")
    revised_content = docx_bytes("<w:p><w:r><w:t>Revised body text.</w:t></w:r></w:p>")
    project = service.import_manuscript("Manuscript", "manuscript.docx", content)
    baseline_id = str(project["baseline_id"])
    applied = service.update_manuscript(
        str(project["project_id"]),
        baseline_id,
        "revised.docx",
        revised_content,
        "修正封面页",
        "request-1",
        surface="mcp",
    )
    assert applied["status"] == "APPLIED"
    with pytest.raises(BaselineConflictError) as conflict:
        service.update_manuscript(
            str(project["project_id"]),
            baseline_id,
            "revised.docx",
            revised_content,
            "再次修订",
            "request-2",
        )
    assert "BASELINE_CONFLICT" in str(conflict.value)
    assert str(applied["result_baseline_id"]) in str(conflict.value)
    with pytest.raises(ValueError, match="请填写版本更新原因"):
        service.update_manuscript(
            str(project["project_id"]),
            str(applied["result_baseline_id"]),
            "revised.docx",
            revised_content,
            "   ",
            "request-3",
        )


@pytest.mark.parametrize(
    "failure_point", ["create_project", "import_document", "write_json_object"]
)
def test_failed_manuscript_import_leaves_no_published_project(tmp_path, monkeypatch, failure_point):
    service = WorkbenchService.create(tmp_path / "library")

    def fail(*args, **kwargs):
        raise OSError("injected import failure")

    monkeypatch.setattr(service_module, failure_point, fail)
    with pytest.raises(OSError, match="injected"):
        service.import_manuscript("Display name", "source.docx", template_bytes())
    assert service.state()["projects"] == []
    assert list((service.root / "inputs").iterdir()) == []
    assert list((service.root / "var").iterdir()) == []


def test_display_name_is_not_a_file_path_or_file_type(tmp_path):
    service = WorkbenchService.create(tmp_path / "library")
    project = service.import_manuscript("论文 / 修回版本", "source.docx", template_bytes())
    assert project["name"] == "论文 / 修回版本"
    metadata = load_json_object(service.root / "projects" / project["project_id"] / "display.json")
    assert metadata == {"name": "论文 / 修回版本", "filename": "source.docx"}


def test_missing_library_does_not_allow_import_side_effects(tmp_path):
    root = tmp_path / "absent"
    with pytest.raises(ValueError):
        WorkbenchService(root)
    assert not root.exists()


def test_corrupt_project_is_not_hidden_from_discovery(tmp_path):
    service = WorkbenchService.create(tmp_path / "library")
    project = service.import_manuscript("Display", "source.docx", template_bytes())
    (service.root / "projects" / project["project_id"] / "display.json").unlink()
    with pytest.raises(ValueError):
        service.state()


def test_corrupt_display_name_control_character_is_not_exposed(tmp_path):
    service = WorkbenchService.create(tmp_path / "library")
    project = service.import_manuscript("Display", "source.docx", template_bytes())
    display_path = service.root / "projects" / project["project_id"] / "display.json"
    display_path.write_text('{"name":"bad\\u0000name","filename":"source.docx"}', encoding="utf-8")
    with pytest.raises(ValueError, match="控制字符"):
        service.state()


def test_corrupt_display_metadata_filename_is_not_exposed(tmp_path):
    service = WorkbenchService.create(tmp_path / "library")
    project = service.import_manuscript("Display", "source.docx", template_bytes())
    display_path = service.root / "projects" / project["project_id"] / "display.json"
    display_path.write_text('{"name":"Display","filename":"outside.txt"}', encoding="utf-8")
    with pytest.raises(ValueError, match="文件名无效"):
        service.state()


def test_baseline_guard_rejects_changed_source_before_binding(tmp_path, monkeypatch):
    service = WorkbenchService.create(tmp_path / "library")
    world = service.import_world(
        "journal-test",
        "Test",
        [
            SourceInput("guide.txt", "guide_text", b"All manuscript pages must use A4 paper."),
        ],
    )
    project = service.import_manuscript("Display", "source.docx", template_bytes())
    from research_file_workbench.projects.store import ProjectStore

    def reject(*args, **kwargs):
        raise ValueError("baseline changed")

    monkeypatch.setattr(ProjectStore, "guard_baseline", reject)
    with pytest.raises(ValueError, match="baseline changed"):
        service.bind(project["project_id"], world["version_id"], None)
    assert service.store.get_binding(project["project_id"]) is None


def test_analyzer_upgrade_marks_pinned_check_stale_without_changing_history(tmp_path, monkeypatch):
    service = WorkbenchService.create(tmp_path / "library")
    world = service.import_world(
        "journal-test",
        "Test",
        [SourceInput("guide.txt", "guide_text", b"All manuscript pages must use A4 paper.")],
    )
    project = service.import_manuscript("Manuscript", "source.docx", template_bytes())
    binding = service.bind(project["project_id"], world["version_id"], None)
    check = service.run_check(project["project_id"])
    retained = service.store.get_check(check["check_id"])

    monkeypatch.setattr(models, "ANALYZER_VERSION", "journal-world-analyzer-future")

    inspected = service.check_record(check["check_id"])
    assert inspected["validity"] == "STALE"
    assert inspected["stale_reasons"] == ["analyzer_version_changed"]
    assert inspected["update_available"] is False
    assert inspected["rule_results"] == check["rule_results"]
    assert service.store.get_check(check["check_id"]) == retained
    assert service.store.get_binding(project["project_id"]) == binding
    with pytest.raises(models.WorldAnalysisError, match="reanalyze"):
        service.run_check(project["project_id"])
    assert len(service.store.list_checks(project["project_id"])) == 1


def test_latest_check_follows_commit_order_when_clock_moves_backward(tmp_path, monkeypatch):
    service = WorkbenchService.create(tmp_path / "library")
    world = service.import_world(
        "journal-test",
        "Test",
        [SourceInput("guide.txt", "guide_text", b"All manuscript pages must use A4 paper.")],
    )
    project = service.import_manuscript("Manuscript", "source.docx", template_bytes())
    service.bind(project["project_id"], world["version_id"], None)
    timestamps = iter(["2026-09-26T00:00:02+00:00", "2026-09-26T00:00:01+00:00"])
    monkeypatch.setattr(service_module, "utc_now_iso", lambda: next(timestamps))

    first = service.run_check(project["project_id"])
    second = service.run_check(project["project_id"])

    assert first["created_at"] > second["created_at"]
    assert [item["check_id"] for item in service.store.list_checks(project["project_id"])] == [
        first["check_id"],
        second["check_id"],
    ]
    assert service.project(project["project_id"])["latest_check"]["check_id"] == second["check_id"]
    assert service.state()["projects"][0]["latest_check"]["check_id"] == second["check_id"]
