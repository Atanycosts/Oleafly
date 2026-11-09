# Verify the process owning the COM window, not a configured file alone.
# Window.Hwnd is documented by WPS; unavailable support on the installed build fails closed.
# https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/wps/Window/obj
# https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-getwindowthreadprocessid
function Assert-WpsIdentity {
    param($Expected, $Actual)
    if (-not ([IO.Path]::GetFullPath($Actual.path)).Equals(
        [IO.Path]::GetFullPath($Expected.executable_path), [StringComparison]::OrdinalIgnoreCase
    ) -or $Actual.sha256 -ne $Expected.executable_sha256 -or
        $Actual.version -ne $Expected.file_version) {
        throw 'The actual WPS instance does not match the pinned renderer path, hash and version.'
    }
}

function Get-WpsInstanceIdentity {
    param([Parameter(Mandatory = $true)]$Window)
    if (-not ('RfwWindowProcess' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RfwWindowProcess {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
}
'@
    }
    $windowHandle = [IntPtr]([long]$Window.Hwnd)
    [uint32]$ownerProcessId = 0
    $threadId = [RfwWindowProcess]::GetWindowThreadProcessId($windowHandle, [ref]$ownerProcessId)
    if ($windowHandle -eq [IntPtr]::Zero -or $threadId -eq 0 -or $ownerProcessId -eq 0) {
        throw 'Cannot identify the process owning the WPS instance; no document opened.'
    }
    $process = Get-Process -Id $ownerProcessId -ErrorAction Stop
    $path = $process.Path
    if ([string]::IsNullOrWhiteSpace($path)) { throw 'WPS process executable path is unavailable.' }
    $executable = Get-Item -LiteralPath $path -ErrorAction Stop
    return [pscustomobject]@{
        process_id = $ownerProcessId
        start_time_utc = $process.StartTime.ToUniversalTime().ToString('o')
        path = $executable.FullName
        sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        version = $executable.VersionInfo.FileVersion.Replace(',', '.').Replace(' ', '')
    }
}
