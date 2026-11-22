import { approvalProfile } from "./approval-profile.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  BrowserCdpClient,
  browserSleep,
} from "../../../../scripts/browserCdpClient.ts";
import {
  changesPath,
  configurationPath,
  fixtureFiles,
  passMarker,
  task,
} from "./project-fixture.mjs";

const [agentExecutable, host, user, root, hostKey] = process.argv.slice(2);
const password = process.env.AAW_SPIKE_SSH_PASSWORD;
const decision = process.env.AAW_SPIKE_NATIVE_DECISION ?? "allow";
const approvalMode = process.env.AAW_SPIKE_APPROVAL_MODE ?? "ask";
const isRemote = Boolean(host);
const profileName = process.env.AAW_SPIKE_PERMISSION_PROFILE ?? "build-default";
const permission = approvalProfile(profileName);
if (
  !agentExecutable ||
  (isRemote && (!user || !root || !hostKey || !password))
) {
  throw new Error("需要 OpenCode 路径，远程用例还需要测试连接和固定主机密钥");
}
assert.ok(["allow", "reject"].includes(decision));
assert.ok(["ask", "auto-allow"].includes(approvalMode));

const temp = await mkdtemp(path.join(tmpdir(), "aaw-native-remote-"));
const workspace = path.join(temp, "AAW 远程验证项目");
await mkdir(workspace);
const files = isRemote
  ? {
      [configurationPath]: fixtureFiles[configurationPath],
      "AGENTS.md":
        "当前会话绑定远端项目，请用 remote_project MCP 访问项目文件和执行命令。本机目录仅用于会话存储。",
    }
  : fixtureFiles;
for (const [name, content] of Object.entries(files)) {
  const destination = path.join(workspace, name);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content);
}

const profile = JSON.parse(
  await readFile(
    path.join(homedir(), ".config/opencode/opencode.json"),
    "utf8",
  ),
);
const providerId = profile.model.split("/")[0];
const provider = profile.provider[providerId];
assert.ok(provider?.options?.apiKey, "独立 OpenCode 需要已配置的模型");
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith("AAW_SPIKE_") && !key.startsWith("OPENCODE_"),
  ),
);
const pathKey =
  Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
env[pathKey] =
  path.dirname(agentExecutable) + path.delimiter + (env[pathKey] ?? "");
Object.assign(env, {
  AAW_DEV_INSTANCE_DIR: path.join(temp, "notification"),
  XDG_CONFIG_HOME: path.join(temp, "config"),
  XDG_DATA_HOME: path.join(temp, "data"),
  XDG_CACHE_HOME: path.join(temp, "cache"),
  XDG_STATE_HOME: path.join(temp, "state"),
  OPENCODE_DISABLE_AUTOUPDATE: "true",
  OPENCODE_CONFIG_CONTENT: JSON.stringify({
    model: profile.model,
    provider: { [providerId]: provider },
    permission: permission.agentPermission,
  }),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
    "--remote-debugging-port=14714 --remote-debugging-address=127.0.0.1",
});
const origin = "http://127.0.0.1:14713";
const port = 14714;
let desktop;
let cdp;
const vite = spawn(
  process.execPath,
  [
    "node_modules/vite/bin/vite.js",
    "--host",
    "127.0.0.1",
    "--port",
    "14713",
    "--strictPort",
  ],
  {
    env,
    windowsHide: true,
    stdio: ["ignore", "ignore", "inherit"],
  },
);
const record = (value) => process.stdout.write(JSON.stringify(value) + "\n");
async function waitFor(probe, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await probe();
    if (result) return result;
    await browserSleep(350);
  } while (Date.now() < deadline);
  throw new Error(description + " 超时");
}

try {
  await waitFor(
    async () =>
      (
        await fetch(origin, { signal: AbortSignal.timeout(500) }).catch(
          () => null,
        )
      )?.ok,
    "Vite 启动",
  );
  assert.equal(vite.exitCode, null, "预验证 Vite 未启动");
  desktop = spawn(path.resolve("src-tauri/target/debug/desktop.exe"), [], {
    env,
    windowsHide: true,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const page = await waitFor(
    async () => {
      if (desktop.exitCode !== null)
        throw new Error("AAWD 提前退出 " + desktop.exitCode);
      const response = await fetch("http://127.0.0.1:" + port + "/json/list", {
        signal: AbortSignal.timeout(500),
      }).catch(() => null);
      return (
        response?.ok &&
        (await response.json()).find((entry) => entry.url === origin + "/")
      );
    },
    "AAWD 主窗口",
    30000,
  );
  cdp = await BrowserCdpClient.connect(page);
  const query = (expression, timeout) => cdp.evaluate(expression, timeout);
  await waitFor(
    () =>
      query(
        'Boolean(window.__aawWorkspaceStore && document.querySelector("#root")?.innerText)',
      ),
    "工作台初始化",
    35000,
  );
  const isWorkbenchReady = () =>
    query("Boolean(document.querySelector(\"button[aria-label='新建会话']\"))");
  if (!(await isWorkbenchReady())) {
    record({ stage: "waiting_for_login", autoWaitSeconds: 45 });
    try {
      await waitFor(isWorkbenchReady, "自动登录", 45000);
    } catch {
      record({ stage: "waiting_for_manual_login", timeoutMinutes: 10 });
      await waitFor(isWorkbenchReady, "手动登录", 600000);
    }
  }
  record({ stage: "workbench_ready" });
  const config = {
    workspace,
    agentExecutable,
    approvalMode,
    profileName,
    ssh: isRemote
      ? { host, user, port: 22, root, hostKey, password }
      : undefined,
  };
  const result = await query(
    '(async()=> (await import("/src/plugins/remoteProject/spike/native-fixture.mjs")).configureNativeFixture(' +
      JSON.stringify(config) +
      "))()",
    45000,
  ).catch(() => null);
  assert.ok(
    isRemote ? result?.pid > 0 : result?.local,
    "AAWD 装配测试项目失败",
  );
  record({
    stage: "workspace",
    kind: isRemote ? "remote" : "local",
    approvalMode,
    desktopPid: desktop.pid,
    sidecarPid: result.pid,
    workspace,
  });

  const clicked = await query(
    "(()=>{const button=document.querySelector(\"button[aria-label='新建会话']\");button?.click();return Boolean(button);})()",
  );
  assert.ok(clicked, "缺少工作台新建会话入口");
  await waitFor(
    () =>
      query(
        "(()=>{const panel=document.querySelector(\"[aria-label='新建会话面板']\");const button=panel?.querySelector(\"[aria-label='选择项目开始新会话'] button\");button?.click();return Boolean(button);})()",
      ),
    "选择会话项目",
  );
  await waitFor(
    () => query('Boolean(document.querySelector("textarea:not([disabled])"))'),
    "原有会话编辑器",
    40000,
  );
  const promptFilled = await query(
    '(()=>{const input=document.querySelector("textarea:not([disabled])");if(!input)return false;const text=' +
      JSON.stringify(task) +
      ';Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")?.set?.call(input,text);input.dispatchEvent(new Event("input",{bubbles:true}));return input.value===text;})()',
  );
  assert.ok(promptFilled);
  await waitFor(
    () =>
      query(
        "(()=>{const button=document.querySelector(\"button[aria-label='发送']:not([disabled])\");button?.click();return Boolean(button);})()",
      ),
    "从工作台发送任务",
  );
  record({ stage: "ui_prompt_sent" });

  const approvedTitles = [];
  const outcome = await waitFor(
    async () => {
      const ui = await query(
        "(()=>{const modal=document.querySelector(\"[aria-label='权限审批']\");if(!modal)return null;const label=" +
          JSON.stringify(decision === "allow" ? "允许" : "拒绝") +
          ';const button=[...modal.querySelectorAll("button")].find(item=>item.innerText.trim()===label&&!item.disabled);if(!button)return null;const text=modal.innerText;button.click();return text;})()',
      );
      if (ui) {
        approvedTitles.push(ui);
        record({ stage: "ui_approval", decision, title: ui.slice(0, 260) });
      }
      const status = await query(
        '(()=>{const view=window.__aawSessionStore.getState();return {sessionId:view.activeSessionId, running:view.isAgentRunning, stop:view.lastStopReason, items:view.items.filter(item=>item.kind==="tool").map(item=>({title:item.title,kind:item.toolKind,status:item.status,input:item.inputSummary,output:JSON.stringify(item.rawOutput)?.slice(0,1000),summary:item.resultSummary}))};})()',
      );
      const sidecar = isRemote
        ? await query("window.__aawRemoteFixture.events()")
        : [];
      if (
        sidecar.some(
          ({ event }) => event === "exit" || event === "permission_send_failed",
        )
      ) {
        throw new Error("AAWD 与项目 sidecar 的审批通道已关闭");
      }
      return status.sessionId &&
        !status.running &&
        status.stop &&
        status.items.length > 0
        ? { status, sidecar }
        : false;
    },
    "OpenCode 结束任务",
    170000,
  );
  const calls = outcome.sidecar.filter(({ event }) => event === "tool");
  const changed = await readFile(
    path.join(workspace, configurationPath),
    "utf8",
  );
  const localCreated = await readFile(
    path.join(workspace, changesPath),
    "utf8",
  ).catch(() => null);
  record({
    stage: "observed",
    kind: isRemote ? "remote" : "local",
    sessionId: outcome.status.sessionId,
    approvalMode,
    profileName,
    approvals: approvedTitles.length,
    approvalsShown: approvedTitles.map((entry) => entry.slice(0, 320)),
    calls: isRemote ? calls : outcome.status.items,
    localConfig: changed,
    localCreated: Boolean(localCreated),
  });
  if (isRemote) {
    assert.equal(
      changed,
      fixtureFiles[configurationPath],
      "远程会话误改本机对照文件",
    );
    assert.equal(localCreated, null, "远程会话误在本机新建文件");
    const didTool = (name) => calls.some(({ tool, ok }) => tool === name && ok);
    assert.ok(didTool("read_file"), "Agent 未读取远端文件");
    if (decision === "allow") {
      assert.ok(didTool("edit_file"), "Agent 未局部编辑远端文件");
      assert.ok(didTool("write_file"), "Agent 未新建远端文件");
      assert.ok(
        calls.some(
          ({ tool, result }) =>
            tool === "run_command" &&
            result?.exitCode === 0 &&
            result.stdout.includes(passMarker),
        ),
        "远程测试没有跑通",
      );
    }
  } else if (decision === "allow") {
    assert.match(changed, /retryLimit:\s*3/);
    assert.ok(localCreated?.trim(), "本地未新建说明文件");
    assert.ok(
      outcome.status.items.some(
        ({ output, summary }) =>
          (output ?? "").includes(passMarker) ||
          (summary ?? "").includes(passMarker),
      ),
      "本地测试无成功标记",
    );
  }
  record({
    stage: "verified",
    kind: isRemote ? "remote" : "local",
    approvals: approvedTitles.length,
  });
} finally {
  cdp?.close();
  desktop?.kill();
  vite.kill();
}
