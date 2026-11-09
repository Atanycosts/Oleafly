import os
import subprocess
from pathlib import Path

import pytest
from powershell_runner import run_powershell

PROJECT_ROOT = Path(__file__).resolve().parents[2]
TOOLS = PROJECT_ROOT / "tools/phase0"
pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows path and renderer guards")


def powershell(script: str) -> subprocess.CompletedProcess[str]:
    return run_powershell(script)


def test_all_scripts_parse() -> None:
    result = powershell(f"""
    $failures = @()
    Get-ChildItem -LiteralPath '{TOOLS}' -Filter '*.ps1' | ForEach-Object {{
        $tokens=$null; $errors=$null
        $null=[Management.Automation.Language.Parser]::ParseFile($_.FullName,[ref]$tokens,[ref]$errors)
        $failures += $errors
    }}
    if ($failures.Count -gt 0) {{ $failures; exit 1 }}
    """)
    assert result.returncode == 0, result.stdout + result.stderr


def test_existing_junction_cannot_escape_root() -> None:
    junction = Path("C:/Users/All Users")
    if not (junction.is_junction() or junction.is_symlink()):
        pytest.skip("System junction is not present")
    result = powershell(f"""
    . '{TOOLS / "path-guards.ps1"}'
    try {{ Assert-OwnedOutputPath 'C:\\Users\\All Users\\never-created.pdf' 'C:\\Users'; exit 1 }}
    catch {{ if ($_.Exception.Message -notlike '*Reparse-point*') {{ throw }}; exit 0 }}
    """)
    assert result.returncode == 0, result.stdout + result.stderr


def test_output_scope_and_no_overwrite(tmp_path: Path) -> None:
    app = tmp_path / "app"
    app.mkdir()
    author = app / "author"
    author.mkdir()
    existing = app / "existing.txt"
    existing.write_text("retain", encoding="utf-8")
    result = powershell(f"""
    $ErrorActionPreference='Stop'
    . '{TOOLS / "path-guards.ps1"}'
    $accepted=Assert-OwnedOutputPath '{app / "new.pdf"}' '{app}' @('{author}')
    $rejected=0
    foreach ($candidate in @('{author / "new.pdf"}','{existing}','{tmp_path / "outside.pdf"}')) {{
        try {{ $null=Assert-OwnedOutputPath $candidate '{app}' @('{author}') }}
        catch {{ $rejected++ }}
    }}
    if ($rejected -ne 3) {{ exit 1 }}
    """)
    assert result.returncode == 0, result.stdout + result.stderr
    assert existing.read_text(encoding="utf-8") == "retain"
    assert not (app / "new.pdf").exists()


@pytest.mark.parametrize("field", ["path", "sha256", "version"])
def test_actual_renderer_identity_mismatch_is_rejected(field: str) -> None:
    result = powershell(f"""
    . '{TOOLS / "wps-identity.ps1"}'
    $expected=[pscustomobject]@{{executable_path='C:\\pinned\\wps.exe';executable_sha256='abc';file_version='1'}}
    $actual=[pscustomobject]@{{path='C:\\pinned\\wps.exe';sha256='abc';version='1'}}
    Assert-WpsIdentity $expected $actual
    $actual.{field}='C:\\different'
    try {{ Assert-WpsIdentity $expected $actual; exit 1 }}
    catch {{ if ($_.Exception.Message -notlike '*actual WPS instance*') {{ throw }}; exit 0 }}
    """)
    assert result.returncode == 0, result.stdout + result.stderr


def test_zero_window_is_rejected_without_com_attachment() -> None:
    result = powershell(f"""
    . '{TOOLS / "wps-identity.ps1"}'
    try {{ Get-WpsInstanceIdentity ([pscustomobject]@{{Hwnd=0}}); exit 1 }}
    catch {{ if ($_.Exception.Message -notlike '*Cannot identify*') {{ throw }}; exit 0 }}
    """)
    assert result.returncode == 0, result.stdout + result.stderr


def test_active_wps_refused_before_creating_files() -> None:
    source = PROJECT_ROOT / "tests/fixtures/docx/normal/s1-regions-fields/s1-regions-fields.docx"
    result = powershell(f"""
    $before=@(Get-Process -Name wps -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty Id)
    if ($before.Count -eq 0) {{ 'NO_ACTIVE_SESSION'; exit 0 }}
    $taskRoot='{PROJECT_ROOT / "var/render-tasks"}'
$beforeTasks=@(Get-ChildItem -LiteralPath $taskRoot -Directory -ErrorAction SilentlyContinue).Count
    $output='{PROJECT_ROOT / "var/guard-test-never-created.pdf"}'
    if (Test-Path -LiteralPath $output) {{ throw 'Test target already exists' }}
    try {{
        $parameters=@{{InputPath='{source}';OutputPath=$output;ApplicationRoot='{PROJECT_ROOT}'}}
        & '{TOOLS / "export-pdf-with-wps.ps1"}' @parameters
        exit 1
    }} catch {{ if ($_.Exception.Message -notlike '*WPS is already running*') {{ throw }} }}
    $after=@(Get-Process -Name wps -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
    if (@(Compare-Object $before $after).Count -ne 0) {{ exit 1 }}
    if (Test-Path -LiteralPath $output) {{ exit 1 }}
$afterTasks=@(Get-ChildItem -LiteralPath $taskRoot -Directory -ErrorAction SilentlyContinue).Count
if ($afterTasks -ne $beforeTasks) {{ exit 1 }}
    """)
    if "NO_ACTIVE_SESSION" in result.stdout:
        pytest.skip("No user session; this test never launches WPS")
    assert result.returncode == 0, result.stdout + result.stderr
