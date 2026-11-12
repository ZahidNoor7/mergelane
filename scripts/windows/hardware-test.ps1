# Mergelane's real-hardware run on Windows (W6, docs/WINDOWS-TESTING.md), the Windows counterpart of
# scripts/hardware/hardware.mjs (ADR-0050).
#
# Run it on the laptop, as yourself (not as administrator), with Mergelane installed and its helper installed from
# the app (Networks > System merge > Install). It talks to the helper over its control pipe, downloads public
# speed-test files over every network, and asks you to unplug a network, sleep the PC, switch a VPN and stop the
# helper at the right moments. It checks what it can and asks you to confirm what only a person can see. Whatever
# happens, it turns System merge back the way it was, puts every network's limit and the sticky-sites setting back,
# and checks no capture route is left.
#
# It needs no administrator rights. The one step that does (stopping the helper by force) is optional: it shows a
# command for you to run in a separate administrator PowerShell window.
#
# Data: every download counts against a phone's data plan. The start says how much the run uses.
#
# Keep this file ASCII (see test-kit.ps1).

#Requires -Version 5.1
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$KitDir = $PSScriptRoot
$ReportFile = Join-Path $KitDir 'hardware-report.txt'
$ReportBegin = '-----BEGIN MERGELANE HARDWARE REPORT-----'
$ReportEnd = '-----END MERGELANE HARDWARE REPORT-----'
$PipeName = 'mergelane-daemon'
$AdapterName = 'mergelane'
$CaptureRoutes = @('0.0.0.0/1', '128.0.0.0/1')
# One download: 10 MB from Cloudflare's speed test, which any network can reach.
$ChunkBytes = 10000000
$ChunkUrl = "https://speed.cloudflare.com/__down?bytes=$ChunkBytes"
$ProbeUrl = 'https://speed.cloudflare.com/__down?bytes=100000'
# Every network is capped while the run measures, so downloads last long enough and the data is predictable.
$CapMbps = 16
$UnplugCapMbps = 4
$Lines = New-Object System.Collections.Generic.List[string]
$script:Failed = $false

function Say([string]$Text) {
    Write-Host $Text
    $Lines.Add($Text)
}

function Step([string]$Name, [bool]$Ok, [string]$Detail) {
    $mark = 'FAIL'
    if ($Ok) { $mark = 'PASS' } else { $script:Failed = $true }
    $line = "$mark  $Name"
    if ($Detail) { $line += ": $Detail" }
    Say $line
}

function Ask([string]$Question) {
    $answer = Read-Host "$Question (y/n)"
    return ($answer -match '^(y|yes)$')
}

# One request to the helper over its pipe (shared/daemon-api.ts): the result, or an exception with the helper's
# error code and message.
function Invoke-Helper([string]$Method, $Params) {
    $pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', $PipeName, [System.IO.Pipes.PipeDirection]::InOut)
    try {
        $pipe.Connect(5000)
        $writer = New-Object System.IO.StreamWriter($pipe, (New-Object System.Text.UTF8Encoding($false)))
        $writer.AutoFlush = $true
        $reader = New-Object System.IO.StreamReader($pipe, (New-Object System.Text.UTF8Encoding($false)))
        $request = @{ v = 1; id = '1'; method = $Method }
        if ($null -ne $Params) { $request.params = $Params }
        $writer.Write((ConvertTo-Json -InputObject $request -Compress -Depth 5) + "`n")
        $response = $reader.ReadLine() | ConvertFrom-Json
        if (-not $response.ok) { throw "$($response.error.code): $($response.error.message)" }
        return $response.result
    } finally {
        $pipe.Dispose()
    }
}

function Get-CaptureRouteCount {
    return @(Get-NetRoute -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {
            $CaptureRoutes -contains $_.DestinationPrefix -and $_.InterfaceAlias -eq $AdapterName
        }).Count
}

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

function Get-UpLinks {
    return @((Invoke-Helper 'links' $null).links | Where-Object { $_.up })
}

# Waits up to $Seconds for $Check to be true, polling every half second.
function Wait-Until([int]$Seconds, [scriptblock]$Check) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while ($watch.Elapsed.TotalSeconds -lt $Seconds) {
        try { if (& $Check) { return $true } } catch { }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

# Downloads $Count chunks at once while sampling the helper's stats every half second. Returns the merged bytes
# per link (each sample's rate times the interval, as hardware.mjs bytesByLink does).
function Measure-Downloads([int]$Count) {
    $client = New-Object System.Net.Http.HttpClient
    $client.Timeout = [TimeSpan]::FromSeconds(300)
    $tasks = @(1..$Count | ForEach-Object { $client.GetByteArrayAsync($ChunkUrl) })
    $bytes = @{}
    try {
        while (@($tasks | Where-Object { -not $_.IsCompleted }).Count -gt 0) {
            Start-Sleep -Milliseconds 500
            foreach ($link in @((Invoke-Helper 'stats' $null).links)) {
                $previous = 0.0
                if ($bytes.ContainsKey($link.name)) { $previous = $bytes[$link.name] }
                $bytes[$link.name] = $previous + (([double]$link.rxBps + [double]$link.txBps) * 0.5)
            }
        }
    } finally {
        $client.Dispose()
    }
    $failed = @($tasks | Where-Object { $_.IsFaulted }).Count
    return @{ bytes = $bytes; failed = $failed }
}

# Each link's share of the bytes, largest first: "Wi-Fi 61%, Ethernet 39%".
function Get-Shares($Bytes) {
    $total = 0.0
    foreach ($value in $Bytes.Values) { $total += $value }
    $shares = @()
    foreach ($name in $Bytes.Keys) {
        $share = 0.0
        if ($total -gt 0) { $share = $Bytes[$name] / $total }
        $shares += New-Object PSObject -Property @{ name = $name; share = $share }
    }
    return @($shares | Sort-Object -Property share -Descending)
}

function Format-Shares($Shares) {
    $parts = @($Shares | Where-Object { $_.share -ge 0.005 } | ForEach-Object { '{0} {1}%' -f $_.name, [math]::Round($_.share * 100) })
    if ($parts.Count -eq 0) { return 'no traffic' }
    return $parts -join ', '
}

function Set-AllLimits([double]$Mbps, $Links) {
    foreach ($link in $Links) { [void](Invoke-Helper 'setLimit' @{ link = $link.name; mbps = $Mbps }) }
}

# ---------------------------------------------------------------------------------------------------------------

Write-Host 'Mergelane hardware run (Windows)'
Write-Host ''
try {
    $status = Invoke-Helper 'status' $null
} catch {
    Write-Host "Mergelane's helper doesn't answer: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host 'Install it from Mergelane first (Networks > System merge > Install), then run this again.' -ForegroundColor Yellow
    exit 1
}
$links = @((Invoke-Helper 'links' $null).links)
$up = @($links | Where-Object { $_.up })
$estimate = [math]::Round((16 * $ChunkBytes) / 1e6)
Write-Host "The helper says version $($status.version), System merge $($status.state). Networks up: $(($up | ForEach-Object { $_.name }) -join ', ')."
Write-Host "This run downloads about $estimate MB, plus about 50 MB for each network you unplug. A phone's share counts"
Write-Host 'against its data plan. Pause big downloads, backups and video calls meanwhile, and turn any VPN off.'
Write-Host "While it runs, every network is capped at $CapMbps Mbit/s; the end puts your limits back. If the run is cut off,"
Write-Host 'set them again in Mergelane (Networks, each network''s limit).'
Write-Host ''
if ($up.Count -lt 2) {
    Write-Host 'Connect at least two networks that reach the internet (for example Wi-Fi and a phone over USB), then run this again.' -ForegroundColor Yellow
    exit 1
}
if (-not (Ask 'Start')) {
    Write-Host 'Stopped. Nothing was changed.'
    exit 0
}

$os = Get-CimInstance -ClassName Win32_OperatingSystem
Say "Mergelane hardware run, helper $($status.version), $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
Say "Windows: $($os.Caption) $($os.Version). Networks up: $(($up | ForEach-Object { '{0} ({1})' -f $_.name, $_.kind }) -join ', ')"
$wasOn = $status.state -eq 'on'
$stickyBefore = $true
if ($status.PSObject.Properties['stickySites']) { $stickyBefore = [bool]$status.stickySites }
$limitsBefore = @{}
foreach ($link in $links) {
    $limit = 0
    if ($link.PSObject.Properties['limitMbps']) { $limit = [double]$link.limitMbps }
    $limitsBefore[$link.name] = $limit
}
Say "      to put back afterwards: System merge $($status.state), sticky sites $stickyBefore, limits $((($limitsBefore.Keys | ForEach-Object { '{0}={1}' -f $_, $limitsBefore[$_] }) -join ' '))"
Step 'internet before the run' (Test-Internet) ''

Add-Type -AssemblyName System.Net.Http
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

try {
    Set-AllLimits $CapMbps $up
    try {
        [void](Invoke-Helper 'enable' $null)
        $on = Wait-Until 15 { (Invoke-Helper 'status' $null).state -eq 'on' }
        Step 'System merge turns on' $on ''
    } catch {
        Step 'System merge turns on' $false $_.Exception.Message
        throw 'System merge did not turn on; the rest needs it'
    }
    Step 'its two capture routes are there, once each' ((Get-CaptureRouteCount) -eq 2) "$(Get-CaptureRouteCount) routes"

    [void](Invoke-Helper 'setStickySites' @{ enabled = $false })
    $spread = Measure-Downloads 8
    $shares = Get-Shares $spread.bytes
    $used = @($shares | Where-Object { $_.share -ge 0.10 }).Count
    Step 'one site, sticky off: its connections spread' ($used -ge 2 -and $spread.failed -eq 0) "$(Format-Shares $shares); $($spread.failed) failed"

    [void](Invoke-Helper 'setStickySites' @{ enabled = $true })
    $sticky = Measure-Downloads 8
    $shares = Get-Shares $sticky.bytes
    $used = @($shares | Where-Object { $_.share -ge 0.15 }).Count
    Step 'one site, sticky on: it stays on one network' ($used -eq 1 -and $sticky.failed -eq 0) "$(Format-Shares $shares); $($sticky.failed) failed"

    if (Ask 'Start a download in Mergelane now. When it runs, do all your networks show traffic under Networks?') {
        Step 'Mergelane''s own download uses every network (you saw it)' $true ''
    } else {
        Step 'Mergelane''s own download uses every network (you saw it)' $false 'you said no'
    }

    foreach ($link in $up) {
        if (-not (Ask "Test unplugging $($link.name) ($($link.kind))?")) { continue }
        Set-AllLimits $UnplugCapMbps $up
        $client = New-Object System.Net.Http.HttpClient
        $client.Timeout = [TimeSpan]::FromSeconds(300)
        $running = @(1..4 | ForEach-Object { $client.GetByteArrayAsync($ChunkUrl) })
        Read-Host "Unplug or turn off $($link.name) now, then press Enter" | Out-Null
        $gone = Wait-Until 30 { -not (@(Get-UpLinks) | Where-Object { $_.name -eq $link.name }) }
        Step "$($link.name) unplugged: the helper sees it go" $gone ''
        Step "$($link.name) unplugged: System merge stays on" ((Invoke-Helper 'status' $null).state -eq 'on') ''
        $through = Wait-Until 30 { $client.GetByteArrayAsync($ProbeUrl).Wait(10000) }
        Step "$($link.name) unplugged: a new download gets through" $through ''
        $finished = Wait-Until 120 { @($running | Where-Object { $_.IsCompleted -and -not $_.IsFaulted }).Count -ge 1 }
        Step "$($link.name) unplugged: a running download finishes" $finished ''
        $client.Dispose()
        Read-Host "Plug $($link.name) back in or turn it on, then press Enter" | Out-Null
        $back = Wait-Until 120 { @(Get-UpLinks) | Where-Object { $_.name -eq $link.name } }
        Step "$($link.name) reconnected: it is up again" $back ''
        Set-AllLimits $CapMbps $up
    }

    if (Ask 'Test sleep and wake? (Put the PC to sleep from the Start menu, wake it, then come back here)') {
        Read-Host 'Sleep the PC now, wake it, wait for the networks to reconnect, then press Enter' | Out-Null
        $answers = Wait-Until 60 { (Invoke-Helper 'status' $null).state -eq 'on' }
        Step 'after sleep: the helper answers and System merge is on' $answers ''
        Step 'after sleep: two networks are up' ((@(Get-UpLinks)).Count -ge 2) ''
        Step 'after sleep: its routes are there, once each' ((Get-CaptureRouteCount) -eq 2) "$(Get-CaptureRouteCount) routes"
        Step 'after sleep: the internet works' (Test-Internet) ''
    }

    if (Ask 'Test a VPN? (You need a VPN app you can turn on and off)') {
        Read-Host 'Turn your VPN on now, wait until it says connected, then press Enter' | Out-Null
        $off = Wait-Until 30 { (Invoke-Helper 'status' $null).state -eq 'off' }
        $reason = (Invoke-Helper 'status' $null)
        $why = ''
        if ($reason.PSObject.Properties['reason']) { $why = [string]$reason.reason }
        Step 'a VPN turns System merge off, saying why' ($off -and $why) $why
        $refused = $false
        try { [void](Invoke-Helper 'enable' $null) } catch { $refused = $_.Exception.Message -match 'VPN_ACTIVE' }
        Step 'turning it on is refused while the VPN is on' $refused ''
        Step 'no capture route is left next to the VPN' ((Get-CaptureRouteCount) -eq 0) "$(Get-CaptureRouteCount) routes"
        Read-Host 'Turn your VPN off now, then press Enter' | Out-Null
        $again = Wait-Until 30 { [void](Invoke-Helper 'enable' $null); (Invoke-Helper 'status' $null).state -eq 'on' }
        Step 'with the VPN off, System merge turns on again' $again ''
    }

    if (Ask 'Test a helper crash? (You run one command in an administrator PowerShell window)') {
        $before = Get-CimInstance -ClassName Win32_Service -Filter "Name='mergelane-daemon'"
        Write-Host 'Open PowerShell as administrator (Start menu > type PowerShell > Run as administrator) and run:'
        Write-Host "    Stop-Process -Id $($before.ProcessId) -Force" -ForegroundColor Cyan
        Read-Host 'Then come back here and press Enter' | Out-Null
        $restarted = Wait-Until 30 {
            $now = Get-CimInstance -ClassName Win32_Service -Filter "Name='mergelane-daemon'"
            $now.State -eq 'Running' -and $now.ProcessId -ne $before.ProcessId -and (Invoke-Helper 'status' $null)
        }
        Step 'after a crash: Windows starts the helper again' $restarted ''
        $state = (Invoke-Helper 'status' $null).state
        $expected = 0
        if ($state -eq 'on') { $expected = 2 }
        Step 'after a crash: the routes match its state' ((Get-CaptureRouteCount) -eq $expected) "System merge $state, $(Get-CaptureRouteCount) routes"
        Step 'after a crash: the internet works' (Test-Internet) ''
    }
} catch {
    Step 'the run reached its end' $false $_.Exception.Message
} finally {
    try {
        if (-not $wasOn) { [void](Invoke-Helper 'disable' $null) } else { [void](Invoke-Helper 'enable' $null) }
        [void](Invoke-Helper 'setStickySites' @{ enabled = $stickyBefore })
        foreach ($name in $limitsBefore.Keys) {
            try {
                [void](Invoke-Helper 'setLimit' @{ link = $name; mbps = $limitsBefore[$name] })
            } catch {
                Say "      couldn't put $name's limit back to $($limitsBefore[$name]) Mbit/s: $($_.Exception.Message)"
            }
        }
        $after = Invoke-Helper 'status' $null
        Step 'put back: System merge, sticky sites and limits as they were' ($after.state -eq $status.state) "System merge $($after.state)"
    } catch {
        Step 'put back: System merge, sticky sites and limits as they were' $false $_.Exception.Message
    }
    if (-not $wasOn) { Step 'put back: no capture route left' ((Get-CaptureRouteCount) -eq 0) '' }
    Step 'put back: the internet works' (Test-Internet) ''
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
