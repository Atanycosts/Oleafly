param(
    [Parameter(Mandatory = $true)][string]$InputPath,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [Parameter(Mandatory = $true)][string]$ApplicationRoot,
    [string]$RenderProfileId = 'wps-writer-12.1.0.28505'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'path-guards.ps1')
. (Join-Path $PSScriptRoot 'wps-identity.ps1')
$resolvedRoot = Get-PlainFileSystemPath $ApplicationRoot
$authorRoot = Get-AuthorInputRoot $resolvedRoot
$resolvedOutput = Assert-OwnedOutputPath $OutputPath $resolvedRoot @($authorRoot)
$resolvedInput = (Resolve-Path -LiteralPath $InputPath).Path
$profilePath = Join-Path $resolvedRoot 'contracts\phase0\render-environments.json'
$renderProfiles = (Get-Content -LiteralPath $profilePath -Raw -Encoding UTF8 | ConvertFrom-Json).profiles
$selectedProfiles = @($renderProfiles | Where-Object { $_.profile_id -eq $RenderProfileId })
if ($selectedProfiles.Count -ne 1) { throw 'Expected exactly one pinned renderer profile.' }
$renderProfile = $selectedProfiles[0]
if (@(Get-Process -Name 'wps' -ErrorAction SilentlyContinue).Count -gt 0) {
    throw 'WPS is already running. Close it yourself before a controlled render; no session was attached.'
}
$executable = Get-Item -LiteralPath $renderProfile.executable_path
Assert-WpsIdentity $renderProfile ([pscustomobject]@{
    path = $executable.FullName
    sha256 = (Get-FileHash -LiteralPath $executable.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    version = $executable.VersionInfo.FileVersion.Replace(',', '.').Replace(' ', '')
})

$taskId = [Guid]::NewGuid().ToString('N')
$taskRoot = Assert-OwnedOutputPath (Join-Path $resolvedRoot "var\render-tasks\$taskId") $resolvedRoot @($authorRoot)
New-Item -ItemType Directory -Path $taskRoot | Out-Null
$renderCopy = Assert-OwnedOutputPath (Join-Path $taskRoot ([IO.Path]::GetFileName($resolvedInput))) $resolvedRoot @($authorRoot)
$sourceHashBefore = (Get-FileHash -LiteralPath $resolvedInput -Algorithm SHA256).Hash.ToLowerInvariant()
Copy-Item -LiteralPath $resolvedInput -Destination $renderCopy
$copyHash = (Get-FileHash -LiteralPath $renderCopy -Algorithm SHA256).Hash.ToLowerInvariant()
if ($sourceHashBefore -ne $copyHash) { throw 'Render copy hash does not match source.' }

$application = $null
$document = $null
$identityProbe = $null
$instance = $null
$automationStarted = [DateTime]::UtcNow
try {
    if (@(Get-Process -Name 'wps' -ErrorAction SilentlyContinue).Count -gt 0) {
        throw 'WPS started concurrently; rendering was not started.'
    }
    $application = New-Object -ComObject $renderProfile.required_settings.pdf_export_settings.automation
    if ($application.Documents.Count -ne 0) {
        throw 'WPS COM connected to a session containing documents; no input opened.'
    }
    # A new unsaved blank document exposes the documented Window.Hwnd property.
    # It contains no author input and is closed without saving after identity checks.
    $identityProbe = $application.Documents.Add()
    $instance = Get-WpsInstanceIdentity ($identityProbe.Windows.Item(1))
    Assert-WpsIdentity $renderProfile $instance
    if ([DateTime]::Parse($instance.start_time_utc).ToUniversalTime() -lt $automationStarted -or
        $application.Documents.Count -ne 1) {
        throw 'The WPS instance is not an empty newly started session; rendering refused.'
    }
    $identityProbe.Close($false)
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($identityProbe)
    $identityProbe = $null
    $document = $application.Documents.Open($renderCopy, $false, $true)
    $null = Assert-OwnedOutputPath $resolvedOutput $resolvedRoot @($authorRoot)
    $currentInstance = Get-WpsInstanceIdentity ($document.Windows.Item(1))
    Assert-WpsIdentity $renderProfile $currentInstance
    if ($currentInstance.process_id -ne $instance.process_id -or
        $currentInstance.start_time_utc -ne $instance.start_time_utc) {
        throw 'WPS process identity changed before export.'
    }
    $document.ExportAsFixedFormat($resolvedOutput, 17)
}
finally {
    if ($null -ne $identityProbe) {
        $identityProbe.Close($false)
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($identityProbe)
    }
    if ($null -ne $document) {
        $document.Close($false)
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($document)
    }
    # Never quit an application process: ownership does not authorize closing user sessions.
    if ($null -ne $application) {
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($application)
    }
    $sourceHashAfter = (Get-FileHash -LiteralPath $resolvedInput -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($sourceHashBefore -ne $sourceHashAfter) { throw 'Source changed during rendering.' }
}

$null = Assert-OwnedOutputPath $resolvedOutput $resolvedRoot @($authorRoot) -AllowExisting
if (-not (Test-Path -LiteralPath $resolvedOutput -PathType Leaf)) { throw 'WPS produced no PDF.' }
[ordered]@{
    report_version = '1.1.0'
    source_path = $resolvedInput.Replace('\', '/')
    source_sha256 = $sourceHashAfter
    render_copy_path = $renderCopy.Replace('\', '/')
    render_copy_sha256 = $copyHash
    output_path = $resolvedOutput.Replace('\', '/')
    output_sha256 = (Get-FileHash -LiteralPath $resolvedOutput -Algorithm SHA256).Hash.ToLowerInvariant()
    output_size = (Get-Item -LiteralPath $resolvedOutput).Length
    render_profile_id = $RenderProfileId
    renderer_path = $instance.path.Replace('\', '/')
    renderer_sha256 = $instance.sha256
    renderer_file_version = $instance.version
    renderer_process_id = $instance.process_id
    renderer_start_time_utc = $instance.start_time_utc
    renderer_identity_status = 'process_verified'
    export_method = 'COM window -> process identity; Documents.Open(readOnly=true); ExportAsFixedFormat(17)'
    source_unchanged = $true
    task_id = $taskId
    application_exit_requested = $false
} | ConvertTo-Json -Depth 4
