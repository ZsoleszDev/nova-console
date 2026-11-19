param([Parameter(Mandatory=$true)][string]$NovaExe,[Parameter(Mandatory=$true)][int]$NovaPid)
$ErrorActionPreference = 'Stop'
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'Recall.cs') -ReferencedAssemblies @('System.dll','System.Core.dll')
    [Nova.Recall]::Run($NovaExe, $NovaPid)
} catch {
    exit 1
}
