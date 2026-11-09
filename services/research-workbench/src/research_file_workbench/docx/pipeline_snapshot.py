"""Application-owned source snapshots for the controlled S1 pipeline."""

from __future__ import annotations

import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path

from research_file_workbench.common.hashing import sha256_file
from research_file_workbench.docx.pipeline_errors import S1PipelineError


@dataclass(frozen=True, slots=True)
class SourceSnapshot:
    """The retained source bytes and their immutable identity for one pipeline run."""

    run_id: str
    source_hash: str
    snapshot_path: Path
    snapshot_hash: str


def create_source_snapshot(source: Path, output_directory: Path) -> SourceSnapshot:
    """Copy ``source`` into application storage and verify the copy byte-for-byte."""
    source_hash = sha256_file(source)
    run_id = f"s1-read-{uuid.uuid4().hex}"
    snapshot_directory = output_directory / "snapshot"
    snapshot_directory.mkdir()
    snapshot_path = snapshot_directory / source.name
    shutil.copyfile(source, snapshot_path)
    snapshot_hash = sha256_file(snapshot_path)
    if snapshot_hash != source_hash:
        raise S1PipelineError("Application snapshot hash does not match the author source")
    return SourceSnapshot(run_id, source_hash, snapshot_path, snapshot_hash)
