$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$novaTemp = $null
$appBackup = $null
$installedApp = $null
try {
    if (-not [Environment]::Is64BitOperatingSystem) { throw 'A NOVA 64 bites Windows 10 vagy 11 rendszert igényel.' }
    $target = Join-Path $env:LOCALAPPDATA 'Programs\NOVA'
    $exe = Join-Path $target 'NOVA.exe'
    $running = @(Get-Process -Name 'NOVA' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe })
    if ($running.Count -gt 0) { throw 'Előbb teljesen lépj ki a NOVA-ból a Gyorsmenü > Kilépés ponttal, majd futtasd újra ezt a telepítőt.' }
    $appSource = Join-Path $PSScriptRoot 'app'
    if (-not (Test-Path -LiteralPath (Join-Path $appSource 'dist\index.html'))) { throw 'Előbb csomagold ki a ZIP teljes tartalmát, majd onnan futtasd a Telepites.cmd fájlt.' }
    $novaTemp = Join-Path ([IO.Path]::GetTempPath()) ('NOVA-install-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $novaTemp | Out-Null
    $versionFile = Join-Path $target 'version'
    $reuse = (Test-Path -LiteralPath $exe) -and (Test-Path -LiteralPath $versionFile)
    if ($reuse) { $reuse = (Get-Content -LiteralPath $versionFile -Raw).Trim() -eq '45.3.2' }
    Write-Host 'NOVA 1.11.2 telepítő / frissítő – Windows x64' -ForegroundColor Green
    if ($reuse) {
        Write-Host 'Meglévő futtatókörnyezet felismerve. Az alkalmazás frissítése...'
        $newApp = Join-Path $target ('resources\app-new-' + [guid]::NewGuid().ToString('N'))
        Copy-Item -LiteralPath $appSource -Destination $newApp -Recurse
        $installedApp = Join-Path $target 'resources\app'
        $appBackup = Join-Path $target ('resources\app-backup-' + [guid]::NewGuid().ToString('N'))
        if (Test-Path -LiteralPath $installedApp) { Move-Item -LiteralPath $installedApp -Destination $appBackup }
        Move-Item -LiteralPath $newApp -Destination $installedApp
    } else {
        if (Test-Path -LiteralPath $target) { throw "Másik futtatókörnyezet vagy hiányos telepítés található itt: $target . Nevezd át biztonsági másolatként, majd próbáld újra. A játéktár a külön AppData mappában marad." }
        $zip = Join-Path $novaTemp 'electron.zip'
        $stage = Join-Path $novaTemp 'NOVA'
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        Write-Host 'Hivatalos Electron futtatókörnyezet letöltése a GitHubról (kb. 150 MB)...'
        Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/electron/electron/releases/download/v45.3.2/electron-v45.3.2-win32-x64.zip' -OutFile $zip
        $expected = 'cd1ab0d49c2f76838c0c9ff75afefb4d9d85ca59036691932bf35be8eceba98b'
        if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'A letöltés ellenőrzőösszege eltér. Nem telepítünk; próbáld újra.' }
        Expand-Archive -LiteralPath $zip -DestinationPath $stage
        Remove-Item -LiteralPath (Join-Path $stage 'resources\default_app.asar') -ErrorAction SilentlyContinue
        Rename-Item -LiteralPath (Join-Path $stage 'electron.exe') -NewName 'NOVA.exe'
        Copy-Item -LiteralPath $appSource -Destination (Join-Path $stage 'resources\app') -Recurse
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        Move-Item -LiteralPath $stage -Destination $target
    }
    foreach ($name in @('OLVASS-EL.txt', 'THIRD-PARTY-NOTICES.txt', 'ELLENORZES.txt', 'nova.ico')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $target $name) -Force
    }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'licenses') -Destination $target -Recurse -Force
    $shell = New-Object -ComObject WScript.Shell
    $startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'NOVA'
    New-Item -ItemType Directory -Path $startMenu -Force | Out-Null
    foreach ($location in @((Join-Path $startMenu 'NOVA.lnk'), (Join-Path ([Environment]::GetFolderPath('Desktop')) 'NOVA.lnk'))) {
        $shortcut = $shell.CreateShortcut($location)
        $shortcut.TargetPath = $exe
        $shortcut.WorkingDirectory = $target
        $shortcut.IconLocation = (Join-Path $target 'nova.ico') + ',0'
        $shortcut.Description = 'NOVA – a te játéktered'
        $shortcut.Save()
    }
    foreach ($location in @((Join-Path $startMenu 'NOVA – Mód választása.lnk'), (Join-Path ([Environment]::GetFolderPath('Desktop')) 'NOVA – Mód választása.lnk'))) {
        $shortcut = $shell.CreateShortcut($location)
        $shortcut.TargetPath = $exe
        $shortcut.Arguments = '--mode-picker'
        $shortcut.WorkingDirectory = $target
        $shortcut.IconLocation = (Join-Path $target 'nova.ico') + ',0'
        $shortcut.Description = 'Konzol, Jarvis vagy Windows mód választása'
        $shortcut.Save()
    }
    if ($appBackup -and (Test-Path -LiteralPath $appBackup)) { Remove-Item -LiteralPath $appBackup -Recurse -Force -ErrorAction SilentlyContinue }
    Write-Host 'Kész! Indítsd a NOVA parancsikont. A Konzol mód a Beállításokban és a Gyorsmenüben kapcsolható.' -ForegroundColor Green
    Write-Host 'Új: módválasztó (Konzol / Jarvis / Windows). Bejelentkezéskor magától megjelenik; most a NOVA – Mód választása parancsikonnal, futó NOVA mellett a Ctrl+Alt+M billentyűkkel nyitható meg.'
    Write-Host 'A játéktár, a beállítások és az automatikus indulás beállítása megmaradt.'
    Write-Host 'A Disney+, HBO Max és YouTube kontrolleres kezeléséhez Microsoft Edge és XInput-kompatibilis kontroller szükséges.'
} catch {
    if ($appBackup -and (Test-Path -LiteralPath $appBackup)) {
        if ($installedApp -and (Test-Path -LiteralPath $installedApp)) { Remove-Item -LiteralPath $installedApp -Recurse -Force -ErrorAction SilentlyContinue }
        Move-Item -LiteralPath $appBackup -Destination $installedApp -ErrorAction SilentlyContinue
    }
    Write-Host "Telepítési hiba: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    if ($novaTemp -and (Test-Path -LiteralPath $novaTemp)) { Remove-Item -LiteralPath $novaTemp -Recurse -Force -ErrorAction SilentlyContinue }
}
