param()
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
# Names and types only: no IsReady, volume-label or network-drive probe.
$drives = @([System.IO.DriveInfo]::GetDrives() | ForEach-Object {
    [pscustomobject]@{ path = $_.Name; kind = $_.DriveType.ToString() }
})
ConvertTo-Json -InputObject $drives -Compress
