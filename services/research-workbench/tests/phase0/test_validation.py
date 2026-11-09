import copy
from collections.abc import Callable
from pathlib import Path

import pytest

from research_file_workbench.common.json_io import load_json_object
from research_file_workbench.phase0 import contracts, validation
from research_file_workbench.phase0.cli import main
from tests.phase0.project_factory import build_complete_project

PROJECT_ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def complete_project(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Build a controlled evidence copy and prove its unmodified contracts pass."""
    target = tmp_path_factory.mktemp("phase0-complete-project")
    build_complete_project(PROJECT_ROOT, target)
    report = validation.validate_phase0_contracts(target / "contracts/phase0")
    assert report["phase0_complete"] is True, report
    return target


@pytest.fixture
def mutate(monkeypatch: pytest.MonkeyPatch) -> Callable:
    """Intercept only JSON reads; leave source files and actual hash checks untouched."""

    def install(mutator: Callable) -> None:
        def changed(path: Path):
            value = copy.deepcopy(load_json_object(path))
            return mutator(path, value)

        monkeypatch.setattr(validation, "load_json_object", changed)
        monkeypatch.setattr(contracts, "load_json_object", changed)

    return install


def assert_failed(report: dict, check_id: str, detail: str = "") -> None:
    assert report["phase0_complete"] is False
    check = next(item for item in report["checks"] if item["check_id"] == check_id)
    assert check["passed"] is False
    assert detail in str(check["detail"])


def test_repository_contracts_validate(complete_project: Path) -> None:
    """Validate a relocated copy; repository contracts retain historical machine paths."""
    report = validation.validate_phase0_contracts(complete_project / "contracts/phase0")
    assert report["contract_valid"] is True
    assert report["phase0_complete"] is True
    assert report["completion_blockers"] == []


@pytest.mark.parametrize("filename", validation._REQUIRED_CONTRACTS)
def test_empty_contract_fails_by_name(
    complete_project: Path, mutate: Callable, filename: str
) -> None:
    mutate(lambda path, value: {} if path.name == filename else value)
    report = validation.validate_phase0_contracts(complete_project / "contracts/phase0")
    assert_failed(report, f"contract-content:{filename}")


@pytest.mark.parametrize("filename", ["cache-invalidation.json", "source-catalog.json"])
def test_missing_contract_fails_by_name(
    complete_project: Path, monkeypatch: pytest.MonkeyPatch, filename: str
) -> None:
    original = Path.is_file
    target = complete_project / "contracts/phase0" / filename
    monkeypatch.setattr(Path, "is_file", lambda path: False if path == target else original(path))
    report = validation.validate_phase0_contracts(complete_project / "contracts/phase0")
    assert_failed(report, f"contract-present:{filename}")


@pytest.mark.parametrize("mode", ["wrong-hash", "empty-settings"])
def test_renderer_contract_is_enforced(complete_project: Path, mutate: Callable, mode: str) -> None:
    def change(path, value):
        if path.name == "render-environments.json":
            profile = value["profiles"][0]
            if mode == "wrong-hash":
                profile["executable_sha256"] = "0" * 64
            else:
                profile["required_settings"] = {}
        return value

    mutate(change)
    report = validation.validate_phase0_contracts(complete_project / "contracts/phase0")
    assert_failed(report, "render-profile-runtime-validation")


def test_baseline_source_hash_is_enforced(complete_project: Path, mutate: Callable) -> None:
    def change(path, value):
        if path.name == "render-baselines.json":
            value["baselines"][0]["source_sha256"] = "0" * 64
        return value

    mutate(change)
    report = validation.validate_phase0_contracts(complete_project / "contracts/phase0")
    assert_failed(report, "registered-render-baselines-valid", "source-hash-mismatch")


@pytest.mark.parametrize(
    "mode",
    [
        "missing-pdf",
        "wrong-pdf-hash",
        "wrong-page-hash",
        "missing-pages",
        "wrong-page-count",
        "wrong-source",
        "wrong-source-path",
        "missing-object",
        "duplicate-mapping",
        "unknown-renderer",
        "empty-objects",
        "wrong-style-value",
        "invalid-locator",
    ],
)
def test_invalid_fixture_evidence_is_rejected(
    complete_project: Path, mutate: Callable, mode: str
) -> None:
    def change(path, value):
        if path.name == "fixture-render-catalog.json":
            item = value["fixtures"][0]
            if mode == "missing-pdf":
                item["pdf_path"] = str(complete_project / "reports/absent.pdf")
            elif mode == "wrong-pdf-hash":
                item["pdf_sha256"] = "0" * 64
            elif mode == "wrong-page-hash":
                item["pages"][0]["sha256"] = "0" * 64
            elif mode == "missing-pages":
                item["pages"] = []
            elif mode == "wrong-page-count":
                item["page_count"] = 999
            elif mode == "wrong-source":
                item["actual_source_sha256"] = "0" * 64
            elif mode == "wrong-source-path":
                item["source_path"] = item["source_path"].replace(
                    "s1-regions-fields", "s1-broken-relationships"
                )
        if path.name == "page-evidence.json" and path.parent.name == "s1-regions-fields":
            if mode == "missing-object":
                value["mappings"][0]["object_annotation_id"] = "absent"
            elif mode == "duplicate-mapping":
                value["mappings"][1]["annotation_id"] = value["mappings"][0]["annotation_id"]
            elif mode == "unknown-renderer":
                value["render_profile_id"] = "unknown"
        if path.name == "document-annotation.json":
            if mode == "empty-objects":
                value["objects"] = []
            elif mode == "invalid-locator":
                value["objects"][0]["locator"] = "word/absent.xml nonexistent object"
            elif mode == "wrong-style-value" and path.parent.name == "s1-sections-layout":
                style = next(item for item in value["objects"] if "expected_properties" in item)
                style["expected_properties"]["font_size_pt"]["value"] = 99
        return value

    mutate(change)
    report = validation.validate_phase0_contracts(complete_project / "contracts/phase0")
    assert_failed(report, "fixture-catalog-sources-and-annotations-valid")


def test_historical_source_path_is_matched_after_relocation(
    complete_project: Path, mutate: Callable
) -> None:
    relative_path = "normal/s1-regions-fields/s1-regions-fields.docx"

    def change(path, value):
        if path.name == "fixture-render-catalog.json":
            value["fixtures"][0]["source_path"] = (
                "C:/historical/checkout/tests/fixtures/docx/" + relative_path
            )
        return value

    mutate(change)
    report = validation.validate_phase0_contracts(complete_project / "contracts/phase0")
    assert report["contract_valid"] is True
    assert report["phase0_complete"] is True


def test_historical_render_paths_are_loaded_from_relocated_reports(
    complete_project: Path, mutate: Callable
) -> None:
    report_prefix = "C:/historical/checkout/reports/"

    def change(path, value):
        if path.name == "fixture-render-catalog.json":
            item = value["fixtures"][0]
            for key in ("pdf_path", "page_directory"):
                normalized = item[key].replace("\\", "/")
                item[key] = report_prefix + normalized.split("/reports/", 1)[1]
            for page in item["pages"]:
                normalized = page["path"].replace("\\", "/")
                page["path"] = report_prefix + normalized.split("/reports/", 1)[1]
        return value

    mutate(change)
    report = validation.validate_phase0_contracts(complete_project / "contracts/phase0")
    assert report["contract_valid"] is True
    assert report["phase0_complete"] is True


def test_missing_actual_page_is_detected(
    complete_project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = complete_project / "reports/phase0/fixtures/s1-regions-fields/pages-150dpi/page-1.png"
    original = Path.is_file
    monkeypatch.setattr(Path, "is_file", lambda path: False if path == target else original(path))
    report = validation.validate_phase0_contracts(complete_project / "contracts/phase0")
    assert_failed(report, "fixture-catalog-sources-and-annotations-valid", "Page image absent")


@pytest.mark.parametrize("level", ["document", "object", "mapping"])
def test_unreviewed_evidence_makes_cli_fail(
    complete_project: Path, mutate: Callable, level: str
) -> None:
    def change(path, value):
        if path.parent.name == "s1-regions-fields":
            if path.name == "document-annotation.json":
                if level == "document":
                    value["review_status"] = "pending_review"
                elif level == "object":
                    value["objects"][0]["review_status"] = "pending_review"
            elif path.name == "page-evidence.json" and level == "mapping":
                value["mappings"][0]["mapping_status"] = "pending_review"
        return value

    mutate(change)
    report = validation.validate_phase0_contracts(complete_project / "contracts/phase0")
    assert report["contract_valid"] is True
    assert report["phase0_complete"] is False
    assert main(["--project-root", str(complete_project), "validate"]) != 0


def test_acceptance_fixture_change_is_detected(complete_project: Path, mutate: Callable) -> None:
    def change(path, value):
        if path.name == "acceptance-fixtures.json":
            next(
                item
                for item in value["fixtures"]
                if item["fixture_id"] == "legacy-doc-is-not-s1-docx"
            )["expected_phase"] = "S1"
        return value

    mutate(change)
    report = validation.validate_phase0_contracts(complete_project / "contracts/phase0")
    assert_failed(report, "acceptance-fixture:legacy-doc-is-not-s1-docx")


def test_declared_failure_verdict_cannot_pass(complete_project: Path, mutate: Callable) -> None:
    def change(path, value):
        if path.name == "acceptance-fixtures.json":
            value["fixtures"][0]["expected_verdict"] = "fail"
        return value

    mutate(change)
    report = validation.validate_phase0_contracts(complete_project / "contracts/phase0")
    assert_failed(report, "contract-content:acceptance-fixtures.json")


@pytest.mark.parametrize(
    "mode",
    [
        "verification-record",
        "method-version",
        "schema-ref",
        "source-hash",
        "cache-dependency",
        "digest-vector",
    ],
)
def test_required_contract_semantics_cannot_be_removed(
    complete_project: Path, mutate: Callable, mode: str
) -> None:
    filename = {
        "verification-record": "minimum-schema.json",
        "method-version": "minimum-schema.json",
        "schema-ref": "minimum-schema.json",
        "source-hash": "source-catalog.json",
        "cache-dependency": "cache-invalidation.json",
        "digest-vector": "digest-contract.json",
    }[mode]

    def change(path, value):
        if path.name != filename:
            return value
        if mode == "verification-record":
            del value["entities"]["verification_record"]
        elif mode == "method-version":
            value["entities"]["evidence_item"]["required"].remove("extraction_method_version")
        elif mode == "schema-ref":
            value["entities"]["read_record"]["fields"]["task_id"]["type"] = "ref:missing.id"
        elif mode == "source-hash":
            value["artifacts"][0]["sha256"] = None
        elif mode == "cache-dependency":
            value["result_types"][1]["depends_on"].remove("parser_version")
        elif mode == "digest-vector":
            value["vectors"][0]["sha256"] = "0" * 64
        return value

    mutate(change)
    report = validation.validate_phase0_contracts(complete_project / "contracts/phase0")
    assert_failed(report, f"contract-content:{filename}")


def test_handoff_specification_failure_blocks_phase0(
    complete_project: Path, mutate: Callable
) -> None:
    def change(path, value):
        if path.name == "s1-handoff-acceptance.json":
            value["reading_bookmarks"]["cases"][1]["expected"]["expected_verdict"] = "accepted"
        return value

    mutate(change)
    report = validation.validate_phase0_contracts(complete_project / "contracts/phase0")
    assert_failed(report, "contract-content:s1-handoff-acceptance.json")


@pytest.mark.parametrize("mode", ["added-dependency", "removed-exclusion"])
def test_cache_contract_cannot_silently_broaden_invalidation(
    complete_project: Path, mutate: Callable, mode: str
) -> None:
    def change(path, value):
        if path.name == "cache-invalidation.json":
            entry = value["result_types"][1]
            if mode == "added-dependency":
                entry["depends_on"].append("unrelated_setting")
            else:
                entry["must_not_depend_on"].remove("journal_rule_version")
        return value

    mutate(change)
    report = validation.validate_phase0_contracts(complete_project / "contracts/phase0")
    assert_failed(report, "contract-content:cache-invalidation.json")


def test_contract_read_error_is_a_named_failure(
    complete_project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def read(path):
        if path.name == "s1-handoff-acceptance.json":
            raise PermissionError("Contract cannot be read")
        return load_json_object(path)

    monkeypatch.setattr(validation, "load_json_object", read)
    report = validation.validate_phase0_contracts(complete_project / "contracts/phase0")
    assert_failed(report, "contract-content:s1-handoff-acceptance.json", "cannot be read")


@pytest.mark.parametrize("mode", ["success", "source-write", "wrong-input", "unknown-source"])
def test_failure_scenario_semantics_cannot_be_replaced(
    complete_project: Path, mutate: Callable, mode: str
) -> None:
    def change(path, value):
        if path.name == "non-docx-scenarios.json":
            scenario = value["scenarios"][1]
            if mode == "success":
                scenario["expected_result"]["status"] = "rendered"
            elif mode == "source-write":
                scenario["expected_result"]["source_unchanged"] = False
            elif mode == "wrong-input":
                scenario["input"]["render_profile_id"] = "arbitrary-renderer"
            else:
                scenario["source_sample_id"] = "absent-sample"
        return value

    mutate(change)
    report = validation.validate_phase0_contracts(complete_project / "contracts/phase0")
    check = (
        "non-docx-scenario-sources-registered"
        if mode == "unknown-source"
        else "contract-content:non-docx-scenarios.json"
    )
    assert_failed(report, check)
