param([Parameter(Mandatory=$true)][string]$DashboardHandle,[Parameter(Mandatory=$true)][int]$NovaPid)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
    Add-Type -Path @((Join-Path $PSScriptRoot 'ConsoleHost.cs'),(Join-Path $PSScriptRoot 'CoreAudio.cs'),(Join-Path $PSScriptRoot 'CursorHide.cs')) -ReferencedAssemblies @('System.dll','System.Core.dll')
    [Nova.ConsoleHost]::Run($DashboardHandle,$NovaPid)
} catch {
    [Console]::Out.WriteLine('{"type":"error","message":"Az automatikus visszatérés nem indult el. A Ctrl+Alt+N gyorsbillentyűvel továbbra is visszahívhatod a NOVA-t."}')
    exit 1
}
