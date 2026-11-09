param(
    [Parameter(Mandatory = $true)]
    [string]$InputPdf,

    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,

    [Parameter(Mandatory = $true)]
    [string]$ApplicationRoot,

    [int]$Dpi = 150
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'path-guards.ps1')
$resolvedInput = (Resolve-Path -LiteralPath $InputPdf).Path
$resolvedApplicationRoot = Get-PlainFileSystemPath $ApplicationRoot
$authorRoot = Get-AuthorInputRoot $resolvedApplicationRoot
$resolvedOutput = Assert-OwnedOutputPath $OutputDirectory $resolvedApplicationRoot @($authorRoot)
if ($Dpi -le 0) { throw 'DPI must be positive.' }
$sourceHashBefore = (Get-FileHash -LiteralPath $resolvedInput -Algorithm SHA256).Hash.ToLowerInvariant()

New-Item -ItemType Directory -Path $resolvedOutput | Out-Null
$prefix = Join-Path $resolvedOutput "page"
$null = Assert-OwnedOutputPath $resolvedOutput $resolvedApplicationRoot @($authorRoot) -AllowExisting
try {
    & pdftoppm -png -r $Dpi $resolvedInput $prefix
    if ($LASTEXITCODE -ne 0) {
        throw "pdftoppm failed with exit code $LASTEXITCODE"
    }
}
finally {
    $sourceHashAfter = (Get-FileHash -LiteralPath $resolvedInput -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($sourceHashBefore -ne $sourceHashAfter) { throw 'Input PDF changed during page rendering.' }
}

$pythonPathBefore = $env:PYTHONPATH
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\src'))
try {
    $env:PYTHONPATH = if ([string]::IsNullOrEmpty($pythonPathBefore)) {
        $sourceRoot
    } else {
        $sourceRoot + [IO.Path]::PathSeparator + $pythonPathBefore
    }
    $inspection = & python (Join-Path $PSScriptRoot 'inspect_rendered_pages.py') `
        --input-pdf $resolvedInput --output-directory $resolvedOutput --source-sha256 $sourceHashBefore
    if ($LASTEXITCODE -ne 0) { throw 'Rendered page inspection failed; no successful page record was produced.' }
} finally {
    $env:PYTHONPATH = $pythonPathBefore
}
$verified = $inspection | ConvertFrom-Json
if ($null -eq $verified -or $verified.source_sha256 -ne $sourceHashBefore) {
    throw 'Rendered page inspection returned an invalid source binding.'
}

[ordered]@{
    report_version = "1.0.0"
    input_pdf = $resolvedInput.Replace('\', '/')
    input_pdf_sha256 = $sourceHashBefore
    output_directory = $resolvedOutput.Replace('\', '/')
    dpi = $Dpi
    page_count = $verified.page_count
    pages = $verified.pages
} | ConvertTo-Json -Depth 5
