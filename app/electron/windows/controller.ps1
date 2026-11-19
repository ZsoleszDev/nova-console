param([Parameter(Mandatory=$true)][int]$BrowserPid, [Parameter(Mandatory=$true)][string]$BrowserProfile, [Parameter(Mandatory=$true)][int]$NovaPid, [Parameter(Mandatory=$true)][long]$DashboardHandle, [Parameter(Mandatory=$true)][string]$BrowserExe)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type -AssemblyName WindowsBase
    Add-Type -AssemblyName System.Management
    Add-Type -Path @((Join-Path $PSScriptRoot 'Controller.cs'), (Join-Path $PSScriptRoot 'MediaNavigation.cs')) -ReferencedAssemblies @('System.dll','System.Core.dll','System.Management.dll',[System.Windows.Automation.AutomationElement].Assembly.Location,[System.Windows.Automation.ControlType].Assembly.Location,[System.Windows.Rect].Assembly.Location)
    [Nova.MediaController]::Run($BrowserPid, $NovaPid, $DashboardHandle, $BrowserProfile, $BrowserExe)
} catch {
    [Console]::Out.WriteLine('{"type":"error","message":"A Windowsos kontrollersegéd nem indult el. USB-s Xbox-kompatibilis kontrollerrel és friss Windows PowerShell 5.1-gyel próbáld újra."}')
    exit 1
}
