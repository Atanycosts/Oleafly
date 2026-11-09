"""Exercise page-export and fixture-output boundaries without starting Office."""

import json
import os
import struct
import subprocess
import sys
import zlib
from pathlib import Path

import pytest
from powershell_runner import run_powershell

from research_file_workbench.common.hashing import sha256_file

PROJECT_ROOT = Path(__file__).resolve().parents[2]
TOOLS = PROJECT_ROOT / "tools/phase0"
pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows PowerShell render boundaries")


def _powershell(
    script: str, paths: dict[str, Path], **values: str
) -> subprocess.CompletedProcess[str]:
    environment = os.environ | {key: str(value) for key, value in paths.items()} | values
    environment["PYTHONPATH"] = "preserved-test-value"
    environment["PATH"] = str(Path(sys.executable).parent) + os.pathsep + environment["PATH"]
    return run_powershell(script, env_overrides=environment)


def _prepare_project(tmp_path: Path) -> tuple[Path, Path]:
    application = tmp_path / "application"
    author = tmp_path / "author"
    author.mkdir()
    contracts = application / "contracts/phase0"
    contracts.mkdir(parents=True)
    (contracts / "source-catalog.json").write_text(
        json.dumps({"author_workspace_root": str(author)}), encoding="utf-8"
    )
    return application, author


def test_fixture_render_refuses_junction_before_creating_author_directory(tmp_path: Path) -> None:
    application, author = _prepare_project(tmp_path)
    (application / "contracts/phase0/docx-fixture-catalog.json").write_text(
        json.dumps({"fixtures": [{"sample_id": "sample", "relative_path": "unused.docx"}]}),
        encoding="utf-8",
    )
    parent = application / "reports/phase0"
    parent.mkdir(parents=True)
    link = parent / "fixtures"
    result = _powershell(
        r"""
$ErrorActionPreference='Stop'
New-Item -ItemType Junction -Path $env:RFW_TEST_LINK -Target $env:RFW_TEST_AUTHOR | Out-Null
try {
    & $env:RFW_TEST_SCRIPT -ProjectRoot $env:RFW_TEST_APPLICATION
} finally {
    [IO.Directory]::Delete($env:RFW_TEST_LINK)
}
""",
        {
            "RFW_TEST_LINK": link,
            "RFW_TEST_AUTHOR": author,
            "RFW_TEST_APPLICATION": application,
            "RFW_TEST_SCRIPT": TOOLS / "render-docx-fixtures.ps1",
        },
    )
    assert result.returncode != 0
    assert "Reparse-point" in result.stderr
    assert list(author.iterdir()) == []


def _png() -> bytes:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + kind
            + payload
            + struct.pack(">I", zlib.crc32(kind + payload))
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(b"\x00\xff\xff\xff"))
        + chunk(b"IEND", b"")
    )


@pytest.mark.parametrize(
    "mode", ["success", "source-change", "truncated-png", "missing-page", "wrong-page-number"]
)
def test_page_export_validates_source_and_complete_decodable_pages(
    tmp_path: Path, mode: str
) -> None:
    application, author = _prepare_project(tmp_path)
    source = author / "source.pdf"
    fixture = (
        PROJECT_ROOT
        / "reports/phase0/fixtures/s1-native-complex-objects/s1-native-complex-objects.pdf"
    )
    source.write_bytes(fixture.read_bytes())
    original_hash = sha256_file(source)
    image = application / "expected.png"
    image.write_bytes(_png())
    output = application / "pages"
    result = _powershell(
        r"""
function pdftoppm {
    $first = Join-Path $env:RFW_TEST_OUTPUT 'page-1.png'
    Copy-Item -LiteralPath $env:RFW_TEST_PNG -Destination $first
    if ($env:RFW_TEST_MODE -ne 'missing-page') {
        $number = if ($env:RFW_TEST_MODE -eq 'wrong-page-number') { 3 } else { 2 }
        $destination = Join-Path $env:RFW_TEST_OUTPUT "page-$number.png"
        Copy-Item -LiteralPath $env:RFW_TEST_PNG -Destination $destination
    }
    if ($env:RFW_TEST_MODE -eq 'source-change') {
        [IO.File]::WriteAllBytes($env:RFW_TEST_SOURCE,[Text.Encoding]::UTF8.GetBytes('changed PDF'))
    }
    if ($env:RFW_TEST_MODE -eq 'truncated-png') {
        [IO.File]::WriteAllBytes($first,[byte[]](137,80,78,71,13,10,26,10))
    }
    $global:LASTEXITCODE = 0
}
& $env:RFW_TEST_SCRIPT -InputPdf $env:RFW_TEST_SOURCE `
    -OutputDirectory $env:RFW_TEST_OUTPUT -ApplicationRoot $env:RFW_TEST_APPLICATION
if ($env:PYTHONPATH -ne 'preserved-test-value') { throw 'PYTHONPATH was not restored' }
""",
        {
            "RFW_TEST_APPLICATION": application,
            "RFW_TEST_SOURCE": source,
            "RFW_TEST_OUTPUT": output,
            "RFW_TEST_PNG": image,
            "RFW_TEST_SCRIPT": TOOLS / "render-pdf-pages.ps1",
        },
        RFW_TEST_MODE=mode,
    )
    if mode == "success":
        assert result.returncode == 0, result.stdout + result.stderr
        record = json.loads(result.stdout)
        assert record["page_count"] == 2
        assert record["input_pdf_sha256"] == original_hash
        assert [page["page_number"] for page in record["pages"]] == [1, 2]
        assert all(page["width"] == page["height"] == 1 for page in record["pages"])
    else:
        assert result.returncode != 0
        assert not result.stdout.strip()
        expected = "Input PDF changed" if mode == "source-change" else "inspection failed"
        assert expected in result.stderr
    if mode != "source-change":
        assert sha256_file(source) == original_hash
    assert sorted(path.name for path in author.iterdir()) == ["source.pdf"]
