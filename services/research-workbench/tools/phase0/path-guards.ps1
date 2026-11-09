# Guard the Phase 0 producers; this is not an OS sandbox against concurrent directory swaps.
function Get-PlainFileSystemPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $absolute = [IO.Path]::GetFullPath($Path)
    $current = $absolute
    while (-not [string]::IsNullOrEmpty($current)) {
        if (Test-Path -LiteralPath $current) {
            $entry = Get-Item -Force -LiteralPath $current -ErrorAction Stop
            if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Reparse-point paths are not permitted for application output: $current"
            }
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }
        $current = $parent
    }
    if ($absolute.Substring([IO.Path]::GetPathRoot($absolute).Length).Contains(':')) {
        throw "Alternate data streams are not permitted: $absolute"
    }
    return $absolute
}

function Assert-OwnedOutputPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ApplicationRoot,
        [string[]]$ForbiddenRoots = @(),
        [switch]$AllowExisting
    )
    $root = (Get-PlainFileSystemPath $ApplicationRoot).TrimEnd('\')
    $output = Get-PlainFileSystemPath $Path
    if (-not $output.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Output must be a child of application storage: $root"
    }
    foreach ($forbidden in $ForbiddenRoots) {
        $blocked = [IO.Path]::GetFullPath($forbidden).TrimEnd('\')
        if ($output.Equals($blocked, [StringComparison]::OrdinalIgnoreCase) -or
            $output.StartsWith($blocked + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw "Output would enter a read-only input directory: $blocked"
        }
    }
    if (-not $AllowExisting -and (Test-Path -LiteralPath $output)) {
        throw "Output already exists: $output"
    }
    return $output
}

function Get-AuthorInputRoot {
    param([Parameter(Mandatory = $true)][string]$ApplicationRoot)
    $catalogPath = Join-Path $ApplicationRoot 'contracts\phase0\source-catalog.json'
    $catalog = Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace($catalog.author_workspace_root)) {
        throw 'Source catalog must identify the read-only author root.'
    }
    return [IO.Path]::GetFullPath($catalog.author_workspace_root)
}
