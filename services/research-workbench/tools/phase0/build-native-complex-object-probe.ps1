param(
    [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
    [string]$OutputDirectory = "",
    [string]$WpsProgId = "KWPS.Application"
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'path-guards.ps1')
if (@(Get-Process -Name 'wps' -ErrorAction SilentlyContinue).Count -gt 0) {
    throw 'WPS is already running; no fixture session was attached.'
}
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $ProjectRoot "var\native-complex-probe"
}
$resolvedProjectRoot = Get-PlainFileSystemPath $ProjectRoot
$authorRoot = Get-AuthorInputRoot $resolvedProjectRoot
$outputDirectory = Assert-OwnedOutputPath $OutputDirectory $resolvedProjectRoot @($authorRoot)
New-Item -ItemType Directory -Path $outputDirectory | Out-Null

$olePayload = Join-Path $outputDirectory "rfw-ole-payload.txt"
Set-Content -LiteralPath $olePayload -Value "RFW-FX-EO-OLE-PAYLOAD-001" -Encoding utf8
$outputDocx = Join-Path $outputDirectory "native-complex-object-probe.docx"

$application = $null
$document = $null
try {
    $application = New-Object -ComObject $WpsProgId
    if ($application.Documents.Count -ne 0) {
        throw "The WPS automation session already has open documents."
    }
    $document = $application.Documents.Add()
    $document.Range().Text = "RFW Native Complex Object Probe`r`n"

    $chartRange = $document.Range($document.Content.End - 1, $document.Content.End - 1)
    $chartRange.Text = "RFW-FX-EO-CHART-ANCHOR-001`r`n"
    $chart = $document.InlineShapes.AddChart(51, $chartRange)
    $chart.AlternativeText = "RFW-FX-EO-CHART-001"
    $chart.Title = "RFW-FX-EO-CHART-001"

    $oleRange = $document.Range($document.Content.End - 1, $document.Content.End - 1)
    $oleRange.Text = "RFW-FX-EO-OLE-ANCHOR-001`r`n"
    $ole = $document.InlineShapes.AddOLEObject(
        $null,
        $olePayload,
        $false,
        $true,
        $null,
        0,
        "RFW-FX-EO-OLE-001",
        $oleRange
    )
    $ole.AlternativeText = "RFW-FX-EO-OLE-001"

    $breakRange = $document.Range($document.Content.End - 1, $document.Content.End - 1)
    $breakRange.InsertBreak(7)
    $shapeAnchor = $document.Range($document.Content.End - 1, $document.Content.End - 1)
    $shapeAnchor.Text = "RFW-FX-EO-GROUP-ANCHOR-001`r`n"

    $shapeA = $document.Shapes.AddShape(1, 72, 120, 180, 60, $shapeAnchor)
    $shapeA.TextFrame.TextRange.Text = "RFW-FX-EO-GROUP-SHAPE-A-001"
    $shapeA.Name = "RFW-FX-EO-GROUP-SHAPE-A-001"
    $shapeB = $document.Shapes.AddShape(1, 300, 120, 180, 60, $shapeAnchor)
    $shapeB.TextFrame.TextRange.Text = "RFW-FX-EO-GROUP-SHAPE-B-001"
    $shapeB.Name = "RFW-FX-EO-GROUP-SHAPE-B-001"
    $shapeRange = $document.Shapes.Range(@($shapeA.Name, $shapeB.Name))
    $group = $shapeRange.Group()
    $group.Name = "RFW-FX-EO-GROUP-001"
    $group.AlternativeText = "RFW-FX-EO-GROUP-001"

    $null = Assert-OwnedOutputPath $outputDocx $resolvedProjectRoot @($authorRoot)
    $document.SaveAs2($outputDocx, 16)
}
finally {
    if ($null -ne $document) {
        $document.Close($false)
    }
    if ($null -ne $application) {
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($application)
    }
}

[ordered]@{
    report_version = "1.0.0"
    output_path = $outputDocx.Replace('\', '/')
    output_sha256 = (Get-FileHash -LiteralPath $outputDocx -Algorithm SHA256).Hash.ToLowerInvariant()
    ole_payload_sha256 = (Get-FileHash -LiteralPath $olePayload -Algorithm SHA256).Hash.ToLowerInvariant()
} | ConvertTo-Json -Depth 4
