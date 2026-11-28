import { Context } from "cordis";
import type {
  SkillQuery,
  SkillRemovalAction,
} from "../../src/plugins/host/types.ts";
import { Feedback } from "../../src/shared/ui/feedback.ts";
import { ToastHost } from "../../src/plugins/workbench/ui/ToastHost.tsx";
import { createStore } from "zustand";
import * as skillsWorkbench from "../../src/plugins/skills/ui/workbench.tsx";
import { McpView } from "../../src/plugins/mcp/ui/McpView.tsx";
import type { McpManagement } from "../../src/plugins/mcp/runtime/management.ts";
import { createTestBrowserHost } from "../helpers/browserHost.ts";
import { browserMcpContribution } from "../../src/plugins/browser/domain/mcpContribution.ts";
import { createBuiltinMcpRegistry } from "../../src/plugins/mcp/runtime/builtinRegistry.ts";
import {
  createTestSkills,
  skillsWorkbenchFixture,
} from "../helpers/skills.tsx";
import type {
  NativeSkillLibrary,
  SkillCatalog,
} from "../../src/plugins/host/types.ts";

export async function createSkillsCollection(isPreview = false) {
  const ctx = new Context();
  const skills = createTestSkills();
  const { workbench, Wrapper } = skillsWorkbenchFixture(skills);
  const project = "D:/release/checklists";
  const source = project + "/.codeagent/skills";
  const name = "发布准备和回滚预案的完整审查";
  const preview =
    "---\nname: release-review\n---\n# 发布检查\n\n核对发布产物并评估回滚预案。\n\n## 验收记录\n\n| 项目 | 状态 |\n| --- | --- |\n| 发布产物 | 待核对 |";
  const files: NonNullable<NativeSkillLibrary["files"]> = (
    _query,
    _skill,
    request,
  ) => {
    if (request.type === "directory") {
      return Promise.resolve({
        type: "directory",
        truncated: false,
        entries: [
          { name: "SKILL.md", kind: "file", bytes: 168 },
          { name: "mcp.json", kind: "file", bytes: 23 },
        ],
      });
    }
    return Promise.resolve({
      type: "text",
      text: request.path === "SKILL.md" ? preview : '{"server":"workspace"}\n',
      modifiedAt: Date.UTC(2026, 10, 19, 6, 30),
    });
  };
  let catalog: SkillCatalog = {
    profile: null,
    profiles: [],
    sources: [
      {
        path: source,
        label: "项目技能",
        project,
        kind: "directory",
        enabled: true,
        canImport: true,
      },
    ],
    entries: [
      {
        name,
        source,
        path: source + "/review",
        description:
          "审查发布准备、核对安装包和离线发布说明，并逐项验证升级路径和生产环境回滚预案。".repeat(
            8,
          ),
        realPath: source + "/review",
        preview,
        status: "正常",
        kind: "directory",
        isLink: false,
        revision: "r1",
      },
    ],
    trash: [
      {
        id: "old",
        name: "旧版发布检查",
        source,
        project,
        path: source + "/old",
        description: "已替换",
        kind: "directory",
      },
    ],
    warnings: [],
  };
  const sample = catalog.entries[0]!;
  if (isPreview) {
    catalog.entries.push(
      ...[
        ["代码审查", "核查改动、风险与回归测试。"],
        ["架构盘点", "梳理当前模块边界、入口、状态所有权与链路依赖。"],
        ["接口文档", "生成和验证接口示例。"],
        ["测试补齐", "从异常路径、历史数据和用户操作中补齐测试。"],
        ["发布说明", "按版本归纳变更与升级步骤。"],
      ].map(([name, description], index) => {
        const path = source + "/example-" + index;
        return {
          ...sample,
          name: name!,
          description: description!,
          path,
          realPath: path,
        };
      }),
    );
  }
  const change: NativeSkillLibrary["change"] = (_query, action) => {
    if (action.type === "delete") {
      const entry = catalog.entries.find(
        (item) => item.path === action.items[0]?.path,
      );
      if (entry)
        catalog = {
          ...catalog,
          entries: catalog.entries.filter((item) => item !== entry),
          trash: [...catalog.trash, { ...entry, id: entry.path, project }],
        };
      return Promise.resolve(["已停用"]);
    }
    if (action.type === "restore") {
      const entry = catalog.trash.find((item) => item.id === action.ids[0]);
      if (entry)
        catalog = {
          ...catalog,
          entries: [
            ...catalog.entries,
            { ...sample, ...entry, source, realPath: entry.path },
          ],
          trash: catalog.trash.filter((item) => item !== entry),
        };
      return Promise.resolve(["已恢复"]);
    }
    if (action.type === "deletePermanent") {
      catalog = {
        ...catalog,
        entries: catalog.entries.filter(
          (item) => item.path !== action.item.path,
        ),
      };
    } else if (action.type === "purge") {
      catalog = {
        ...catalog,
        trash: catalog.trash.filter((item) => !action.ids.includes(item.id)),
      };
    }
    return Promise.resolve(["已永久删除"]);
  };

  ctx.provide("workbench", workbench);
  ctx.provide("skills", skills);
  ctx.provide("project", {
    projects: {
      workspace: {
        getState: () => ({
          pinnedPaths: [],
          recentWorkspaces: [{ path: project, lastOpenedAt: null }],
        }),
      },
    },
  } as unknown as Context["project"]);
  ctx.provide("agents", {
    configuration: createStore(() => ({ activeAgentId: "codeagent" })),
    resolve: () => ({ skillLibrary: "codeagent" }),
  } as unknown as Context["agents"]);
  ctx.provide("host", {
    storage: { getItem: () => null, setItem: () => {} },
    dialogs: { pickDirectory: () => Promise.resolve(null) },
    files: { openInFileManager: () => Promise.resolve() },
    skills: {
      library: {
        list: () => Promise.resolve(catalog),
        candidates: () => Promise.resolve([]),
        change,
        files,
        toggle: async (
          query: SkillQuery,
          action: Parameters<NonNullable<NativeSkillLibrary["toggle"]>>[1],
        ) => {
          if (action.type === "enable") {
            await change(query, { type: "restore", ids: [action.id] });
            return {
              message: "已恢复",
              entry:
                catalog.entries.find((item) => item.path === action.id) ?? null,
              stopped: null,
            };
          }
          await change(query, {
            type: "delete",
            items: [
              {
                name: action.name,
                path: action.path,
                revision: action.revision,
              },
            ],
          });
          return {
            message: "已停用",
            entry: null,
            stopped:
              catalog.trash.find((item) => item.path === action.path) ?? null,
          };
        },
        remove: async (query: SkillQuery, action: SkillRemovalAction) => {
          await change(query, action);
          return action.type === "deletePermanent"
            ? [
                {
                  name: action.item.name,
                  path: action.item.path,
                  id: null,
                  ok: true,
                  message: "已永久删除",
                  stopped: null,
                },
              ]
            : [];
        },
      },
    },
  } as unknown as Context["host"]);
  const browser = createTestBrowserHost();
  const builtinCatalog = createBuiltinMcpRegistry();
  const browserTools = {
    browserTools: () =>
      Promise.resolve({ tools: [{ name: "browser_open" }], disabledTools: [] }),
    setBrowserTools: () => Promise.resolve([]),
  } as unknown as NonNullable<Parameters<typeof browserMcpContribution>[1]>;
  builtinCatalog.registerBuiltin(browserMcpContribution(browser, browserTools));
  const mcp = {
    host: {
      managedRead: () =>
        Promise.resolve({
          revision: "r1",
          entries: [
            {
              name: "发布服务",
              enabled: true,
              transport: "http",
              url: "http://localhost:9000/mcp",
              headers: [],
            },
          ],
        }),
    },
  } as unknown as McpManagement;
  ctx.provide("mcp", {
    ...builtinCatalog,
    View: () => (
      <McpView
        service={mcp}
        agentId="codeagent"
        activeProfile={null}
        builtins={builtinCatalog.builtins.getState()}
        canManageNative={false}
        canManageInjected
        canTest={false}
      />
    ),
    previewInstall: () => Promise.reject(new Error("预览安装未在夹具接入")),
    commitInstall: () => Promise.reject(new Error("提交安装未在夹具接入")),
  });

  await ctx.plugin(skillsWorkbench);
  const entry = workbench
    .getSnapshot()
    .sidebar.find(({ id }) => id === "plugin-management");
  if (!entry?.View || !entry.WorkArea)
    throw new Error("插件管理未注册导航和工作区");
  const { View, WorkArea } = entry;
  return function SkillsCollection() {
    return (
      <Wrapper>
        <Feedback.Provider value={workbench.showToast}>
          {isPreview ? (
            <div className="grid min-h-screen bg-base md:grid-cols-[10rem_minmax(0,1fr)]">
              <aside className="border-line bg-sidebar md:border-r">
                <View project={project} />
              </aside>
              <WorkArea project={project} />
            </div>
          ) : (
            <>
              <View project={project} />
              <WorkArea project={project} />
            </>
          )}
          <ToastHost />
        </Feedback.Provider>
      </Wrapper>
    );
  };
}
