param([Parameter(Mandatory=$true)][string]$NovaExe,[Parameter(Mandatory=$true)][int]$NovaPid,[int]$Parsec=1,[string]$LogFile='')
$ErrorActionPreference = 'Stop'
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'Recall.cs') -ReferencedAssemblies @('System.dll','System.Core.dll')
    [Nova.Recall]::Run($NovaExe, $NovaPid, $Parsec -eq 1, $LogFile)
} catch {
    if ($LogFile) {
        try { [IO.File]::AppendAllText($LogFile, (Get-Date -Format 'yyyy. MM. dd. H:mm:ss') + '  figyelő  nem indult: ' + $_.Exception.Message + "`r`n") } catch {}
    }
    exit 1
}
