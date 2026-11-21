param([Parameter(Mandatory=$true)][string]$NovaExe,[Parameter(Mandatory=$true)][int]$NovaPid,[int]$Parsec=1,[string]$LogFile='',[int]$Cursor=1)
$ErrorActionPreference = 'Stop'
try {
    Add-Type -Path @((Join-Path $PSScriptRoot 'Recall.cs'),(Join-Path $PSScriptRoot 'CursorHide.cs')) -ReferencedAssemblies @('System.dll','System.Core.dll')
    try { [Nova.Recall]::Run($NovaExe, $NovaPid, $Parsec -eq 1, $LogFile, $Cursor -eq 1) } finally { [Nova.CursorHide]::Show() }
} catch {
    if ($LogFile) {
        try { [IO.File]::AppendAllText($LogFile, (Get-Date -Format 'yyyy. MM. dd. H:mm:ss') + '  figyelő  nem indult: ' + $_.Exception.Message + "`r`n") } catch {}
    }
    exit 1
}
