import { existsSync, readFileSync, readdirSync } from "node:fs";
import { posix, resolve } from "node:path";
import ts from "typescript";
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
const pluginRootFiles = new Set([
  "index.ts",
  "service.ts",
  "types.ts",
  "events.ts",
  "config.ts",
]);
const typeScriptFile = /\.(?:[cm]?ts|tsx)$/;

function isPluginImportAllowed(source: string, target: string, runtime: boolean): boolean {
  if (!target.startsWith("src/plugins/")) return true;
  const [, , owner, file, ...remaining] = target.split("/");
  if (source.startsWith(`src/plugins/${owner}/`)) return true;
  if (remaining.length > 0) return false;
  return file === "service.ts" || file === "events.ts" ||
    (file === "types.ts" && !runtime) ||
    (file === "index.ts" && source.startsWith("src/bootstrap/"));
}

function* productionImports(directory: string) {
  for (const file of readdirSync(resolve(root, directory), { recursive: true })) {
    if (typeof file !== "string" || !typeScriptFile.test(file)) continue;
    const path = `${directory}/${file.replaceAll("\\", "/")}`;
    const targets = new Set<string>();
    const runtimeTargets = new Set<string>();
    const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true);
    function add(specifier: ts.Node | undefined, runtime: boolean) {
      if (!specifier || !ts.isStringLiteralLike(specifier)) return;
      const entry = specifier.text;
      const local = entry.startsWith(".") || entry.startsWith("/src/");
      if (!local && !entry.startsWith("@tauri-apps/")) return;
      let target = entry;
      if (local) {
        target = entry.startsWith("/") ? posix.normalize(entry).slice(1) : posix.join(posix.dirname(path), entry);
        if (!posix.extname(target)) {
          target = [target + ".ts", target + ".tsx", target + "/index.ts"]
            .find((candidate) => existsSync(resolve(root, candidate))) ?? target;
        }
      }
      targets.add(target);
      if (runtime) runtimeTargets.add(target);
    }
    function visit(node: ts.Node) {
      if (ts.isImportDeclaration(node)) {
        add(node.moduleSpecifier, !node.importClause?.isTypeOnly);
      } else if (ts.isExportDeclaration(node)) {
        add(node.moduleSpecifier, !node.isTypeOnly);
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        add(node.argument.literal, false);
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        add(node.moduleReference.expression, !node.isTypeOnly);
      } else if (ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        add(node.arguments[0], true);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    yield { path, targets: [...targets], runtimeTargets };
  }
}

it("keeps the production runtime import graph acyclic", () => {
  const graph = new Map(
    Array.from(productionImports("src"), ({ path, runtimeTargets }) => [path, runtimeTargets]),
  );
  const checked = new Set<string>();
  const active = new Map<string, number>();
  const trace: string[] = [];
  function visit(path: string) {
    const cycleStart = active.get(path);
    if (cycleStart !== undefined) {
      throw new Error(`Runtime import cycle: ${[...trace.slice(cycleStart), path].join(" -> ")}`);
    }
    const targets = graph.get(path);
    if (!targets || checked.has(path)) return;
    active.set(path, trace.length);
    trace.push(path);
    for (const target of targets) visit(target);
    trace.pop();
    active.delete(path);
    checked.add(path);
  }
  for (const path of graph.keys()) visit(path);
});

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
  for (const name of plugins) {
    const files = readdirSync(resolve(root, "src/plugins", name), {
      withFileTypes: true,
    }).filter((entry) => !entry.isDirectory() && typeScriptFile.test(entry.name));
    expect(files.map((entry) => entry.name), name).toEqual(
      expect.arrayContaining(["index.ts", "service.ts"]),
    );
    expect(
      files.filter((entry) => !pluginRootFiles.has(entry.name)).map((entry) => entry.name),
      `${name} has implementation files at the plugin root`,
    ).toEqual([]);
    const service = read(`src/plugins/${name}/service.ts`);
    expect(service, `${name} owns its Cordis service declaration`).toMatch(
      new RegExp(`declare module "cordis" \\{\\s+interface Context \\{\\s+${name}:`),
    );
  }
  expect(existsSync(resolve(root, "src/bootstrap/services.ts"))).toBe(false);
  expect(read("index.html")).toContain('src="/src/bootstrap/main.tsx"');
  for (const path of [
    "src/bootstrap/appMain.tsx",
    "src/bootstrap/diagnosticsMain.tsx",
    "src/plugins/acpConnection/pool/AcpConnectionPool.ts",
    "src/plugins/acpConnection/pool/RequestScheduler.ts",
    "src/plugins/acpRuntime/protocol/session.ts",
    "src/plugins/project/workspace/ProjectFactory.ts",
    "src/plugins/acpRuntime/catalog/catalogHistory.ts",
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

it("keeps the 15 core plugin names and all 82 dependency relations aligned with their production owners", async () => {
  const diagram = read("docs/cordis-plugin-dependencies.mmd");
  const documented = read("docs/cordis-plugin-dependencies.md")
    .match(/```mermaid\r?\n([\s\S]*?)\r?\n```/)?.[1];
  expect(documented?.replaceAll("\r\n", "\n")).toBe(diagram.trim().replaceAll("\r\n", "\n"));
  const nodes = [...diagram.matchAll(/^[ ]{4}(\w+)\[/gm)].map(
    (match) => match[1],
  );
  expect(nodes).toEqual(plugins);
  const required = ["host --> rust"];
  for (const name of plugins) {
    const definition = read(`src/plugins/${name}/index.ts`);
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
      "src/plugins/acpRuntime/index.ts",
      "agents.registerProbeSessions",
    ],
    [
      "workbench",
      "启动注入日志入口",
      "diagnostics",
      "src/bootstrap/bootstrap.ts",
      "createLogger: foundation.diagnostics.createLogger",
    ],
    [
      "host",
      "启动注入日志入口",
      "diagnostics",
      "src/bootstrap/foundation.ts",
      "const logSink = createDiagnosticsLogSink()",
    ],
    [
      "project",
      "注册标题区与新建会话入口",
      "workbench",
      "src/plugins/project/ui/workbench.ts",
      'workbench.register("collapsedHeaderActions"',
    ],
    [
      "documents",
      "登记文件路径解析",
      "workbench",
      "src/plugins/documents/ui/workbench.tsx",
      'workbench.register("pathResolvers"',
    ],
    [
      "documents",
      "可选：批注会话及工作区活动",
      "project",
      "src/plugins/documents/ui/workbench.tsx",
      'ctx.inject(["project"]',
    ],
    [
      "agents",
      "设置页读取项目上下文并请求切换 Agent",
      "project",
      "src/plugins/agents/ui/workbench.tsx",
      "project.sessions.switchAgent",
    ],
    [
      "project",
      "可选：技能候选",
      "skills",
      "src/plugins/project/ui/workbench.ts",
      "provider.candidates(names, invocations)",
    ],
    [
      "project",
      "可选：技能设置视图",
      "skills",
      "src/plugins/project/ui/workbench.ts",
      'ctx.inject(["skillsUi"]',
    ],
    [
      "project",
      "可选：健康检查脚本来源",
      "skills",
      "src/plugins/project/ui/workbench.ts",
      "provider.source.getSnapshot",
    ],
    [
      "workflow",
      "可选：工作流脚本来源",
      "skills",
      "src/plugins/workflow/ui/workbench.tsx",
      'ctx.inject(["skills"]',
    ],
    [
      "workflow",
      "注册工作区健康检查",
      "project",
      "src/plugins/workflow/index.ts",
      "project.projects.registerWorkspaceHealthCheck",
    ],
    [
      "project",
      "可选：文档上下文与导航",
      "documents",
      "src/plugins/project/ui/workbench.ts",
      'ctx.inject(["documents", "documentsUi"]',
    ],
    [
      "project",
      "可选：审阅上下文",
      "git",
      "src/plugins/project/ui/workbench.ts",
      'ctx.inject(["git", "gitUi"]',
    ],
    [
      "project",
      "可选：工作流进度",
      "workflow",
      "src/plugins/project/ui/workbench.ts",
      'ctx.inject(["workflowUi"]',
    ],
    [
      "documents",
      "可选：文件状态",
      "git",
      "src/plugins/documents/ui/workbench.tsx",
      'ctx.inject(["git"]',
    ],
    [
      "git",
      "可选：工作区活动刷新",
      "project",
      "src/plugins/git/ui/workbench.tsx",
      'ctx.inject(["project"]',
    ],
    [
      "updates",
      "安装前请求退出",
      "workbench",
      "src/plugins/updates/updater/updates.ts",
      "exit.requestExit",
    ],
    [
      "project",
      "登记退出检查与收尾",
      "workbench",
      "src/plugins/project/lifecycle/lifecycle.ts",
      "exit.registerExit",
    ],
    [
      "documents",
      "登记退出检查与收尾",
      "workbench",
      "src/plugins/documents/ui/workbench.tsx",
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
      "project",
      "订阅视图打开",
      "workbench",
      "src/plugins/project/ui/workbench.ts",
      "workbench.onViewOpened",
    ],
    [
      "documents",
      "登记未保存导航检查",
      "workbench",
      "src/plugins/documents/ui/workbench.tsx",
      "workbench.navigationGuard.register",
    ],
    [
      "terminal",
      "登记退出检查与收尾",
      "workbench",
      "src/plugins/terminal/pty/lifecycle.ts",
      "workbench.registerExit",
    ],
    [
      "documents",
      "登记项目关闭处理",
      "project",
      "src/plugins/documents/ui/workbench.tsx",
      "project.projects.registerProjectClose",
    ],
    [
      "terminal",
      "登记项目关闭处理",
      "project",
      "src/plugins/terminal/ui/workbench.ts",
      "project.projects.registerProjectClose",
    ],
  ] as const;
  const weak = optional.map(([source, label, target, file, marker]) => {
    expect(read(file), file).toContain(marker);
    return `${source} -. "${label}" .-> ${target}`;
  });
  expect(read("src/bootstrap/bootstrap.ts")).toContain("panelLayoutCompatibility: desktopPanelLayouts");
  const legacyPanels = read("src/bootstrap/panelLayouts.ts");
  for (const [owner, rule] of [
    ["documents", "documentPanelCompatibility"],
    ["git", "gitPanelCompatibility"],
    ["workflow", "workflowPanelCompatibility"],
  ] as const) {
    expect(legacyPanels).toContain(`import { ${rule} } from "../plugins/${owner}/service.ts"`);
    weak.push(`workbench -. "启动注入历史布局规则" .-> ${owner}`);
  }
  const assembly = read("src/bootstrap/installDesktopWorkbench.ts");
  for (const owner of ["workbench", ...uiOwners]) {
    expect(assembly).toContain(`import * as ${owner} from "../plugins/${owner}/index.ts"`);
    expect(assembly).toContain(`await ${owner}.installWorkbench(context)`);
  }
  expect(read("src/plugins/agents/index.ts")).toContain("ctx.plugin(workbench.agentSettings)");
  for (const owner of uiOwners) {
    weak.push(`${owner} -. "UI 注册" .-> workbench`);
  }
  const edges = diagram
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:\w+ --> \w+|\w+ -\. ".+" \.-> \w+)$/.test(line));
  expect(new Set(edges).size).toBe(82);
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
    expect(view.pages.filter((page) => page.default).map(({ id }) => id)).toEqual(["project-overview"]);
    expect(view.pages.filter((page) => page.fullView).map(({ id }) => id)).toEqual(["session"]);
    expect(view.sidebar.map(({ id }) => id)).toEqual(["project-tree"]);
    expect(view.accessGates.map(({ id }) => id)).toEqual(["account-login"]);
    expect(view.sidebarFooters.map(({ id }) => id)).toEqual(["account-profile"]);
    expect(view.startup.map(({ id }) => id)).toEqual(["project-preloading"]);
    expect(view.about.map(({ id }) => id)).toEqual(["active-agent"]);
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
    expect(view.helpItems.map(({ id }) => id)).toEqual(["diagnostics"]);
    expect(view.overlays.map(({ id, scope }) => [id, scope])).toEqual([
      ["project-dialogs", "workspace"],
      ["updates-dialog", "window"],
      ["documents-dialogs", "window"],
    ]);
    expect(view.headerIndicators.map(({ id }) => id)).toEqual(["updates"]);
    expect(view.settingsReset.map(({ id }) => id).sort()).toEqual(["agents", "project", "skills"]);
    expect(view.headers.map(({ id }) => id).sort()).toEqual(["project-overview", "session"]);
    expect(view.collapsedHeaderActions.map(({ id }) => id)).toEqual(["new-session"]);
    expect(view.exitDetails.map(({ id }) => id)).toEqual(["project-approvals"]);
    expect(view.docks.map(({ id }) => id)).toEqual(["terminal"]);
  } finally {
    await runtime.shutdown();
  }
});

it("exposes only service and event modules for runtime calls from outside the owner", () => {
  const violations: string[] = [];
  for (const { path, targets, runtimeTargets } of productionImports("src")) {
    for (const target of targets) {
      if (!isPluginImportAllowed(path, target, runtimeTargets.has(target)))
        violations.push(`${path} -> ${target}`);
    }
  }
  expect(violations).toEqual([]);
});

it("rejects config, internal modules and runtime types while preserving the assembly entry", () => {
  const caller = "src/plugins/project/index.ts";
  const bootstrap = "src/bootstrap/bootstrap.ts";
  const target = (file: string) => `src/plugins/agents/${file}`;
  expect(isPluginImportAllowed(caller, target("service.ts"), true)).toBe(true);
  expect(isPluginImportAllowed(caller, target("events.ts"), true)).toBe(true);
  expect(isPluginImportAllowed(caller, target("types.ts"), false)).toBe(true);
  expect(isPluginImportAllowed(caller, target("types.ts"), true)).toBe(false);
  expect(isPluginImportAllowed(caller, target("config.ts"), true)).toBe(false);
  expect(isPluginImportAllowed(caller, target("config.ts"), false)).toBe(false);
  expect(isPluginImportAllowed(caller, target("registry/service.ts"), true)).toBe(false);
  expect(isPluginImportAllowed(caller, target("index.ts"), true)).toBe(false);
  expect(isPluginImportAllowed(bootstrap, target("index.ts"), true)).toBe(true);
  expect(isPluginImportAllowed(bootstrap, target("config.ts"), true)).toBe(false);
  expect(isPluginImportAllowed(target("index.ts"), target("config.ts"), true)).toBe(true);
});

it("keeps protocol and connection code out of feature UI and product state", () => {
  const publicErrorModules = {
    "src/plugins/acpConnection": ["src/plugins/host/service.ts"],
    "src/plugins/acpRuntime": ["src/plugins/acpConnection/service.ts"],
  };
  for (const [directory, errorModules] of Object.entries(publicErrorModules)) {
    for (const { path, targets, runtimeTargets } of productionImports(directory)) {
      const invalid = targets.filter((target) =>
        (target.startsWith("src/plugins/") && !target.startsWith(`${directory}/`) &&
          (!isPluginImportAllowed(path, target, runtimeTargets.has(target)) ||
            (runtimeTargets.has(target) && !errorModules.includes(target)))) ||
        /(?:^|\/)(?:ui|stores)\/|^src\/bootstrap\//.test(target),
      );
      expect(invalid, path).toEqual([]);
    }
  }
});

it("keeps shared ACP wire definitions independent of Desktop services and product models", () => {
  for (const { path, targets } of productionImports("src/contracts/acp")) {
    expect(targets.filter((target) =>
      target.startsWith("src/") && !target.startsWith("src/contracts/acp/") &&
      target !== "src/shared/valueGuards.ts",
    ), path).toEqual([]);
  }
});

it("keeps public models and shared utilities independent of plugin implementations", () => {
  expect(readdirSync(resolve("src/contracts"))).toEqual(["acp"]);
  expect(readdirSync(resolve("src/shared"))).not.toContain("diagnosticEvents");
  const forbidden = {
    "src/plugins/host": /^src\/plugins\/(?!host\/)/,
    "src/plugins/workbench": /^src\/plugins\/(?!(?:workbench|host|configuration)\/)/,
    "src/shared": /^(?:src\/(?:plugins|bootstrap)\/|@tauri-apps\/)/,
  };
  for (const [directory, pattern] of Object.entries(forbidden)) {
    for (const { path, targets } of productionImports(directory))
      expect(targets.filter((target) => pattern.test(target)), path).toEqual([]);
  }
  const forbiddenRuntime = {
    "src/plugins/agents": /^(?:src\/plugins\/(?:acpConnection\/(?!service\.ts$)|(?:acpRuntime|host)\/)|@tauri-apps\/)/,
    "src/plugins/account": /^(?:src\/plugins\/host\/|@tauri-apps\/)/,
    "src/plugins/documents": /^src\/plugins\/project\//,
    "src/plugins/project": /^(?:src\/plugins\/(?:acpRuntime\/(?!service\.ts$)|workflow\/(?!(?:service|config)\.ts$)|(?:acpConnection|host)\/)|@tauri-apps\/)/,
  };
  for (const [directory, pattern] of Object.entries(forbiddenRuntime)) {
    for (const { path, runtimeTargets } of productionImports(directory))
      expect([...runtimeTargets].filter((target) => pattern.test(target)), path).toEqual([]);
  }
  for (const { path, targets } of productionImports("src/plugins")) {
    const owner = path.split("/").slice(0, 3).join("/");
    expect(targets.filter((target) =>
      target.startsWith("src/bootstrap/"),
    ), path).toEqual([]);
    if (owner !== "src/plugins/host")
      expect(targets.filter((target) => target.startsWith("@tauri-apps/")), path).toEqual([]);
  }
  for (const { path, targets } of productionImports("src/bootstrap")) {
    expect(targets.filter((target) =>
      target.startsWith("@tauri-apps/"),
    ), path).toEqual([]);
  }

  const localizedViews = new Set([
    "src/plugins/project/ui/settings.tsx",
    "src/plugins/skills/ui/SkillsSourceSettings.tsx",
  ]);
  for (const plugin of ["documents", "project", "skills", "terminal", "workflow"]) {
    for (const { path, runtimeTargets } of productionImports(`src/plugins/${plugin}/ui`)) {
      if (!localizedViews.has(path))
        expect(runtimeTargets.has("src/plugins/workbench/service.ts"), path).toBe(false);
    }
  }
});
