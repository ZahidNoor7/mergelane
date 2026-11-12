# Mergelane's Windows test kit (ADR-0054, docs/WINDOWS-TESTING.md).
#
# Runs on the owner's Windows laptop, in Windows PowerShell 5.1, which comes with Windows 10 and 11. Start it with
# "Run test kit.cmd" in the kit folder; scripts/windows/kit.mjs builds that folder on the Mac. It:
#   - reads the Windows version, the chip and the Smart App Control state (read only);
#   - lists the names, sizes and dates in the Downloads folder before and after, to prove the tests never write
#     there (it opens nothing);
#   - runs the Go test programs listed in kit.json that this PC's chip can run, after checking each SHA-256;
#   - installs Mergelane from the kit's installer into the results folder, opens it once with a throwaway profile
#     (--user-data-dir), checks its window, its browser bridge, its helpers' versions and its Open with entries for
#     .torrent and .nzb, and uninstalls it, checking nothing is left (an unpacked app, built with --unpacked, is only
#     opened and checked);
#   - writes report.txt in the kit folder and copies it to the clipboard, for the owner to paste into the chat,
#     where scripts/windows/report.mjs reads it.
#
# Safety (CLAUDE.md, "Safety for the owner's Windows laptop"): it needs no administrator rights and stops if it has
# them. It changes no settings and writes nothing outside the kit folder; the test programs use the TEMP folder and
# remove what they make. Mergelane's own per-user installer adds a Start menu entry, a desktop shortcut, an Apps
# list entry and Open with entries for .torrent and .nzb while it is installed, and its uninstaller removes them; the
# kit checks that. It never installs over a Mergelane already installed. kit.test.mjs checks this file for commands that would change the system.
#
# Keep this file ASCII: Windows PowerShell reads a script without a byte-order mark in the ANSI code page
# (about_Character_Encoding). kit.mjs refuses to build a kit otherwise.

#Requires -Version 5.1
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$KitDir = $PSScriptRoot
$ResultsDir = Join-Path $KitDir 'results'
$ReportFile = Join-Path $KitDir 'report.txt'
# The same markers as scripts/windows/report.mjs (kit.test.mjs checks they match).
$ReportBegin = '-----BEGIN MERGELANE TEST KIT REPORT-----'
$ReportEnd = '-----END MERGELANE TEST KIT REPORT-----'
$TailLines = 40
$MaxLineLength = 300
# How long Mergelane may take to show its window.
$AppReadySeconds = 90

# A property of a JSON or registry object, or $null when it has none (strict mode throws on a missing one).
function Get-Value($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($property) { return $property.Value }
    return $null
}

# The report never carries the user's folder name: their profile path becomes %USERPROFILE%.
function Hide-Profile([string]$Text) {
    if (-not $Text -or -not $env:USERPROFILE) { return $Text }
    return $Text -ireplace [regex]::Escape($env:USERPROFILE), '%USERPROFILE%'
}

function Limit-Line([string]$Line) {
    if ($Line.Length -le $MaxLineLength) { return $Line }
    return $Line.Substring(0, $MaxLineLength) + '...'
}

function Test-Elevated {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Win32_OperatingSystem: Caption, Version, BuildNumber (a string).
function Get-WindowsInfo {
    try {
        $os = Get-CimInstance -ClassName Win32_OperatingSystem
        return [ordered]@{
            caption = ([string]$os.Caption).Trim()
            version = [string]$os.Version
            build   = [int]$os.BuildNumber
        }
    } catch {
        return [ordered]@{ error = Hide-Profile $_.Exception.Message }
    }
}

# Win32_Processor.Architecture: 0 x86, 5 ARM, 9 x64, 12 ARM64.
function Get-Chip {
    try {
        $cpu = Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1
        $code = [int]$cpu.Architecture
        $arch = switch ($code) { 0 { 'x86' } 5 { 'arm' } 9 { 'x64' } 12 { 'arm64' } default { 'unknown' } }
        return [ordered]@{ arch = $arch; code = $code; name = ([string]$cpu.Name).Trim() }
    } catch {
        return [ordered]@{ arch = 'unknown'; error = Hide-Profile $_.Exception.Message }
    }
}

# Smart App Control's mode, read from the registry value Microsoft's "Test your app's signature with Smart App
# Control" names: 0 Off, 1 On (enforcement), 2 Evaluation. Windows 10 has no Smart App Control.
function Get-SmartAppControl {
    try {
        $key = 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy'
        if (-not (Test-Path -LiteralPath $key)) { return 'absent' }
        $value = Get-Value (Get-ItemProperty -LiteralPath $key) 'VerifiedAndReputablePolicyState'
        if ($null -eq $value) { return 'absent' }
        switch ([int]$value) {
            0 { return 'off' }
            1 { return 'on' }
            2 { return 'evaluation' }
        }
        return "unknown ($value)"
    } catch {
        return 'unknown'
    }
}

# The Downloads folder, from the user's shell folders (FOLDERID_Downloads); %USERPROFILE%\Downloads by default.
function Get-DownloadsFolder {
    $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'
    try {
        $raw = Get-Value (Get-ItemProperty -LiteralPath $key) '{374DE290-123F-4565-9164-39C4925E467B}'
        if ($raw) { return [Environment]::ExpandEnvironmentVariables([string]$raw) }
    } catch {
        # fall through to the default
    }
    return Join-Path $env:USERPROFILE 'Downloads'
}

# Every entry under a folder: its relative path, mapped to its size and last-write time. Nothing is opened.
function Get-FolderSnapshot([string]$Folder) {
    $snapshot = @{}
    if (-not (Test-Path -LiteralPath $Folder)) { return $snapshot }
    $base = (Resolve-Path -LiteralPath $Folder).ProviderPath.TrimEnd('\') + '\'
    Get-ChildItem -LiteralPath $Folder -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
        $size = if ($_.PSIsContainer) { -1 } else { $_.Length }
        $snapshot[$_.FullName.Substring($base.Length)] = "$size|$($_.LastWriteTimeUtc.Ticks)"
    }
    return $snapshot
}

function Compare-Snapshots($Before, $After) {
    $added = @(); $removed = @(); $changed = @()
    foreach ($name in $After.Keys) {
        if (-not $Before.ContainsKey($name)) { $added += $name }
        elseif ($Before[$name] -ne $After[$name]) { $changed += $name }
    }
    foreach ($name in $Before.Keys) {
        if (-not $After.ContainsKey($name)) { $removed += $name }
    }
    return [ordered]@{
        checked = $true
        added   = @($added | Sort-Object)
        removed = @($removed | Sort-Object)
        changed = @($changed | Sort-Object)
    }
}

# Whether Windows marked the kit as downloaded from the internet (the Zone.Identifier stream, which Get-Item's
# -Stream parameter reads).
function Test-MarkOfTheWeb([string]$Path) {
    $stream = Get-Item -LiteralPath $Path -Stream 'Zone.Identifier' -ErrorAction SilentlyContinue
    return [bool]$stream
}

# Windows 11 on Arm runs x64 programs through emulation; Windows 10 on Arm doesn't (Microsoft's "How emulation
# works on Arm"). Windows 11 is build 22000 and later.
function Test-CanRun([string]$ProgramArch, [string]$Chip, [int]$Build) {
    if ($ProgramArch -eq $Chip) { return $true }
    return ($Chip -eq 'arm64' -and $ProgramArch -eq 'x64' -and $Build -ge 22000)
}

function Read-Lines([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    return @(Get-Content -LiteralPath $Path -Encoding UTF8)
}

function Invoke-GoProgram($Program, [string]$Chip, [int]$Build) {
    $result = [ordered]@{
        id      = [string]$Program.id
        arch    = [string]$Program.arch
        package = [string]$Program.package
        until   = Get-Value $Program 'until'
    }
    if (-not (Test-CanRun $result.arch $Chip $Build)) {
        $result.status = 'skipped'
        $result.reason = "this PC ($Chip) can't run $($result.arch) programs"
        return $result
    }
    $exe = Join-Path $KitDir (([string]$Program.path) -replace '/', '\')
    if (-not (Test-Path -LiteralPath $exe)) {
        $result.status = 'error'
        $result.reason = 'the program is missing from the kit folder (an antivirus may have removed it)'
        return $result
    }
    $hash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne ([string]$Program.sha256).ToLowerInvariant()) {
        $result.status = 'error'
        $result.reason = 'the program file differs from the one built (SHA-256); copy the kit again'
        return $result
    }

    # The program runs in its own folder, so its relative paths work, and writes its coverage there.
    $folder = Split-Path -Parent $exe
    $safeId = $result.id -replace '[\\/]', '_'
    $outFile = Join-Path $ResultsDir "$safeId.out.txt"
    $errFile = Join-Path $ResultsDir "$safeId.err.txt"
    $coverFile = Join-Path $folder 'cover.out'
    Remove-Item -LiteralPath $coverFile -Force -ErrorAction SilentlyContinue

    $watch = [Diagnostics.Stopwatch]::StartNew()
    try {
        $process = Start-Process -FilePath $exe -ArgumentList '-test.v', '-test.timeout=10m', '-test.coverprofile=cover.out' `
            -WorkingDirectory $folder -NoNewWindow -Wait -PassThru `
            -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    } catch {
        # Smart App Control or an antivirus refusing the program ends up here.
        $result.status = 'error'
        $result.reason = Hide-Profile $_.Exception.Message
        return $result
    }
    $watch.Stop()

    $lines = @(Read-Lines $outFile) + @(Read-Lines $errFile)
    $result.exitCode = $process.ExitCode
    $result.seconds = [math]::Round($watch.Elapsed.TotalSeconds, 1)
    $result.passed = @($lines | Where-Object { $_ -match '^\s*--- PASS: ' }).Count
    $result.failed = @($lines | Where-Object { $_ -match '^\s*--- FAIL: ' }).Count
    $result.skippedTests = @($lines | Where-Object { $_ -match '^\s*--- SKIP: ' }).Count
    $result.failedTests = @($lines | ForEach-Object { if ($_ -match '^\s*--- FAIL: (\S+)') { $Matches[1] } })
    $result.coverage = $null
    foreach ($line in $lines) {
        if ($line -match 'coverage: ([0-9.]+)% of statements') { $result.coverage = [double]$Matches[1] }
    }
    if ($process.ExitCode -eq 0) {
        $result.status = 'passed'
        $result.tail = @()
    } else {
        $result.status = 'failed'
        $result.tail = @($lines | Select-Object -Last $TailLines | ForEach-Object { Hide-Profile (Limit-Line $_) })
    }
    $result.cover = @()
    if (Test-Path -LiteralPath $coverFile) {
        $result.cover = @(Read-Lines $coverFile | Where-Object { $_ -match $Kit.coverInclude })
        Move-Item -LiteralPath $coverFile -Destination (Join-Path $ResultsDir "$safeId.cover.txt") -Force
    }
    return $result
}

# The app's browser pipe for a profile folder, as app/src/shared/browserPipe.ts names it (all three are tested
# against shared/fixtures/browser-pipe.json): mergelane-browser- and 16 hex digits of the SHA-256 of the folder's
# path, its letters A-Z lowercased.
function Get-BridgePipeName([string]$Folder) {
    $lower = [regex]::Replace($Folder, '[A-Z]', { param($m) $m.Value.ToLowerInvariant() })
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $sha.ComputeHash((New-Object Text.UTF8Encoding($false)).GetBytes($lower))
    } finally {
        $sha.Dispose()
    }
    $hex = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    return 'mergelane-browser-' + $hex.Substring(0, 16)
}

# Asks the app's browser bridge whether it is ready: the health message the Mac's package test sends
# (scripts/ci/package-test.sh). Returns the app's one-line answer, or $null.
function Get-BridgeHealth([string]$PipeName) {
    $client = New-Object IO.Pipes.NamedPipeClientStream('.', $PipeName, [IO.Pipes.PipeDirection]::InOut)
    try {
        $client.Connect(2000)
        $writer = New-Object IO.StreamWriter($client, (New-Object Text.UTF8Encoding($false)))
        $writer.AutoFlush = $true
        $writer.Write('{"v":3,"origin":"","message":{"type":"health"}}' + "`n")
        return (New-Object IO.StreamReader($client)).ReadLine()
    } catch {
        return $null
    } finally {
        $client.Dispose()
    }
}

# Mergelane installed for this user, as Windows lists it in Settings > Apps (read only): the entry's key name, or
# $null.
function Get-InstalledMergelane {
    $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
    if (-not (Test-Path -LiteralPath $key)) { return $null }
    foreach ($entry in @(Get-ChildItem -LiteralPath $key -ErrorAction SilentlyContinue)) {
        $values = Get-ItemProperty -LiteralPath $entry.PSPath -ErrorAction SilentlyContinue
        if ((Get-Value $values 'DisplayName') -eq 'Mergelane') { return $entry.PSChildName }
    }
    return $null
}

# Starts the app once with its own profile inside the results folder (Electron's --user-data-dir, so it reaches
# no other Mergelane and keeps its settings there), waits for its window ("Mergelane", app/src/renderer/index.html)
# and for its browser bridge's answer, then closes it the way a user does. Anything still running from the app's
# folder afterwards is stopped.
function Test-AppWindow($Result, [string]$Exe, [string]$ProfileDir) {
    $appDir = Split-Path -Parent $Exe
    $watch = [Diagnostics.Stopwatch]::StartNew()
    try {
        $process = Start-Process -FilePath $Exe -ArgumentList "--user-data-dir=`"$ProfileDir`"" `
            -WorkingDirectory $appDir -PassThru
    } catch {
        $Result.status = 'error'
        $Result.reason = Hide-Profile $_.Exception.Message
        return
    }
    # Reading Handle now keeps the exit code readable after the process ends.
    $null = $process.Handle
    $title = ''
    while ($watch.Elapsed.TotalSeconds -lt $AppReadySeconds) {
        Start-Sleep -Milliseconds 500
        $process.Refresh()
        if ($process.HasExited) { break }
        if ($process.MainWindowTitle -like 'Mergelane*') {
            $title = $process.MainWindowTitle
            break
        }
    }
    $Result.seconds = [math]::Round($watch.Elapsed.TotalSeconds, 1)
    # With the window up, the browser bridge must answer on its pipe (W2): up to 30 seconds more.
    $Result.bridge = 'not asked'
    if ($title) {
        $pipeName = Get-BridgePipeName $ProfileDir
        $Result.bridge = 'no answer'
        $asked = [Diagnostics.Stopwatch]::StartNew()
        while ($asked.Elapsed.TotalSeconds -lt 30 -and -not $process.HasExited) {
            $answer = Get-BridgeHealth $pipeName
            if ($answer -and $answer -match '"ready":true') {
                $Result.bridge = 'ready'
                break
            }
            Start-Sleep -Milliseconds 500
            $process.Refresh()
        }
    }
    if ($title -and $Result.bridge -eq 'ready') {
        $Result.status = 'ready'
    } elseif ($title) {
        $Result.status = 'failed'
        $Result.reason = 'the window opened, but the browser bridge did not answer on its pipe'
    } elseif ($process.HasExited) {
        $Result.status = 'failed'
        $Result.reason = "it closed by itself (exit code $($process.ExitCode))"
    } else {
        $Result.status = 'failed'
        $Result.reason = "no window within $AppReadySeconds seconds"
    }

    if (-not $process.HasExited) {
        $process.CloseMainWindow() | Out-Null
        if (-not $process.WaitForExit(20000)) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
    }
    $left = @(Get-Process -Name 'Mergelane' -ErrorAction SilentlyContinue | Where-Object {
            $_.Path -and $_.Path.StartsWith($appDir, [StringComparison]::OrdinalIgnoreCase)
        })
    foreach ($leftover in $left) { Stop-Process -Id $leftover.Id -Force -ErrorAction SilentlyContinue }
    $Result.leftRunning = $left.Count
}

# The two helpers inside the app must say the app's version, as the Mac's package test checks
# (scripts/ci/package-test.sh): "mergelane-daemon <version>" and "mergelane-nmhost <version>". Each only prints one
# line and exits. Their problems go into $Result.helpers (none: an empty list); a kit.json without the app's version
# skips this.
function Test-HelperVersions($Result, [string]$AppDir, $Version) {
    if (-not $Version) { return }
    $Result.version = [string]$Version
    $problems = @()
    foreach ($helper in @(@('mergelane-daemon', 'version'), @('mergelane-nmhost', '--version'))) {
        $exe = Join-Path $AppDir "resources\$($helper[0]).exe"
        $expected = "$($helper[0]) $Version"
        try {
            $said = [string](& $exe $helper[1] | Select-Object -First 1)
        } catch {
            $said = 'nothing: it did not run: ' + (Hide-Profile $_.Exception.Message)
        }
        if ($said.Trim() -ne $expected) {
            $problems += "$($helper[0]).exe says '$(Limit-Line $said.Trim())', expected '$expected'"
        }
    }
    $Result.helpers = $problems
    if ($problems.Count -gt 0 -and $Result.status -eq 'ready') {
        $Result.status = 'failed'
        $Result.reason = $problems -join '; '
    }
}

# Mergelane's Open with entry for a file type, as build/installer.nsh writes it (read only): the command of its
# ProgID, Mergelane.<ext>, and whether the extension's OpenWithProgids list names that ProgID.
function Get-OpenWithState([string]$Ext) {
    $progId = "Mergelane.$Ext"
    $command = Get-ItemProperty -LiteralPath "HKCU:\Software\Classes\$progId\shell\open\command" `
        -ErrorAction SilentlyContinue
    $listed = Get-ItemProperty -LiteralPath "HKCU:\Software\Classes\.$Ext\OpenWithProgids" -Name $progId `
        -ErrorAction SilentlyContinue
    return @{ command = [string](Get-Value $command '(default)'); listed = ($null -ne $listed) }
}

# Checks one chip's app. An installer (W4) is installed silently into the results folder (NSIS: /S, and /D= the
# folder, last and unquoted), opened as above, then uninstalled silently; the kit then looks for what the uninstaller
# should have taken away. It never installs over a Mergelane that is already installed for this user. An unpacked app
# is only opened.
function Invoke-AppCheck($App, [string]$Chip, [int]$Build) {
    $result = [ordered]@{
        arch = [string]$App.arch
        kind = [string]$App.kind
    }
    if (-not (Test-CanRun $result.arch $Chip $Build)) {
        $result.status = 'skipped'
        $result.reason = "this PC ($Chip) can't run $($result.arch) programs"
        return $result
    }
    $file = Join-Path $KitDir (([string]$App.path) -replace '/', '\')
    if (-not (Test-Path -LiteralPath $file)) {
        $result.status = 'error'
        $result.reason = 'the app is missing from the kit folder (an antivirus may have removed it)'
        return $result
    }
    $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne ([string]$App.sha256).ToLowerInvariant()) {
        $result.status = 'error'
        $result.reason = "$(Split-Path -Leaf $file) differs from the one built (SHA-256); copy the kit again"
        return $result
    }
    $profileDir = Join-Path $ResultsDir "profile-$($result.arch)"
    if ($result.kind -ne 'installer') {
        Test-AppWindow $result $file $profileDir
        Test-HelperVersions $result (Split-Path -Parent $file) (Get-Value $App 'version')
        return $result
    }

    if (Get-InstalledMergelane) {
        $result.status = 'skipped'
        $result.reason = 'Mergelane is already installed for you, so the kit does not install over it'
        return $result
    }
    $installDir = Join-Path $ResultsDir "install-$($result.arch)"
    $installed = [Diagnostics.Stopwatch]::StartNew()
    try {
        $setup = Start-Process -FilePath $file -ArgumentList '/S', "/D=$installDir" -Wait -PassThru
    } catch {
        $result.status = 'error'
        $result.reason = Hide-Profile $_.Exception.Message
        return $result
    }
    $result.installSeconds = [math]::Round($installed.Elapsed.TotalSeconds, 1)
    $exe = Join-Path $installDir 'Mergelane.exe'
    if ($setup.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $exe)) {
        $result.status = 'failed'
        $result.reason = "the installer ended with code $($setup.ExitCode) and Mergelane.exe is not in its folder"
        return $result
    }

    # The installer adds Mergelane to Open with for .torrent and .nzb, pointing at the program it installed.
    $missing = @()
    foreach ($ext in @('torrent', 'nzb')) {
        $state = Get-OpenWithState $ext
        if (-not $state.listed -or $state.command.IndexOf($exe, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
            $missing += ".$ext"
        }
    }
    $result.openWithMissing = $missing

    Test-AppWindow $result $exe $profileDir
    Test-HelperVersions $result $installDir (Get-Value $App 'version')
    if ($missing.Count -gt 0 -and $result.status -eq 'ready') {
        $result.status = 'failed'
        $result.reason = "the installer did not add Mergelane to Open with for $($missing -join ' and ')"
    }

    # The uninstaller copies itself elsewhere and returns at once, so wait for the program to go (up to a minute).
    $uninstaller = Join-Path $installDir 'Uninstall Mergelane.exe'
    try {
        Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait | Out-Null
    } catch {
        $result.uninstall = Hide-Profile $_.Exception.Message
    }
    $gone = [Diagnostics.Stopwatch]::StartNew()
    while ((Test-Path -LiteralPath $exe) -and $gone.Elapsed.TotalSeconds -lt 60) { Start-Sleep -Milliseconds 500 }
    Start-Sleep -Seconds 2
    $leftovers = @()
    if (Test-Path -LiteralPath $exe) { $leftovers += 'Mergelane.exe is still in its folder' }
    if (Get-InstalledMergelane) { $leftovers += 'Windows still lists Mergelane in Settings > Apps' }
    foreach ($place in @('Programs', 'Desktop')) {
        $link = Join-Path ([Environment]::GetFolderPath($place)) 'Mergelane.lnk'
        if (Test-Path -LiteralPath $link) { $leftovers += "a shortcut is left in $place" }
    }
    foreach ($ext in @('torrent', 'nzb')) {
        $state = Get-OpenWithState $ext
        if ($state.listed -or $state.command) { $leftovers += "Open with still lists Mergelane for .$ext" }
    }
    $result.leftovers = $leftovers
    if ($leftovers.Count -gt 0 -and $result.status -eq 'ready') {
        $result.status = 'failed'
        $result.reason = 'the uninstaller left something behind'
    }
    return $result
}

# ---------------------------------------------------------------------------------------------------------------

Write-Host 'Mergelane Windows test kit'
Write-Host 'It reads information about this PC, runs Mergelane''s own test programs from this folder, and opens'
Write-Host 'Mergelane once with a test profile.'
Write-Host 'It needs no administrator rights and changes no settings.'
Write-Host ''

if (Test-Elevated) {
    Write-Host 'This window has administrator rights, which the kit doesn''t want.' -ForegroundColor Yellow
    Write-Host 'Close it, then double-click "Run test kit.cmd" again (not "Run as administrator").' -ForegroundColor Yellow
    exit 2
}

$Kit = Get-Content -LiteralPath (Join-Path $KitDir 'kit.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ((Get-Value $Kit 'kit') -ne 1) {
    Write-Host 'This kit.json is from another kit version. Build the kit again on the Mac.' -ForegroundColor Yellow
    exit 2
}
New-Item -ItemType Directory -Path $ResultsDir -Force | Out-Null

$windows = Get-WindowsInfo
$build = [int]$windows.build
$chip = Get-Chip
$smartAppControl = Get-SmartAppControl
Write-Host "Windows: $($windows.caption) (build $build), chip: $($chip.arch), Smart App Control: $smartAppControl"
if ($smartAppControl -eq 'on') {
    Write-Host 'Smart App Control is On: Windows may block the test programs, because they are not signed.' -ForegroundColor Yellow
}

$downloadsFolder = Get-DownloadsFolder
Write-Host 'Noting the names in your Downloads folder (nothing is opened)...'
$downloadsBefore = Get-FolderSnapshot $downloadsFolder

$programs = @()
foreach ($program in @($Kit.programs)) {
    Write-Host "Running $($program.id) ..."
    $outcome = Invoke-GoProgram $program $chip.arch $build
    Write-Host "  $($outcome.status)"
    $programs += , $outcome
}

$apps = @()
foreach ($app in @(Get-Value $Kit 'apps')) {
    if ($null -eq $app) { continue }
    Write-Host "Installing, opening and uninstalling Mergelane ($($app.arch)) ..."
    $outcome = Invoke-AppCheck $app $chip.arch $build
    Write-Host "  $($outcome.status)"
    $apps += , $outcome
}

$downloads = Compare-Snapshots $downloadsBefore (Get-FolderSnapshot $downloadsFolder)

$report = [ordered]@{
    report          = 1
    kit             = [ordered]@{
        commit = [string](Get-Value $Kit 'commit')
        dirty  = [bool](Get-Value $Kit 'dirty')
        built  = [string](Get-Value $Kit 'built')
    }
    ran             = (Get-Date).ToUniversalTime().ToString('o')
    windows         = $windows
    chip            = $chip
    powershell      = $PSVersionTable.PSVersion.ToString()
    executionPolicy = (Get-ExecutionPolicy).ToString()
    smartAppControl = $smartAppControl
    markOfTheWeb    = Test-MarkOfTheWeb $PSCommandPath
    downloads       = $downloads
    programs        = $programs
    apps            = $apps
}

$passed = @($programs | Where-Object { $_.status -eq 'passed' }).Count
$opened = @($apps | Where-Object { $_.status -eq 'ready' }).Count
$downloadsSame = ($downloads.added.Count + $downloads.removed.Count + $downloads.changed.Count) -eq 0
$summary = @(
    'Mergelane Windows test kit report',
    "Test programs passed: $passed of $($programs.Count)",
    "Mergelane opened: $opened of $($apps.Count)",
    "Downloads folder unchanged: $downloadsSame"
)
$json = $report | ConvertTo-Json -Depth 8
$text = (@($summary) + @('', $ReportBegin, $json, $ReportEnd, '')) -join "`r`n"
[IO.File]::WriteAllText($ReportFile, $text, (New-Object Text.UTF8Encoding($false)))

$copied = $true
try { Set-Clipboard -Value $text } catch { $copied = $false }

Write-Host ''
foreach ($line in $summary) { Write-Host $line }
Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
if ($copied) {
    Write-Host 'The report is on the clipboard: paste it into the chat.'
} else {
    Write-Host 'Open report.txt in this folder and paste its contents into the chat.'
}
Write-Host "It is also saved as $(Hide-Profile $ReportFile)."
exit 0
