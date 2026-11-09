from pathlib import Path

from research_file_workbench.phase0.inventory import build_source_inventory
from research_file_workbench.phase0.models import SourceArtifactSpec


def test_inventory_marks_hash_mismatch(tmp_path: Path) -> None:
    source = tmp_path / "source.docx"
    source.write_bytes(b"actual")
    artifact = SourceArtifactSpec(
        artifact_id="source",
        role="test",
        path=source,
        kind="file",
        required=True,
        phase="S1",
        sha256="0" * 64,
    )

    report = build_source_inventory(tmp_path, (artifact,))

    items = report["artifacts"]
    assert isinstance(items, list)
    assert items[0]["status"] == "hash_mismatch"


def test_inventory_does_not_write_author_workspace(tmp_path: Path) -> None:
    source = tmp_path / "source.docx"
    source.write_bytes(b"content")
    before = sorted(path.name for path in tmp_path.iterdir())
    artifact = SourceArtifactSpec(
        artifact_id="source",
        role="test",
        path=source,
        kind="file",
        required=True,
        phase="S1",
        sha256=None,
    )

    build_source_inventory(tmp_path, (artifact,))

    after = sorted(path.name for path in tmp_path.iterdir())
    assert before == after


def test_inventory_rejects_outside_artifact(tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    outside = tmp_path / "outside.docx"
    outside.write_bytes(b"content")
    artifact = SourceArtifactSpec(
        artifact_id="outside",
        role="test",
        path=outside,
        kind="file",
        required=True,
        phase="S1",
        sha256=None,
    )

    report = build_source_inventory(root, (artifact,))

    items = report["artifacts"]
    assert isinstance(items, list)
    assert items[0]["status"] == "outside_author_workspace"
