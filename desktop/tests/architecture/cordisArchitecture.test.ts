import { productionPluginNames } from "../helpers/productionPluginNames";
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
  "mcp",
  "account",
  "tools",
  "updates",
  "browser",
  "remoteProject",
  "scheduledTasks",
  "visual",
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
  "tools",
  "updates",
  "browser",
  "remoteProject",
  "visual",
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

function isPluginImportAllowed(
  source: string,
  target: string,
  runtime: boolean,
): boolean {
  if (!target.startsWith("src/plugins/")) return true;
  const [, , owner, file, ...remaining] = target.split("/");
  if (source.startsWith(`src/plugins/${owner}/`)) return true;
  if (remaining.length > 0) return false;
  return (
    file === "service.ts" ||
    file === "events.ts" ||
    (file === "types.ts" && !runtime) ||
    (file === "index.ts" && source.startsWith("src/bootstrap/"))
  );
}

function* productionImports(directory: string) {
  for (const file of readdirSync(resolve(root, directory), {
    recursive: true,
  })) {
    if (typeof file !== "string" || !typeScriptFile.test(file)) continue;
    const path = `${directory}/${file.replaceAll("\\", "/")}`;
    const targets = new Set<string>();
    const runtimeTargets = new Set<string>();
    const source = ts.createSourceFile(
      path,
      read(path),
      ts.ScriptTarget.Latest,
      true,
    );
    function add(specifier: ts.Node | undefined, runtime: boolean) {
      if (!specifier || !ts.isStringLiteralLike(specifier)) return;
      const entry = specifier.text;
      const local = entry.startsWith(".") || entry.startsWith("/src/");
      if (!local && !entry.startsWith("@tauri-apps/")) return;
      let target = entry;
      if (local) {
        target = entry.startsWith("/")
          ? posix.normalize(entry).slice(1)
          : posix.join(posix.dirname(path), entry);
        if (!posix.extname(target)) {
          target =
            [target + ".ts", target + ".tsx", target + "/index.ts"].find(
              (candidate) => existsSync(resolve(root, candidate)),
            ) ?? target;
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
      } else if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument)
      ) {
        add(node.argument.literal, false);
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        add(node.moduleReference.expression, !node.isTypeOnly);
      } else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require"))
      ) {
        add(node.arguments[0], true);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    yield { path, targets: [...targets], runtimeTargets, source };
  }
}

it("keeps the production runtime import graph acyclic", () => {
  const graph = new Map(
    Array.from(productionImports("src"), ({ path, runtimeTargets }) => [
      path,
      runtimeTargets,
    ]),
  );
  const checked = new Set<string>();
  const active = new Map<string, number>();
  const trace: string[] = [];
  function visit(path: string) {
    const cycleStart = active.get(path);
    if (cycleStart !== undefined) {
      throw new Error(
        `Runtime import cycle: ${[...trace.slice(cycleStart), path].join(" -> ")}`,
      );
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
  expect(productionPluginNames(resolve(root, "src/plugins"))).toEqual(
    [...plugins].sort(),
  );
  for (const name of plugins) {
    const files = readdirSync(resolve(root, "src/plugins", name), {
      withFileTypes: true,
    }).filter(
      (entry) => !entry.isDirectory() && typeScriptFile.test(entry.name),
    );
    expect(
      files.map((entry) => entry.name),
      name,
    ).toEqual(expect.arrayContaining(["index.ts", "service.ts"]));
    expect(
      files
        .filter((entry) => !pluginRootFiles.has(entry.name))
        .map((entry) => entry.name),
      `${name} has implementation files at the plugin root`,
    ).toEqual([]);
    const service = read(`src/plugins/${name}/service.ts`);
    expect(service, `${name} owns its Cordis service declaration`).toMatch(
      new RegExp(
        `declare module "cordis" \\{\\s+interface Context \\{\\s+${name}:`,
      ),
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

it("keeps plugin names and dependency relations aligned with their production owners", async () => {
  const diagram = read("docs/architecture/cordis-plugin-dependencies.mmd");
  const documented = read(
    "docs/architecture/cordis-plugin-dependencies.md",
  ).match(/```mermaid\r?\n([\s\S]*?)\r?\n```/)?.[1];
  expect(documented?.replaceAll("\r\n", "\n")).toBe(
    diagram.trim().replaceAll("\r\n", "\n"),
  );
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
    ...(["browser", "remoteProject", "visual", "workflow"] as const).map(
      (owner) =>
        [
          owner,
          "登记内置 MCP",
          "mcp",
          `src/plugins/${owner}/index.ts`,
          "scoped.mcp.registerBuiltin",
        ] as const,
    ),
    [
      "skills",
      "插件管理显示 MCP 页",
      "mcp",
      "src/plugins/skills/ui/workbench.tsx",
      "McpPage: mcp.View",
    ],
    [
      "skills",
      "技能页读取项目目录",
      "project",
      "src/plugins/skills/ui/workbench.tsx",
      "project.projects.workspace.getState()",
    ],
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
      "可选：项目界面扩展",
      "workflow",
      "src/plugins/project/ui/workbench.ts",
      'ctx.inject(["projectExtension"]',
    ],
    [
      "agents",
      "可选：切换前停下进行中的工作",
      "workflow",
      "src/plugins/agents/ui/workbench.tsx",
      'ctx.inject(["agentSwitchGuard"]',
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
    [
      "remoteProject",
      "登记项目关闭处理",
      "project",
      "src/plugins/remoteProject/ui/workbench.tsx",
      "project.projects.registerProjectClose",
    ],
    [
      "visual",
      "可选：可视化演示 MCP 端点",
      "host",
      "src/plugins/visual/index.ts",
      "scoped.host.visualGuide",
    ],
    [
      "visual",
      "登记会话附加工具",
      "project",
      "src/plugins/visual/index.ts",
      "scoped.project.sessions.registerSessionTools(",
    ],
    [
      "project",
      "可选：添加远程项目入口",
      "remoteProject",
      "src/plugins/project/ui/workbench.ts",
      'ctx.inject(["remoteProjectUi"]',
    ],
  ] as const;
  const weak = optional.map(([source, label, target, file, marker]) => {
    expect(read(file), file).toContain(marker);
    return `${source} -. "${label}" .-> ${target}`;
  });
  expect(read("src/bootstrap/bootstrap.ts")).toContain(
    "panelLayoutCompatibility: desktopPanelLayouts",
  );
  const legacyPanels = read("src/bootstrap/panelLayouts.ts");
  for (const [owner, rule] of [
    ["documents", "documentPanelCompatibility"],
    ["git", "gitPanelCompatibility"],
    ["workflow", "workflowPanelCompatibility"],
  ] as const) {
    expect(legacyPanels).toContain(
      `import { ${rule} } from "../plugins/${owner}/service.ts"`,
    );
    weak.push(`workbench -. "启动注入历史布局规则" .-> ${owner}`);
  }
  const assembly = read("src/bootstrap/installDesktopWorkbench.ts");
  for (const owner of ["workbench", ...uiOwners]) {
    expect(assembly).toContain(
      `import * as ${owner} from "../plugins/${owner}/index.ts"`,
    );
    expect(assembly).toContain(`await ${owner}.installWorkbench(context)`);
  }
  expect(read("src/plugins/agents/index.ts")).toContain(
    "ctx.plugin(workbench.agentSettings)",
  );
  for (const owner of uiOwners) {
    weak.push(`${owner} -. "UI 注册" .-> workbench`);
  }
  const edges = diagram
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:\w+ --> \w+|\w+ -\. ".+" \.-> \w+)$/.test(line));
  expect(new Set(edges).size).toBe(required.length + weak.length);
  expect(edges.sort()).toEqual([...required, ...weak].sort());

  const runtime = createTestDesktopRuntime(
    {
      attachPreloading: () => () => {},
      close: () => Promise.resolve(),
    },
    undefined,
    async (context) => {
      await installDesktopWorkbench(context);
      for (const name of plugins.filter((item) => item !== "scheduledTasks"))
        expect(context.get(name), name).toBeDefined();
      expect(
        context.mcp.builtins
          .getState()
          .map(({ id }) => id)
          .sort(),
      ).toEqual(
        [
          "aaw-remote-project",
          "aaw-workflow-authoring",
          "aaw-workflow-result",
          ...(context.host.browser.isAvailable() ? ["aaw-browser"] : []),
          ...(context.host.visualGuide ? ["aaw-visual"] : []),
        ].sort(),
      );
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
    expect(
      view.pages.filter((page) => page.default).map(({ id }) => id),
    ).toEqual(["project-overview"]);
    expect(
      view.pages.filter((page) => page.fullView).map(({ id }) => id),
    ).toEqual(["session"]);
    const rail = [...view.sidebar].sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0),
    );
    expect(rail.map(({ id }) => id)).toEqual([
      "project-tree",
      "workflow",
      "scheduled-tasks",
      "plugin-management",
    ]);
    expect(rail.filter(({ WorkArea }) => WorkArea).map(({ id }) => id)).toEqual(
      ["workflow", "scheduled-tasks", "plugin-management"],
    );
    expect(
      view.sidebar.filter((entry) => entry.default).map(({ id }) => id),
    ).toEqual(["project-tree"]);
    expect(view.accessGates.map(({ id }) => id)).toEqual(["account-login"]);
    expect(view.sidebarFooters.map(({ id }) => id)).toEqual([
      "account-profile",
    ]);
    expect(view.startup.map(({ id }) => id)).toEqual(["project-preloading"]);
    expect(view.about.map(({ id }) => id)).toEqual(["active-agent"]);
    expect(view.panels.map(({ id }) => id).sort()).toEqual([
      "aaw",
      "browser",
      "diff",
      "directory",
      "file",
      "files",
      "git",
      // 工具预览是独立标签：能和工具列表、文件、终端并排存在。
      "tool-preview",
      "tools",
    ]);
    expect(view.settings.map(({ id }) => id).sort()).toEqual([
      "agents",
      "archive",
      "browser",
      "general",
      "remote-hosts",
      "scheduled-tasks",
      "session",
      "storage",
      "tools",
      "updates",
    ]);
    expect(view.helpItems.map(({ id }) => id)).toEqual(["diagnostics"]);
    expect(view.overlays.map(({ id, scope }) => [id, scope])).toEqual([
      ["storage-monitor", "sidebar"],
      ["agent-switch-progress", "window"],
      ["project-dialogs", "workspace"],
      ["updates-dialog", "window"],
      ["documents-dialogs", "window"],
      ["remote-project-recovery", "workspace"],
      ["remote-project-add-modal", "window"],
    ]);
    expect(view.headerIndicators.map(({ id }) => id)).toEqual(["updates"]);
    expect(view.settingsReset.map(({ id }) => id).sort()).toEqual([
      "agents",
      "project",
      "skills",
    ]);
    expect(view.headers.map(({ id }) => id).sort()).toEqual([
      "project-overview",
      "session",
    ]);
    expect(view.collapsedHeaderActions.map(({ id }) => id)).toEqual([
      "new-session",
    ]);
    expect(view.exitDetails.map(({ id }) => id)).toEqual(["project-approvals"]);
    expect(view.docks.map(({ id }) => id)).toEqual(["terminal"]);
  } finally {
    await runtime.shutdown();
  }
}, 30_000);

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

it("MCP 目录通过服务注册接收内置条目，页面无需导入所属插件", () => {
  const dependencies = new Set([
    "mcp",
    "host",
    "agents",
    "project",
    "diagnostics",
    "acpRuntime",
  ]);
  for (const { path, targets } of productionImports("src/plugins/mcp")) {
    const imports = targets.filter(
      (target) =>
        target.startsWith("src/plugins/") &&
        !dependencies.has(target.split("/")[2]!),
    );
    expect(imports, path).toEqual([]);
  }
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
  expect(
    isPluginImportAllowed(caller, target("registry/service.ts"), true),
  ).toBe(false);
  expect(isPluginImportAllowed(caller, target("index.ts"), true)).toBe(false);
  expect(isPluginImportAllowed(bootstrap, target("index.ts"), true)).toBe(true);
  expect(isPluginImportAllowed(bootstrap, target("config.ts"), true)).toBe(
    false,
  );
  expect(
    isPluginImportAllowed(target("index.ts"), target("config.ts"), true),
  ).toBe(true);
});

it("keeps protocol and connection code out of feature UI and product state", () => {
  const publicErrorModules = {
    "src/plugins/acpConnection": ["src/plugins/host/service.ts"],
    "src/plugins/acpRuntime": ["src/plugins/acpConnection/service.ts"],
  };
  for (const [directory, errorModules] of Object.entries(publicErrorModules)) {
    for (const { path, targets, runtimeTargets } of productionImports(
      directory,
    )) {
      const invalid = targets.filter(
        (target) =>
          (target.startsWith("src/plugins/") &&
            !target.startsWith(`${directory}/`) &&
            (!isPluginImportAllowed(path, target, runtimeTargets.has(target)) ||
              (runtimeTargets.has(target) &&
                !errorModules.includes(target)))) ||
          /(?:^|\/)(?:ui|stores)\/|^src\/bootstrap\//.test(target),
      );
      expect(invalid, path).toEqual([]);
    }
  }
});

it("keeps shared ACP wire definitions independent of Desktop services and product models", () => {
  for (const { path, targets } of productionImports("src/contracts/acp")) {
    expect(
      targets.filter(
        (target) =>
          target.startsWith("src/") &&
          !target.startsWith("src/contracts/acp/") &&
          target !== "src/shared/valueGuards.ts",
      ),
      path,
    ).toEqual([]);
  }
});

it("keeps MCP contracts independent of Desktop runtime and plugins", () => {
  for (const { path, targets } of productionImports("src/contracts/mcp")) {
    expect(
      targets.filter((target) =>
        /^(?:src\/(?:plugins|bootstrap)\/|@tauri-apps\/)/.test(target),
      ),
      path,
    ).toEqual([]);
  }
});

it("keeps public models and shared utilities independent of plugin implementations", () => {
  expect(readdirSync(resolve("src/contracts")).sort()).toEqual([
    "acp",
    "browser",
    "mcp",
    "turnChanges",
  ]);
  expect(readdirSync(resolve("src/shared"))).not.toContain("diagnosticEvents");
  const forbidden = {
    "src/plugins/host": /^src\/plugins\/(?!host\/)/,
    "src/plugins/workbench":
      /^src\/plugins\/(?!(?:workbench|host|configuration)\/)/,
    "src/shared": /^(?:src\/(?:plugins|bootstrap)\/|@tauri-apps\/)/,
  };
  for (const [directory, pattern] of Object.entries(forbidden)) {
    for (const { path, targets } of productionImports(directory))
      expect(
        targets.filter((target) => pattern.test(target)),
        path,
      ).toEqual([]);
  }
  const forbiddenRuntime = {
    "src/plugins/agents":
      /^(?:src\/plugins\/(?:acpConnection\/(?!service\.ts$)|(?:acpRuntime|host)\/)|@tauri-apps\/)/,
    "src/plugins/account": /^(?:src\/plugins\/host\/|@tauri-apps\/)/,
    "src/plugins/documents": /^src\/plugins\/project\//,
    "src/plugins/project":
      /^(?:src\/plugins\/(?:acpRuntime\/(?!service\.ts$)|workflow\/(?!(?:service|config)\.ts$)|(?:acpConnection|host)\/)|@tauri-apps\/)/,
  };
  for (const [directory, pattern] of Object.entries(forbiddenRuntime)) {
    for (const { path, runtimeTargets } of productionImports(directory))
      expect(
        [...runtimeTargets].filter((target) => pattern.test(target)),
        path,
      ).toEqual([]);
  }
  for (const { path, targets } of productionImports("src/plugins")) {
    const owner = path.split("/").slice(0, 3).join("/");
    expect(
      targets.filter((target) => target.startsWith("src/bootstrap/")),
      path,
    ).toEqual([]);
    if (owner !== "src/plugins/host")
      expect(
        targets.filter((target) => target.startsWith("@tauri-apps/")),
        path,
      ).toEqual([]);
  }
  for (const { path, targets } of productionImports("src/bootstrap")) {
    expect(
      targets.filter((target) => target.startsWith("@tauri-apps/")),
      path,
    ).toEqual([]);
  }

  const localizedViews = new Set([
    "src/plugins/project/ui/settings.tsx",
    "src/plugins/skills/ui/SkillsSourceSettings.tsx",
  ]);
  for (const plugin of [
    "documents",
    "project",
    "skills",
    "terminal",
    "workflow",
  ]) {
    for (const { path, runtimeTargets } of productionImports(
      `src/plugins/${plugin}/ui`,
    )) {
      if (!localizedViews.has(path))
        expect(
          runtimeTargets.has("src/plugins/workbench/service.ts"),
          path,
        ).toBe(false);
    }
  }
});

it("引用导航由插件声明，信息流不依赖打开方式的插件实现", () => {
  const message = read(
    "src/plugins/project/conversation/ui/AssistantMessage.tsx",
  );
  const markdown = read("src/shared/ui/MarkdownView.tsx");
  for (const source of [message, markdown]) {
    expect(source).not.toMatch(/from ["'][^"']*\/(browser|documents|office)\//);
    expect(source).not.toMatch(/pathResolvers|documentTab\(/);
  }
  const dispatch = read("src/plugins/workbench/composition/workbench.ts");
  expect(dispatch).not.toMatch(/pathResolvers(?:\[0\]|\.at\(0\))/);
  expect(dispatch).not.toMatch(/from ["'][^"']*\/(browser|documents|office)\//);
});

function referenceNavigationViolations(path: string, ast: ts.SourceFile) {
  const errors: string[] = [];
  const messageUi =
    path.startsWith("src/plugins/project/conversation/") ||
    path.startsWith("src/shared/ui/");
  const dispatcher = path === "src/plugins/workbench/composition/workbench.ts";
  const observes = [
    "src/plugins/workbench/ui/bindings/react.ts",
    "src/plugins/project/ui/workbenchViews.tsx",
  ].includes(path);
  function visit(node: ts.Node) {
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node)) return;
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) {
      const name = node.text;
      const p = node.parent;
      if (!dispatcher && ["pathResolvers", "pathInspectors"].includes(name)) {
        const registration =
          ts.isCallExpression(p) &&
          p.arguments[0] === node &&
          ts.isPropertyAccessExpression(p.expression) &&
          p.expression.name.text === "register";
        const observation =
          observes &&
          name === "pathResolvers" &&
          ((ts.isPropertyAccessExpression(p) &&
            ts.isArrowFunction(p.parent) &&
            p.parent.body === p) ||
            (ts.isPropertyAccessExpression(p) &&
              ts.isBinaryExpression(p.parent) &&
              p.parent.operatorToken.kind ===
                ts.SyntaxKind.EqualsEqualsEqualsToken) ||
            (ts.isCallExpression(p) &&
              p.expression.getText(ast) === "useWorkbenchEntries"));
        if (!registration && !observation) errors.push(name);
      }
      if (
        messageUi &&
        [
          "openExternal",
          "documentTab",
          "presentDocumentTab",
          "openAbsoluteFile",
          "openFileManager",
          "createTab",
          "openTab",
        ].includes(name)
      )
        errors.push(name);
    }
    if (
      messageUi &&
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "open" &&
      /(?:^|\.)(window|globalThis|panels)$/.test(node.expression.getText(ast))
    )
      errors.push(node.getText(ast));
    if (
      messageUi &&
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText(ast) === "a" &&
      node.attributes.properties.some(
        (a) => ts.isJsxAttribute(a) && a.name.getText(ast) === "href",
      )
    )
      errors.push("a[href]");
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return errors;
}

it("新增引用入口不能直接选择处理插件或绕过 openPath", () => {
  for (const { path, source } of productionImports("src")) {
    expect(referenceNavigationViolations(path, source), path).toEqual([]);
  }
});

it.each([
  [
    "src/plugins/future/actions.ts",
    "snapshot.pathResolvers[0].resolve(target)",
  ],
  [
    "src/plugins/future/actions.ts",
    "const {pathInspectors: inspectors} = snapshot",
  ],
  [
    "src/plugins/project/conversation/ui/NewLink.tsx",
    "const {openExternal: launch} = host",
  ],
  ["src/shared/ui/NewReference.tsx", "panels.open(project, tab)"],
  ["src/shared/ui/NewReference.tsx", "window.open(url)"],
  ["src/shared/ui/NewReference.tsx", "const link = <a href={target}>open</a>"],
])("禁止跳转旁路 %s %s", (path, code) => {
  const ast = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true);
  expect(referenceNavigationViolations(path, ast)).not.toEqual([]);
});
