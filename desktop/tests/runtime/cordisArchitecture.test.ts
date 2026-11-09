import { existsSync, readFileSync, readdirSync } from "node:fs";
import { posix, resolve } from "node:path";
import { expect, it } from "vitest";
import { installDesktopWorkbench } from "../../src/bootstrap/installDesktopWorkbench.ts";
import { createTestDesktopRuntime } from "../helpers/desktopRuntime.ts";

const plugins = [
  "host",
  "configuration",
  "diagnostics",
  "workbench",
  "agents",
  "acpConnection",
  "acpRuntime",
  "project",
  "documents",
  "git",
  "terminal",
  "workflow",
  "skills",
  "account",
  "updates",
] as const;
const uiOwners = [
  "diagnostics",
  "agents",
  "project",
  "documents",
  "git",
  "terminal",
  "workflow",
  "skills",
  "account",
  "updates",
] as const;
const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

function* productionImports(directory: string) {
  for (const file of readdirSync(resolve(root, directory), { recursive: true })) {
    if (typeof file !== "string" || !/\.tsx?$/.test(file)) continue;
    const path = `${directory}/${file.replaceAll("\\", "/")}`;
    const targets = Array.from(
      read(path).matchAll(/\b(?:from\s+|import\s+|import\s*\(\s*)["'](\.[^"']+|@tauri-apps\/[^"']+)["']/g),
      ([, entry]) => entry!.startsWith(".")
        ? posix.normalize(posix.join(posix.dirname(path), entry!))
        : entry!,
    );
    yield { path, targets };
  }
}

it("locates entry points, shared code and production implementations under their owners", () => {
  expect(readdirSync(resolve(root, "src")).sort()).toEqual([
    "bootstrap",
    "contracts",
    "plugins",
    "shared",
  ]);
  expect(readdirSync(resolve(root, "src/plugins")).sort()).toEqual(
    [...plugins].sort(),
  );
  expect(read("index.html")).toContain('src="/src/bootstrap/main.tsx"');
  for (const path of [
    "src/bootstrap/appMain.tsx",
    "src/bootstrap/diagnosticsMain.tsx",
    "src/plugins/acpConnection/AcpConnectionPool.ts",
    "src/plugins/acpConnection/RequestScheduler.ts",
    "src/plugins/acpRuntime/protocol/session.ts",
    "src/plugins/project/ProjectFactory.ts",
    "src/plugins/acpRuntime/catalogHistory.ts",
    "src/plugins/project/ui/ProjectTree.tsx",
    "src/plugins/project/conversation/ui/SessionView.tsx",
    "src/plugins/project/interactions/ui/ApprovalModal.tsx",
    "src/plugins/agents/ui/AgentsSettings.tsx",
    "src/plugins/diagnostics/ui/DiagnosticsWindow.tsx",
    "src/plugins/workbench/ui/right-panel/RightPanel.tsx",
    "src/shared/ui/controls.tsx",
    "src/shared/styles/index.css",
  ]) {
    expect(existsSync(resolve(root, path)), path).toBe(true);
  }
});

it("keeps the 15 core plugin names and all 74 dependency relations aligned with their production owners", async () => {
  const diagram = read("docs/cordis-plugin-dependencies.mmd");
  const nodes = [...diagram.matchAll(/^[ ]{4}(\w+)\[/gm)].map(
    (match) => match[1],
  );
  expect(nodes).toEqual(plugins);
  const required = ["host --> rust"];
  for (const name of plugins) {
    const definition = read(`src/plugins/${name}/plugin.ts`);
    const dependencies =
      definition.match(/\binject\s*=\s*\[([^\]]*)\]/)?.[1] ?? "";
    for (const [, dependency] of dependencies.matchAll(/"(\w+)"/g)) {
      required.push(`${name} --> ${dependency}`);
    }
  }
  const optional = [
    [
      "acpRuntime",
      "注册探查会话工厂",
      "agents",
      "src/plugins/acpRuntime/plugin.ts",
      "agents.registerProbeSessions",
    ],
    [
      "workbench",
      "顶栏新建会话",
      "project",
      "src/plugins/workbench/ui/ContextBar.tsx",
      "project?.startNewSession",
    ],
    [
      "workbench",
      "通过文档服务打开文件",
      "documents",
      "src/plugins/workbench/ui/right-panel/RightPanel.tsx",
      "useWorkbenchDocuments",
    ],
    [
      "documents",
      "读写批注草稿及从批注新建会话",
      "project",
      "src/plugins/documents/ui/FileAnnotations.tsx",
      "projectService?.startNewSession",
    ],
    [
      "agents",
      "设置页读取项目上下文并请求切换 Agent",
      "project",
      "src/plugins/agents/workbench.tsx",
      "project.switchAgent",
    ],
    [
      "project",
      "可选：技能候选",
      "skills",
      "src/plugins/project/conversation/ui/ChatInput.tsx",
      "useWorkbenchSkills",
    ],
    [
      "project",
      "可选：健康检查脚本来源",
      "skills",
      "src/plugins/project/ui/ProjectOverview.tsx",
      "useWorkbenchSkills",
    ],
    [
      "workflow",
      "可选：工作流脚本来源",
      "skills",
      "src/plugins/workflow/workspaceBinding.ts",
      "readSkillSource",
    ],
    [
      "workflow",
      "注册工作区健康检查",
      "project",
      "src/plugins/workflow/plugin.ts",
      "project.registerWorkspaceHealthCheck",
    ],
    [
      "project",
      "可选：文档上下文",
      "documents",
      "src/plugins/project/conversation/ui/ChatInput.tsx",
      "listWorkspaceFiles",
    ],
    [
      "project",
      "可选：审阅上下文",
      "git",
      "src/plugins/project/conversation/ui/SessionStatusOverlay.tsx",
      "useProjectGit",
    ],
    [
      "project",
      "可选：工作流进度",
      "workflow",
      "src/plugins/project/conversation/ui/SessionStatusOverlay.tsx",
      "useWorkflowStatus",
    ],
    [
      "documents",
      "可选：文件状态",
      "git",
      "src/plugins/documents/workbench.tsx",
      "useWorkbenchGit",
    ],
    [
      "updates",
      "安装前请求退出",
      "workbench",
      "src/plugins/updates/service.ts",
      "exit.requestExit",
    ],
    [
      "project",
      "登记退出检查与收尾",
      "workbench",
      "src/plugins/project/lifecycle.ts",
      "exit.registerExit",
    ],
    [
      "documents",
      "登记退出检查与收尾",
      "workbench",
      "src/plugins/documents/workbench.tsx",
      "workbench.registerExit",
    ],
    [
      "project",
      "使用当前工作台导航",
      "workbench",
      "src/bootstrap/bootstrap.ts",
      "getLayout: () => context.workbench",
    ],
    [
      "documents",
      "登记未保存导航检查",
      "workbench",
      "src/plugins/documents/workbench.tsx",
      "workbench.navigationGuard.register",
    ],
    [
      "terminal",
      "登记退出检查与收尾",
      "workbench",
      "src/plugins/terminal/lifecycle.ts",
      "workbench.registerExit",
    ],
    [
      "documents",
      "登记项目关闭处理",
      "project",
      "src/plugins/documents/workbench.tsx",
      "project.registerProjectClose",
    ],
    [
      "terminal",
      "登记项目关闭处理",
      "project",
      "src/plugins/terminal/workbench.ts",
      "project.registerProjectClose",
    ],
  ] as const;
  const weak = optional.map(([source, label, target, file, marker]) => {
    expect(read(file), file).toContain(marker);
    return `${source} -. "${label}" .-> ${target}`;
  });
  const assembly = read("src/bootstrap/installDesktopWorkbench.ts");
  expect(assembly).toContain("context.plugin(agentsWorkbench.agentSettings)");
  for (const owner of uiOwners) {
    expect(assembly).toContain(`context.plugin(${owner}Workbench`);
    weak.push(`${owner} -. "UI 注册" .-> workbench`);
  }
  const edges = diagram
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:\w+ --> \w+|\w+ -\. ".+" \.-> \w+)$/.test(line));
  expect(new Set(edges).size).toBe(74);
  expect(edges.sort()).toEqual([...required, ...weak].sort());

  const runtime = createTestDesktopRuntime(
    {
      attachPreloading: () => () => {},
      close: () => Promise.resolve(),
    },
    undefined,
    async (context) => {
      for (const name of plugins) expect(context.get(name), name).toBeDefined();
      await installDesktopWorkbench(context);
    },
  );
  try {
    const { workbench } = await runtime.ready;
    const view = workbench.getSnapshot();
    expect(view.pages.map(({ id }) => id).sort()).toEqual([
      "project-overview",
      "session",
      "settings",
    ]);
    expect(view.sidebar.map(({ id }) => id)).toEqual(["project-tree"]);
    expect(view.login.map(({ id }) => id)).toEqual(["account-login"]);
    expect(view.panels.map(({ id }) => id).sort()).toEqual([
      "aaw",
      "diff",
      "directory",
      "file",
      "files",
      "git",
    ]);
    expect(view.settings.map(({ id }) => id).sort()).toEqual([
      "agents",
      "archive",
      "general",
      "session",
      "tools",
      "updates",
    ]);
    expect(view.actions.map(({ id }) => id).sort()).toEqual([
      "account.logout",
      "diagnostics.open",
      "settings.archive",
    ]);
    expect(view.settingsReset.map(({ id }) => id).sort()).toEqual(["agents", "project", "skills"]);
    expect(view.chrome.map(({ id }) => id)).toContain("session-reconnect");
    expect(view.skills.map(({ id }) => id)).toEqual(["skills"]);
    expect(view.accountIdentity.map(({ id }) => id)).toEqual(["account"]);
    expect(view.docks.map(({ id }) => id)).toEqual(["terminal"]);
  } finally {
    await runtime.shutdown();
  }
});

it("keeps protocol and connection code out of feature UI and product state", () => {
  for (const directory of [
    "src/plugins/acpConnection",
    "src/plugins/acpRuntime",
  ]) {
    for (const { path, targets } of productionImports(directory)) {
      const invalid = targets.filter((target) =>
        (target.startsWith("src/plugins/") && !target.startsWith(`${directory}/`)) ||
        /(?:^|\/)(?:ui|stores)\/|^src\/bootstrap\//.test(target),
      );
      expect(invalid, path).toEqual([]);
    }
  }
});

it("keeps public models and shared utilities independent of plugin implementations", () => {
  const forbidden = {
    "src/plugins/host": /^src\/plugins\/(?!host\/)/,
    "src/plugins/agents": /^(?:src\/plugins\/(?:acpConnection|acpRuntime|host)\/|@tauri-apps\/)/,
    "src/plugins/account": /^(?:src\/plugins\/host\/|@tauri-apps\/)/,
    "src/plugins/workbench": /^src\/plugins\/(?:project|workflow)\//,
    "src/plugins/project": /^(?:src\/plugins\/(?:acpConnection|acpRuntime|workflow|host)\/|@tauri-apps\/)/,
    "src/contracts": /^(?:src\/(?:plugins|bootstrap)\/|@tauri-apps\/)/,
    "src/shared": /^(?:src\/(?:plugins|bootstrap)\/|@tauri-apps\/)/,
  };
  for (const [directory, pattern] of Object.entries(forbidden)) {
    for (const { path, targets } of productionImports(directory))
      expect(targets.filter((target) => pattern.test(target)), path).toEqual([]);
  }
  for (const { path, targets } of productionImports("src/plugins")) {
    const owner = path.split("/").slice(0, 3).join("/");
    expect(targets.filter((target) =>
      target.startsWith("src/bootstrap/") ||
      (target.startsWith("src/plugins/") &&
        !target.startsWith(`${owner}/`) &&
        target !== "src/plugins/workbench/viewBindings.ts"),
    ), path).toEqual([]);
    if (owner !== "src/plugins/host")
      expect(targets.filter((target) => target.startsWith("@tauri-apps/")), path).toEqual([]);
  }
  for (const { path, targets } of productionImports("src/bootstrap"))
    expect(targets.filter((target) => target.startsWith("@tauri-apps/")), path).toEqual([]);
});
