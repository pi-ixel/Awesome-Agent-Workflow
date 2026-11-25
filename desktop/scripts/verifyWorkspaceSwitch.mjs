import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);

async function resources(pid) {
  assert.ok(Number.isInteger(pid) && pid > 0);
  const { stdout } = await exec("powershell.exe", ["-NoProfile", "-Command", `
    $desktop = ${pid}
    $processes = Get-CimInstance Win32_Process
    $family = @($desktop)
    do {
      $children = @($processes | Where-Object { $_.ParentProcessId -in $family -and $_.ProcessId -notin $family } | ForEach-Object ProcessId)
      $family += $children
    } while ($children.Count)
    $webviews = @($processes | Where-Object { $_.Name -eq 'msedgewebview2.exe' -and $_.ProcessId -in $family } | ForEach-Object ProcessId)
    $root = Get-Process -Id $desktop
    $web = Get-Process -Id $webviews -ErrorAction SilentlyContinue
    [pscustomobject]@{
      desktopPrivateMiB=$root.PrivateMemorySize64 / 1MB
      webviewPrivateMiB=($web | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB
      cpuMs=1000 * ($root.CPU + ($web | Measure-Object CPU -Sum).Sum)
      webviewProcesses=$webviews.Count
    } | ConvertTo-Json -Compress
  `], { windowsHide: true, timeout: 15000 });
  const sample = JSON.parse(stdout);
  assert.ok(sample.webviewProcesses > 0, "未找到隔离 Desktop 的 WebView2 子进程");
  return sample;
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.ceil(sorted.length * p) - 1] * 10) / 10;
}

export async function verifyWorkspaceSwitch({ evaluate, pid, bootMs }) {
  for (const projects of [3, 24]) {
    const coldMs = await evaluate(`(async () => {
      const module = await import("/tests/visual/workspaceSwitchBenchmark.tsx");
      const start = performance.now();
      window.aawWorkspaceSwitchBenchmark = await module.prepareWorkspaceSwitch(${projects});
      return performance.now() - start;
    })()`);
    await delay(500);
    const before = await resources(pid);
    const samples = [before];
    for (const offset of [0, 30, 60, 90]) {
      await evaluate(`window.aawWorkspaceSwitchBenchmark.run(${offset}, 30)`);
      samples.push(await resources(pid));
    }
    await delay(3000);
    const stable = await resources(pid);
    const report = await evaluate("window.aawWorkspaceSwitchBenchmark.report()");
    console.log("WORKSPACE_SWITCH_BENCH " + JSON.stringify({
      projects,
      bootMs,
      coldMs: Math.round(coldMs),
      switches: report.loaded.length,
      selectedMs: [percentile(report.selected, .5), percentile(report.selected, .95)],
      visibleMs: [percentile(report.loaded, .5), percentile(report.loaded, .95)],
      groupDrops: report.groupDrops,
      treeChanges: report.domChanges,
      requests: report.requests,
      initialRequests: report.initialRequests,
      cpuMs: Math.round(samples.at(-1).cpuMs - before.cpuMs),
      desktopPrivateMiB: [...samples, stable].map(({ desktopPrivateMiB }) => Math.round(desktopPrivateMiB * 10) / 10),
      webviewPrivateMiB: [...samples, stable].map(({ webviewPrivateMiB }) => Math.round(webviewPrivateMiB * 10) / 10),
    }));
    await evaluate("window.aawWorkspaceSwitchBenchmark.dispose(); delete window.aawWorkspaceSwitchBenchmark");
  }
}
