param(
    [string]$Python = ''
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$originalPythonPath = $env:PYTHONPATH
$originalLocation = Get-Location

# The project declares runtime dependencies, so the gates must run in the environment that
# provides them. Falling back to a bare interpreter would silently verify a different set of
# packages than the one the project declares, so a missing environment is an error.
if (-not $Python) {
    $candidate = Join-Path $projectRoot '.venv\Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw "No virtual environment found at $candidate. Run: python -m venv .venv; uv pip install -e '.[dev,fixture-building]'"
    }
    $Python = $candidate
}

function Invoke-Verification {
    param([string[]]$Arguments)
    & $Python @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Verification failed (exit $LASTEXITCODE): $Python $($Arguments -join ' ')"
    }
}

# Nine tests in the suite skip on OSError when the process cannot create a symbolic link, and
# several of them are the reparse-point boundary tests. Whether that privilege is held varies
# by process on this machine, so it is probed explicitly: a skipped boundary test must never be
# readable as a passing one.
function Assert-SymbolicLinksAvailable {
    param([string]$ProbeRoot)
    New-Item -ItemType Directory -Path $ProbeRoot -Force | Out-Null
    $target = Join-Path $ProbeRoot 'target'
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    try {
        New-Item -ItemType SymbolicLink -Path (Join-Path $ProbeRoot 'link') -Target $target -ErrorAction Stop | Out-Null
    }
    catch {
        throw "This process cannot create symbolic links, so nine tests would skip instead of running. Re-run from a shell that holds SeCreateSymbolicLinkPrivilege. Underlying error: $_"
    }
}

try {
    Set-Location -LiteralPath $projectRoot
    $env:PYTHONPATH = Join-Path $projectRoot 'src'
    $testRoot = Join-Path $projectRoot ('var/verification-' + [Guid]::NewGuid().ToString('N'))
    Assert-SymbolicLinksAvailable -ProbeRoot (Join-Path $testRoot 'symlink-probe')
    Invoke-Verification -Arguments @('-m', 'ruff', 'format', '--check', '--no-cache', '.')
    Invoke-Verification -Arguments @('-m', 'ruff', 'check', '--no-cache', '.')
    Invoke-Verification -Arguments @('-m', 'mypy')
    Invoke-Verification -Arguments @('-m', 'pytest', '-rs', '--basetemp', $testRoot)
    Invoke-Verification -Arguments @('-m', 'research_file_workbench.phase0', 'validate')
    Write-Output 'All development gates passed.'
}
finally {
    $env:PYTHONPATH = $originalPythonPath
    Set-Location -LiteralPath $originalLocation.Path
}
