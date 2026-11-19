param([Parameter(Mandatory=$true)][string]$Mode,[Parameter(Mandatory=$true)][string]$Target)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function SteamDirectory([string]$Id) {
    $roots = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($folder in @(${env:PROGRAMFILES(X86)},$env:PROGRAMFILES)) { if ($folder) { [void]$roots.Add((Join-Path $folder 'Steam')) } }
    try { $steamRoot=(Get-ItemProperty 'HKCU:\Software\Valve\Steam' -ErrorAction Stop).SteamPath;if($steamRoot){[void]$roots.Add($steamRoot)} } catch {}
    foreach ($root in @($roots)) {
        $libraryFile = Join-Path $root 'steamapps\libraryfolders.vdf'
        if (Test-Path -LiteralPath $libraryFile) {
            foreach ($match in [regex]::Matches([IO.File]::ReadAllText($libraryFile),'"path"\s+"([^"\r\n]+)"')) { [void]$roots.Add($match.Groups[1].Value.Replace('\\','\')) }
        }
    }
    foreach ($root in $roots) {
        $manifest = Join-Path $root ('steamapps\appmanifest_' + $Id + '.acf')
        if (-not (Test-Path -LiteralPath $manifest)) { continue }
        $match = [regex]::Match([IO.File]::ReadAllText($manifest),'"installdir"\s+"([^"\r\n]+)"')
        if (-not $match.Success) { continue }
        $common = [IO.Path]::GetFullPath((Join-Path $root 'steamapps\common'))
        $directory = [IO.Path]::GetFullPath((Join-Path $common $match.Groups[1].Value))
        if ($directory.StartsWith($common.TrimEnd('\') + '\',[StringComparison]::OrdinalIgnoreCase)) { return $directory }
    }
    return ''
}
try {
    $kind='unknown';$destination='';$directory=''
    if ($Mode -eq 'steam' -and $Target -match '^\d{1,12}$') { $kind='steam';$destination=$Target }
    elseif ($Mode -eq 'file') {
        $extension=[IO.Path]::GetExtension($Target).ToLowerInvariant()
        $arguments=''
        if ($extension -eq '.lnk') {
            $shell=New-Object -ComObject WScript.Shell
            $shortcut=$shell.CreateShortcut($Target)
            $destination=[string]$shortcut.TargetPath;$arguments=[string]$shortcut.Arguments
            if ([IO.Path]::GetExtension($destination) -eq '.exe') { $kind='exe' }
        } elseif ($extension -eq '.url' -and (Get-Item -LiteralPath $Target).Length -lt 1048576) { $arguments=[IO.File]::ReadAllText($Target) }
        $match=[regex]::Match($arguments,'(?i)steam://(?:rungameid|run)/(\d{1,12})|(?:^|\s)-applaunch\s+(\d{1,12})(?:\s|$)')
        if ($match.Success) { $kind='steam';$destination=if($match.Groups[1].Success){$match.Groups[1].Value}else{$match.Groups[2].Value} }
    }
    if ($kind -eq 'steam') { $directory=SteamDirectory $destination }
    @{kind=$kind;target=$destination;directory=$directory} | ConvertTo-Json -Compress
} catch { '{"kind":"unknown","target":"","directory":""}' }
