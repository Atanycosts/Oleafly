param(
    [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
    [int]$Dpi = 150
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'path-guards.ps1')
$ProjectRoot = Get-PlainFileSystemPath $ProjectRoot
$authorRoot = Get-AuthorInputRoot $ProjectRoot
if ($Dpi -le 0) { throw 'DPI must be positive.' }
$catalogPath = Join-Path $ProjectRoot "contracts\phase0\docx-fixture-catalog.json"
$catalog = Get-Content -Raw -LiteralPath $catalogPath | ConvertFrom-Json
$records = @()

foreach ($fixture in $catalog.fixtures) {
    if ($fixture.sample_id -notmatch '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$') {
        throw 'Fixture sample ID must use kebab-case without path separators.'
    }
    if ($fixture.sample_id -eq "s1-broken-relationships") {
        continue
    }

    $relativeInput = $fixture.relative_path.Replace('/', '\')
    $inputPath = Join-Path $ProjectRoot "tests\fixtures\docx\$relativeInput"
    $outputDirectory = Join-Path $ProjectRoot "reports\phase0\fixtures\$($fixture.sample_id)"
    $pdfPath = Join-Path $outputDirectory "$($fixture.sample_id).pdf"
    $pageDirectory = Join-Path $outputDirectory "pages-${Dpi}dpi"

    $outputDirectory = Assert-OwnedOutputPath $outputDirectory $ProjectRoot @($authorRoot)
    New-Item -ItemType Directory -Path $outputDirectory | Out-Null

    $renderRecord = & (Join-Path $PSScriptRoot "export-pdf-with-wps.ps1") `
        -InputPath $inputPath `
        -OutputPath $pdfPath `
        -ApplicationRoot $ProjectRoot
    $renderRecordPath = Assert-OwnedOutputPath (Join-Path $outputDirectory 'render-record.json') $ProjectRoot @($authorRoot)
    $renderRecord | Set-Content -LiteralPath $renderRecordPath -Encoding utf8

    $pageRecord = & (Join-Path $PSScriptRoot "render-pdf-pages.ps1") `
        -InputPdf $pdfPath `
        -OutputDirectory $pageDirectory `
        -ApplicationRoot $ProjectRoot `
        -Dpi $Dpi
    $pageRecordPath = Assert-OwnedOutputPath (Join-Path $outputDirectory 'page-record.json') $ProjectRoot @($authorRoot)
    $pageRecord | Set-Content -LiteralPath $pageRecordPath -Encoding utf8

    $records += [ordered]@{
        sample_id = $fixture.sample_id
        source_sha256 = $fixture.sha256
        pdf_path = $pdfPath.Replace('\', '/')
        page_directory = $pageDirectory.Replace('\', '/')
        status = "rendered"
    }
}

[ordered]@{
    report_version = "1.0.0"
    renderer_profile_id = "wps-writer-12.1.0.28505"
    dpi = $Dpi
    fixtures = $records
} | ConvertTo-Json -Depth 5
