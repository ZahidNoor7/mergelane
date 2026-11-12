# Mergelane's System merge test for Windows (W5, ADR-0059, docs/WINDOWS-TESTING.md).
#
# Unlike test-kit.ps1, this script changes the system, on purpose, and only after the owner types YES. It needs
# administrator rights: start it with "Run system merge test (administrator).cmd" > right-click > "Run as
# administrator". It:
#   - installs Mergelane's helper from this kit as a Windows service (the program and wintun.dll go to
#     Program Files\Mergelane), the way the app does after its administrator prompt;
#   - turns System merge on, checks the capture routes and that the internet still works, and reads the stats;
#   - kills the helper to check that Windows restarts it and that the restarted helper removes the crashed
#     run's routes, with the internet working throughout;
#   - removes the helper again and checks that nothing is left: no service, no program, no routes, no adapter,
#     and every adapter's settings as they were.
# The removal runs whatever happened before (a finally block). It never runs if Mergelane's helper is already
# installed. It writes system-merge-report.txt in this folder and copies it to the clipboard.
#
# If the internet stops while it runs: close this window, open PowerShell as administrator and run
#   & "<this folder>\helper\<chip>\mergelane-daemon.exe" cleanup
# or restart the PC: the helper's routes never outlive a restart.
#
# Keep this file ASCII (see test-kit.ps1).

#Requires -Version 5.1
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$KitDir = $PSScriptRoot
$ReportFile = Join-Path $KitDir 'system-merge-report.txt'
$ReportBegin = '-----BEGIN MERGELANE SYSTEM MERGE REPORT-----'
$ReportEnd = '-----END MERGELANE SYSTEM MERGE REPORT-----'
$ServiceName = 'mergelane-daemon'
$AdapterName = 'mergelane'
$CaptureRoutes = @('0.0.0.0/1', '128.0.0.0/1')
$Lines = New-Object System.Collections.Generic.List[string]
$script:Failed = $false

function Say([string]$Text) {
    Write-Host $Text
    $Lines.Add($Text)
}

# One checked step: PASS or FAIL, and why.
function Step([string]$Name, [bool]$Ok, [string]$Detail) {
    $mark = 'FAIL'
    if ($Ok) { $mark = 'PASS' } else { $script:Failed = $true }
    $line = "$mark  $Name"
    if ($Detail) { $line += ": $Detail" }
    Say $line
}

function Test-Elevated {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# The PC's chip as the kit names it: x64 or arm64.
function Get-KitChip {
    $arch = $env:PROCESSOR_ARCHITEW6432
    if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
    if ($arch -eq 'ARM64') { return 'arm64' }
    return 'x64'
}

# The internet works when a TCP connection to the helper's own probe targets opens (1.1.1.1 or 8.8.8.8, port 443,
# README "What to expect"). Nothing is sent.
function Test-Internet {
    foreach ($target in @('1.1.1.1', '8.8.8.8')) {
        $client = New-Object System.Net.Sockets.TcpClient
        try {
            $task = $client.ConnectAsync($target, 443)
            if ($task.Wait(5000) -and $client.Connected) { return $true }
        } catch {
        } finally {
            $client.Close()
        }
    }
    return $false
}

# Mergelane's capture routes: the two IPv4 halves on its adapter.
function Get-CaptureRoutes {
    return @(Get-NetRoute -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {
            $CaptureRoutes -contains $_.DestinationPrefix -and $_.InterfaceAlias -eq $AdapterName
        })
}

# Every adapter's weak host send and forwarding, which the helper may turn off while merging and must put back.
function Get-AdapterSettings {
    $settings = @(Get-NetIPInterface -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceAlias -ne $AdapterName } |
            ForEach-Object { '{0} {1} {2} {3}' -f $_.InterfaceIndex, $_.AddressFamily, $_.WeakHostSend, $_.Forwarding })
    return (($settings | Sort-Object) -join '; ')
}

function Get-HelperService {
    return Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
}

# Waits up to $Seconds for the service to be running with a process other than $NotPid; returns its process id
# or 0.
function Wait-HelperRunning([int]$Seconds, [int]$NotPid) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while ($watch.Elapsed.TotalSeconds -lt $Seconds) {
        $service = Get-CimInstance -ClassName Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
        if ($service -and $service.State -eq 'Running' -and $service.ProcessId -ne 0 -and $service.ProcessId -ne $NotPid) {
            return [int]$service.ProcessId
        }
        Start-Sleep -Milliseconds 500
    }
    return 0
}

# Runs the helper; its output (stdout and stderr) as one line, and its exit code.
function Invoke-Helper([string]$Program, [string[]]$Arguments) {
    $ErrorActionPreference = 'Continue'
    $output = & $Program @Arguments 2>&1 | ForEach-Object { "$_" }
    return @{ code = $LASTEXITCODE; text = (($output -join ' ') -replace '\s+', ' ').Trim() }
}

# ---------------------------------------------------------------------------------------------------------------

Write-Host 'Mergelane System merge test'
Write-Host ''
if (-not (Test-Elevated)) {
    Write-Host 'This test needs administrator rights. Close this window, right-click' -ForegroundColor Yellow
    Write-Host '"Run system merge test (administrator).cmd" and choose "Run as administrator".' -ForegroundColor Yellow
    exit 1
}

$chip = Get-KitChip
$kit = Get-Content -LiteralPath (Join-Path $KitDir 'kit.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$helpers = @()
if ($kit.PSObject.Properties['helpers']) { $helpers = @($kit.helpers) }
$entry = $helpers | Where-Object { $_.arch -eq $chip } | Select-Object -First 1
if (-not $entry) {
    Write-Host "This kit has no helper for this PC's chip ($chip). Build the kit again on the Mac." -ForegroundColor Yellow
    exit 1
}
$helper = Join-Path $KitDir (([string]$entry.path) -replace '/', '\')
$wintun = Join-Path (Split-Path -Parent $helper) 'wintun.dll'
foreach ($file in @(@{ path = $helper; sha256 = $entry.sha256 }, @{ path = $wintun; sha256 = $entry.wintunSha256 })) {
    if (-not (Test-Path -LiteralPath $file.path) -or
        (Get-FileHash -LiteralPath $file.path -Algorithm SHA256).Hash.ToLowerInvariant() -ne ([string]$file.sha256).ToLowerInvariant()) {
        Write-Host "$(Split-Path -Leaf $file.path) is missing or differs from the one built; copy the kit again." -ForegroundColor Yellow
        exit 1
    }
}
if (Get-HelperService) {
    Write-Host "Mergelane's helper is already installed on this PC, so this test leaves it alone." -ForegroundColor Yellow
    exit 1
}

Write-Host 'This test changes your PC for about two minutes, then puts everything back:'
Write-Host '  - it installs Mergelane''s helper as a Windows service, from this kit;'
Write-Host '  - it turns System merge on, so all your apps'' internet goes through it for a minute;'
Write-Host '  - it stops the helper by force once, to check Windows restarts it and your internet keeps working;'
Write-Host '  - it removes the helper again, whatever happened.'
Write-Host 'Turn any VPN off first: System merge refuses to start next to one.'
Write-Host 'If your internet stops and does not come back, restart the PC: the helper''s routes never outlive a restart.'
Write-Host ''
$answer = Read-Host 'Type YES to start, or anything else to stop'
if ($answer -cne 'YES') {
    Write-Host 'Stopped. Nothing was changed.'
    exit 0
}

$os = Get-CimInstance -ClassName Win32_OperatingSystem
Say "Mergelane System merge test, kit built from $($kit.commit) on $($kit.built)"
Say "Windows: $($os.Caption) $($os.Version), chip $chip, $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
$settingsBefore = Get-AdapterSettings
if (-not (Test-Internet)) {
    Step 'internet before the test' $false 'no connection to 1.1.1.1 or 8.8.8.8 on port 443; nothing was installed'
    Set-Content -LiteralPath $ReportFile -Value ((@($ReportBegin) + $Lines + @($ReportEnd)) -join "`r`n") -Encoding ASCII
    exit 1
}
Step 'internet before the test' $true ''

try {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $install = Invoke-Helper $helper @('install', '--user-sid', $sid, '--source', $helper)
    Step 'install the helper' ($install.code -eq 0) $install.text
    $programFiles = Join-Path $env:ProgramFiles 'Mergelane'
    Step 'program and wintun.dll in Program Files' ((Test-Path -LiteralPath (Join-Path $programFiles 'mergelane-daemon.exe')) -and
        (Test-Path -LiteralPath (Join-Path $programFiles 'wintun.dll'))) $programFiles
    $firstPid = Wait-HelperRunning 30 0
    Step 'the service runs' ($firstPid -ne 0) "process $firstPid"

    $status = Invoke-Helper $helper @('status')
    Step 'status answers over the pipe, merging off' ($status.code -eq 0 -and $status.text -match 'system merge: off') $status.text

    $on = Invoke-Helper $helper @('on')
    $merging = $on.code -eq 0 -and $on.text -match 'system merge: on'
    Step 'turn System merge on' $merging $on.text
    if ($merging) {
        Step 'capture routes on the mergelane adapter' (@(Get-CaptureRoutes).Count -eq 2) "$(@(Get-CaptureRoutes).Count) of 2"
        Start-Sleep -Seconds 3
        Step 'internet while merging' (Test-Internet) ''
        $stats = Invoke-Helper $helper @('stats')
        Say "      stats: $($stats.text)"
        $links = Invoke-Helper $helper @('links')
        Say "      links: $($links.text)"

        Stop-Process -Id $firstPid -Force
        $secondPid = Wait-HelperRunning 60 $firstPid
        Step 'Windows restarted the helper after it was killed' ($secondPid -ne 0) "process $secondPid"
        Start-Sleep -Seconds 3
        Step 'the restarted helper removed the crashed run''s routes' (@(Get-CaptureRoutes).Count -eq 0) "$(@(Get-CaptureRoutes).Count) left"
        Step 'internet after the crash' (Test-Internet) ''
        $after = Invoke-Helper $helper @('status')
        Step 'merging stays off after a crash (auto-resume is off)' ($after.text -match 'system merge: off') $after.text
    }
} catch {
    Step 'the test ran to its end' $false $_.Exception.Message
} finally {
    $uninstall = Invoke-Helper $helper @('uninstall')
    Step 'remove the helper' ($uninstall.code -eq 0) $uninstall.text
    if (@(Get-CaptureRoutes).Count -gt 0) {
        $cleanup = Invoke-Helper $helper @('cleanup')
        Say "      cleanup: $($cleanup.text)"
    }
    Step 'no service left' (-not (Get-HelperService)) ''
    Step 'no program left in Program Files' (-not (Test-Path -LiteralPath (Join-Path $env:ProgramFiles 'Mergelane\mergelane-daemon.exe'))) ''
    Step 'no capture routes left' (@(Get-CaptureRoutes).Count -eq 0) ''
    Step 'no mergelane adapter left' (-not (Get-NetAdapter -Name $AdapterName -ErrorAction SilentlyContinue)) ''
    Step 'every adapter''s settings as before' ((Get-AdapterSettings) -eq $settingsBefore) ''
    Step 'internet after the test' (Test-Internet) ''
}

$verdict = 'every step passed'
if ($script:Failed) { $verdict = 'SOMETHING FAILED: see the FAIL lines' }
Say "Result: $verdict"
$report = (@($ReportBegin) + $Lines + @($ReportEnd)) -join "`r`n"
Set-Content -LiteralPath $ReportFile -Value $report -Encoding ASCII
try { Set-Clipboard -Value $report } catch { }
Write-Host ''
Write-Host "The report is in $ReportFile and on the clipboard. Paste it into the chat." -ForegroundColor Green
if ($script:Failed) { exit 1 }
exit 0
