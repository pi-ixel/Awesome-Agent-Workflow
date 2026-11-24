/**
 * ACP 资源池边界守卫（单 Agent 原则，ADR 024 §7 的资源纪律）：
 *
 * 桌面端只允许**一支** Agent 进程队伍——连接池只能由 acpRuntime 的资源层
 * （sessions/connections.ts）装配；建池入口不进插件可见的
 * AcpConnectionService 类型，运行时经 AcpConnectionInternals 单点收窄。
 * 本守卫用 TS AST 扫全仓源码，任何新出现的建池/收窄引用即红：
 *
 * 1. `createPool` 标识符只允许出现在 acpConnection 内部、
 *    acpRuntime/sessions/connections.ts（唯一装配点）与测试里；
 * 2. `AcpConnectionInternals`（类型收窄）只允许 acpConnection 自己、
 *    acpRuntime（装配 + 资源层）与测试引用；
 * 3. 连接池类（AcpConnectionPool / RequestScheduler）不得被 acpConnection
 *    之外的任何生产代码 import。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const typeScriptFile = /\.(?:[cm]?ts|tsx)$/;
const sources = new Map<string, ts.SourceFile>();
function sourceOf(path: string): ts.SourceFile {
  let source = sources.get(path);
  if (!source) {
    source = ts.createSourceFile(
      path,
      read(path),
      ts.ScriptTarget.Latest,
      true,
    );
    sources.set(path, source);
  }
  return source;
}

const CREATE_POOL_ALLOWED = [
  "src/plugins/acpConnection",
  "src/plugins/acpRuntime/sessions/connections.ts",
];
const INTERNALS_ALLOWED = [
  "src/plugins/acpConnection",
  "src/plugins/acpRuntime",
];
const POOL_CLASS_ALLOWED = ["src/plugins/acpConnection"];

function* productionFiles(directory: string): Generator<string> {
  for (const file of readdirSync(resolve(root, directory), {
    recursive: true,
  })) {
    if (typeof file !== "string" || !typeScriptFile.test(file)) continue;
    yield `${directory}/${file.replaceAll("\\", "/")}`;
  }
}

function identifiersOf(path: string, name: string): string[] {
  const source = sourceOf(path);
  const found: string[] = [];
  source.forEachChild(function walk(node: ts.Node) {
    if (ts.isIdentifier(node) && node.text === name) found.push(name);
    ts.forEachChild(node, walk);
  });
  return found;
}

function importsOf(path: string, specifierSuffix: string): boolean {
  const source = sourceOf(path);
  let found = false;
  source.forEachChild((node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (
        specifier &&
        ts.isStringLiteralLike(specifier) &&
        specifier.text.endsWith(specifierSuffix)
      ) {
        found = true;
      }
    }
  });
  return found;
}

const inAllowed = (path: string, allowed: readonly string[]) =>
  allowed.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

describe("ACP 资源池边界（单池原则）", () => {
  it("唯一装配点只能调用一次建池，任务必须复用配置分区", () => {
    const path = "src/plugins/acpRuntime/sessions/connections.ts";
    const source = ts.createSourceFile(
      path,
      read(path),
      ts.ScriptTarget.Latest,
      true,
    );
    const calls: ts.CallExpression[] = [];
    source.forEachChild(function walk(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "createPool"
      )
        calls.push(node);
      ts.forEachChild(node, walk);
    });
    expect(calls).toHaveLength(1);
    expect(read(path)).toContain("this.shared.scope(");
    expect(read(path)).toContain("pool.acquireSession(");
  });

  it("连接服务只装配有总额度的共享池，重复建池直接拒绝", () => {
    const service = read(
      "src/plugins/acpConnection/lifecycle/connectionService.ts",
    );
    expect(service).toContain("new SharedConnectionPool(");
    expect(service).toContain("if (this.pools.size > 0)");
    expect(service).toContain("this.physicalCount >= ACP_CONNECTION_POOL_SIZE");
    expect(service).toContain("this.opening++");
    expect(service).toContain("budgetedTransport(");
    const pool = read("src/plugins/acpConnection/pool/SharedConnectionPool.ts");
    expect(read("src/plugins/acpConnection/types.ts")).toContain(
      "ACP_CONNECTION_POOL_SIZE = 4",
    );
    expect(pool).toContain("this.slots.length >= ACP_CONNECTION_POOL_SIZE");
    expect(pool).toContain("this.slots.push(slot)");
    expect(pool).toContain("slot.users === 0");
    const source = ts.createSourceFile(
      "pool.ts",
      pool,
      ts.ScriptTarget.Latest,
      true,
    );
    const slots: ts.NewExpression[] = [];
    source.forEachChild(function walk(node: ts.Node) {
      if (
        ts.isNewExpression(node) &&
        node.expression.getText(source) === "AcpConnectionPool"
      )
        slots.push(node);
      ts.forEachChild(node, walk);
    });
    expect(slots).toHaveLength(1);
    expect(slots[0]!.arguments?.[3]?.getText(source)).toBe("1");
  });

  it("createPool 只出现在 acpConnection 内部与唯一装配点", () => {
    const offenders: string[] = [];
    for (const path of productionFiles("src")) {
      if (
        identifiersOf(path, "createPool").length > 0 &&
        !inAllowed(path, CREATE_POOL_ALLOWED)
      ) {
        offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("AcpConnectionInternals 只被 acpConnection / acpRuntime 引用", () => {
    const offenders: string[] = [];
    for (const path of productionFiles("src")) {
      if (importsOf(path, "acpConnection/service.ts")) {
        const source = read(path);
        if (
          source.includes("AcpConnectionInternals") &&
          !inAllowed(path, INTERNALS_ALLOWED)
        ) {
          offenders.push(path);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("连接池类不得被资源层之外的文件 import", () => {
    const offenders: string[] = [];
    for (const path of productionFiles("src")) {
      if (
        importsOf(path, "pool/AcpConnectionPool.ts") &&
        !inAllowed(path, POOL_CLASS_ALLOWED)
      )
        offenders.push(path);
      if (
        importsOf(path, "pool/RequestScheduler.ts") &&
        !inAllowed(path, POOL_CLASS_ALLOWED)
      )
        offenders.push(path);
      if (
        importsOf(path, "pool/SharedConnectionPool.ts") &&
        !inAllowed(path, POOL_CLASS_ALLOWED)
      )
        offenders.push(path);
      if (
        importsOf(path, "sessions/AcpSessionPool.ts") &&
        !inAllowed(path, ["src/plugins/acpRuntime"])
      )
        offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  it("守卫自身覆盖的目录确实存在（防目录改名后守卫空转）", () => {
    for (const prefix of [
      ...CREATE_POOL_ALLOWED,
      ...POOL_CLASS_ALLOWED,
      "tests/integration/connectionPool.test.ts",
    ]) {
      expect(existsSync(resolve(root, prefix)), prefix).toBe(true);
    }
  });

  it("模型手动刷新只借用当前会话的 ACP 连接，切模校验只在发送边界按探测结果放行", () => {
    const coordinator = "src/plugins/project/sessions/sessionCoordinator.ts";
    const actions = "src/plugins/project/conversation/actions.ts";
    const probe = sourceOf(coordinator)
      .statements.filter(ts.isFunctionDeclaration)
      .find(({ name }) => name?.text === "createSessionCoordinator")
      ?.body?.statements.filter(ts.isFunctionDeclaration)
      .find(({ name }) => name?.text === "refreshModels")
      ?.getText();
    expect(probe).toContain(
      "getProtocol().openModelProbe(session, runtime.adapter)",
    );
    expect(probe).toContain("probe.newSession(cwd)");
    expect(probe).toContain("await probe.closeSession()");
    expect(probe).not.toMatch(
      /\.(initialize|openBackground|openTransport|prompt|loadSession)\(/,
    );
    expect(read("src/plugins/acpRuntime/sessions/AcpSessionPool.ts")).toContain(
      "lease?.openModelProbe?.bind(lease)",
    );
    expect(read(actions)).toMatch(/fromRefresh = refreshedModels\?\.some/);
    expect(read(actions)).toMatch(/await binding\.setModel\(\s*modelId,/);
    const permitted = [
      actions,
      "src/plugins/project/conversation/sessionStore.ts",
      "src/plugins/acpRuntime/protocol/session.ts",
      "src/plugins/acpRuntime/types.ts",
    ];
    const offenders = [...productionFiles("src")].filter(
      (path) =>
        identifiersOf(path, "fromRefresh").length && !permitted.includes(path),
    );
    expect(offenders).toEqual([]);
  });
});
