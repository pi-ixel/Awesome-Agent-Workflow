param([Parameter(Mandatory)][string]$Exe)

$ErrorActionPreference = 'Stop'
$results = Join-Path $env:RUNNER_TEMP 'aaw-webview2-profile-results'
$data = Join-Path $env:RUNNER_TEMP ("aaw-webview2-profile-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $results, $data | Out-Null
$Exe = (Resolve-Path -LiteralPath $Exe).Path
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$env:AAW_WEBVIEW2_BENCH_PORT = "$($listener.LocalEndpoint.Port)"
$listener.Stop()

function Invoke-WebViewCase {
    param([string]$Name, [string]$Phase, [string]$Data, [bool]$Shared, [int]$Sessions)
    $arm = Join-Path $results $Name
    New-Item -ItemType Directory -Path $arm | Out-Null
    $json = Join-Path $arm 'result.json'
    $env:AAW_WEBVIEW2_SHARED_PROFILES = if ($Shared) { '1' } else { '0' }
    $env:AAW_WEBVIEW2_BENCH_ROOT = $Data
    $env:AAW_WEBVIEW2_BENCH_OUT = $json
    $env:AAW_WEBVIEW2_BENCH_SESSIONS = "$Sessions"
    $env:AAW_WEBVIEW2_BENCH_PHASE = $Phase
    $process = Start-Process -FilePath $Exe -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $arm 'stdout.txt') -RedirectStandardError (Join-Path $arm 'stderr.txt')
    if (-not $process.WaitForExit(120000)) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        throw "$Name timed out"
    }
    if ($process.ExitCode -ne 0 -or !(Test-Path -LiteralPath $json)) {
        if (Test-Path -LiteralPath $json) { Get-Content -LiteralPath $json | Write-Host }
        Get-Content -LiteralPath (Join-Path $arm 'stderr.txt') | Write-Host
        throw "$Name failed with exit code $($process.ExitCode)"
    }
    Start-Sleep -Seconds 2
    Get-Content -LiteralPath $json -Raw | ConvertFrom-Json
}

$acceptance = Join-Path $data 'lifecycle'
Invoke-WebViewCase 'legacy' 'legacy' $acceptance $false 3 | Out-Null
Invoke-WebViewCase 'seed' 'seed' $acceptance $true 3 | Out-Null
Invoke-WebViewCase 'reopen' 'reopen' $acceptance $false 3 | Out-Null
Invoke-WebViewCase 'reject' 'reject' (Join-Path $data 'rejected') $true 1 | Out-Null

$rows = @(
    foreach ($round in 1..3) {
        $modes = if ($round % 2) { @($false, $true) } else { @($true, $false) }
        foreach ($shared in $modes) {
            foreach ($sessions in @(1, 3)) {
                $name = "$round-$shared-$sessions"
                [pscustomobject]@{
                    round = $round
                    shared = $shared
                    sessions = $sessions
                    actual = Invoke-WebViewCase $name 'perf' (Join-Path $data $name) $shared $sessions
                }
            }
        }
    }
)
$rows | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $results 'measurements.json') -Encoding utf8
$summary = @(
    foreach ($sessions in @(1, 3)) {
        $before = @($rows | Where-Object { !$_.shared -and $_.sessions -eq $sessions } | ForEach-Object actual)
        $after = @($rows | Where-Object { $_.shared -and $_.sessions -eq $sessions } | ForEach-Object actual)
        $beforeBytes = @($before.privateBytes | Sort-Object)[1]
        $afterBytes = @($after.privateBytes | Sort-Object)[1]
        [pscustomobject]@{
            sessions = $sessions
            beforeProcesses = @($before.processCount | Sort-Object)[1]
            afterProcesses = @($after.processCount | Sort-Object)[1]
            beforeMiB = [Math]::Round($beforeBytes / 1MB, 2)
            afterMiB = [Math]::Round($afterBytes / 1MB, 2)
            changePct = [Math]::Round(($afterBytes / $beforeBytes - 1) * 100, 2)
        }
    }
)
$summary | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $results 'summary.json') -Encoding utf8
$summary | Format-Table -AutoSize
@(
    '| 会话 | 独立进程数 | 共享进程数 | 独立私有内存 (MiB) | 共享私有内存 (MiB) | 变化 |'
    '|---|---|---|---|---|---|'
    $summary | ForEach-Object {
        if ($_ -is [string]) { $_ } else {
            "| $($_.sessions) | $($_.beforeProcesses) | $($_.afterProcesses) | $($_.beforeMiB) | $($_.afterMiB) | $($_.changePct)% |"
        }
    }
) | Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY
if ($summary[0].afterProcesses -gt $summary[0].beforeProcesses -or $summary[0].changePct -gt 10 -or $summary[1].changePct -gt -30) {
    throw 'WebView2 memory acceptance thresholds were not met'
}
