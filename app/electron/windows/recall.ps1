param([Parameter(Mandatory=$true)][string]$NovaExe,[Parameter(Mandatory=$true)][int]$NovaPid,[int]$Parsec=1)
$ErrorActionPreference = 'Stop'
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'Recall.cs') -ReferencedAssemblies @('System.dll','System.Core.dll')
    [Nova.Recall]::Run($NovaExe, $NovaPid, $Parsec -eq 1)
} catch {
    exit 1
}
