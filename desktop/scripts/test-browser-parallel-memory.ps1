param(
    [Parameter(Mandatory)][string]$Baseline,
    [Parameter(Mandatory)][string]$Candidate,
    [string]$OutputDirectory = (Join-Path $env:TEMP ('aaw-parallel-memory-' + [guid]::NewGuid().ToString('N'))),
    [int]$Rounds = 1
)

$ErrorActionPreference = 'Stop'
if ($Rounds -lt 1) { throw '至少运行一轮' }
$Baseline = (Resolve-Path -LiteralPath $Baseline).Path
$Candidate = (Resolve-Path -LiteralPath $Candidate).Path
$output = New-Item -Path $OutputDirectory -ItemType Directory

function Invoke-ParallelCase($Executable, $Case, $Sessions, $Reuse) {
    $folder = New-Item -Path (Join-Path $output.FullName $Case) -ItemType Directory
    $result = Join-Path $folder.FullName 'result.json'
    $stderr = Join-Path $folder.FullName 'stderr.txt'
    $settings = @{
        AAW_WEBVIEW2_BENCH_PHASE = 'parallel'
        AAW_WEBVIEW2_BENCH_ROOT = (Join-Path $folder.FullName 'profile')
        AAW_WEBVIEW2_BENCH_OUT = $result
        AAW_WEBVIEW2_BENCH_SESSIONS = "$Sessions"
        AAW_WEBVIEW2_BENCH_REUSE = "$Reuse"
        AAW_WEBVIEW2_SHARED_PROFILES = '1'
    }
    Write-Host "运行 $Case"
    $process = Start-Process -FilePath $Executable -Environment $settings -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $folder.FullName 'stdout.txt') -RedirectStandardError $stderr
    if (-not $process.WaitForExit(135000)) {
        Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
        throw "$Case 超时，结果目录 $($folder.FullName)"
    }
    if (Test-Path -LiteralPath $result) {
        $value = Get-Content -LiteralPath $result -Raw | ConvertFrom-Json
        if ($process.ExitCode -eq 0 -and $value.status -eq 'ok' -and $value.allSessionsResumed) { return $value }
        throw "$Case 失败 $($value.error)"
    }
    throw "$Case 退出码 $($process.ExitCode)，详见 $stderr"
}

$rows = foreach ($round in 1..$Rounds) {
    foreach ($sessions in @(2, 4)) {
        $versions = if ($round % 2 -eq 1) { @('baseline', 'candidate') } else { @('candidate', 'baseline') }
        foreach ($version in $versions) {
            $reuse = if ($version -eq 'candidate') { 1 } else { 0 }
            $exe = if ($reuse) { $Candidate } else { $Baseline }
            $value = Invoke-ParallelCase $exe "$round-$sessions-$version" $sessions $reuse
            [pscustomobject]@{
                round = $round
                version = $version
                sessions = $sessions
                result = $value
            }
        }
    }
}
$rows | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $output.FullName 'comparison.json') -Encoding utf8
$rows | ForEach-Object {
    [pscustomobject]@{
        round = $_.round
        sessions = $_.sessions
        version = $_.version
        tabs = $_.result.settled.tabCount
        # 结束瞬间也采样，避免很短的查询在最后一次轮询后才达到最高工作集。
        maxObservedMiB = [math]::Round([math]::Max($_.result.peak.workingSet, $_.result.settled.workingSet) / 1MB, 1)
        idle30MiB = [math]::Round($_.result.idle30.workingSet / 1MB, 1)
        idle60MiB = [math]::Round($_.result.idle60.workingSet / 1MB, 1)
        maxQueryMs = ($_.result.durationMs | Measure-Object -Maximum).Maximum
    }
} | Format-Table -AutoSize
Write-Host "详细指标 $($output.FullName)"
