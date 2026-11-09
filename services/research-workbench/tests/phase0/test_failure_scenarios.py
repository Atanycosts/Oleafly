"""Exercise the real export script with a failing COM constructor; never launch Office."""

import json
import os
from pathlib import Path

import pytest
from powershell_runner import run_powershell

from research_file_workbench.common.hashing import sha256_file

PROJECT_ROOT = Path(__file__).resolve().parents[2]
pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows PowerShell export boundary")


def test_render_failure_preserves_source_and_creates_no_output(tmp_path: Path) -> None:
    application = tmp_path / "application"
    author = tmp_path / "author"
    author.mkdir()
    contracts = application / "contracts/phase0"
    contracts.mkdir(parents=True)
    (application / "var/render-tasks").mkdir(parents=True)
    source = author / "source.docx"
    fixture = PROJECT_ROOT / "tests/fixtures/docx/normal/s1-regions-fields/s1-regions-fields.docx"
    source.write_bytes(fixture.read_bytes())
    source_hash = sha256_file(source)
    structure = application / "structure-result.json"
    structure.write_text('{"status":"partial"}', encoding="utf-8")
    structure_hash = sha256_file(structure)
    output = application / "output.pdf"
    (contracts / "source-catalog.json").write_text(
        json.dumps({"author_workspace_root": str(author)}), encoding="utf-8"
    )
    export_script = PROJECT_ROOT / "tools/phase0/export-pdf-with-wps.ps1"
    # Values enter as environment paths, never interpolated into executable PowerShell source.
    environment = os.environ | {
        "RFW_TEST_APPLICATION": str(application),
        "RFW_TEST_SOURCE": str(source),
        "RFW_TEST_OUTPUT": str(output),
        "RFW_TEST_EXPORT_SCRIPT": str(export_script),
    }
    script = r"""
$ErrorActionPreference = 'Stop'
$executable = Get-Item -LiteralPath (Join-Path $PSHOME 'pwsh.exe')
$profile = @{
    profile_id = 'controlled-failing-renderer'
    executable_path = $executable.FullName
    executable_sha256 = (Get-FileHash -LiteralPath $executable.FullName).Hash.ToLowerInvariant()
    file_version = $executable.VersionInfo.FileVersion.Replace(',', '.').Replace(' ', '')
    required_settings = @{pdf_export_settings = @{automation = 'Controlled.Fail.Before.Com'}}
}
@{profiles = @($profile)} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (
    Join-Path $env:RFW_TEST_APPLICATION 'contracts/phase0/render-environments.json'
)
function Get-Process {
    param([string]$Name, [string]$ErrorAction)
    if ($Name -ne 'wps') { throw 'Unexpected process lookup in controlled test' }
    return @()
}
function New-Object {
    param([string]$ComObject)
    if ($ComObject -ne 'Controlled.Fail.Before.Com') { throw 'Unexpected COM construction' }
    throw 'controlled renderer failure before COM construction'
}
& $env:RFW_TEST_EXPORT_SCRIPT -InputPath $env:RFW_TEST_SOURCE `
    -OutputPath $env:RFW_TEST_OUTPUT -ApplicationRoot $env:RFW_TEST_APPLICATION `
    -RenderProfileId 'controlled-failing-renderer'
"""
    result = run_powershell(script, env_overrides=environment)

    assert result.returncode != 0
    assert "controlled renderer failure before COM construction" in result.stderr
    assert sha256_file(source) == source_hash
    assert sha256_file(structure) == structure_hash
    assert sorted(path.name for path in author.iterdir()) == ["source.docx"]
    assert not output.exists()
    assert "renderer_identity_status" not in result.stdout
