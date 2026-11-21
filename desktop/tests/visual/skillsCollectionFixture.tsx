import { Context } from "cordis";
import { createStore } from "zustand";
import * as skillsWorkbench from "../../src/plugins/skills/ui/workbench.tsx";
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
          "审查发布准备、核对安装包和离线发布说明，并逐项验证升级路径和生产环境回滚预案。",
        realPath: source + "/review",
        preview,
        status: "正常",
        kind: "directory",
        isLink: false,
        revision: "r1",
        usageCount: null,
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
      },
    },
  } as unknown as Context["host"]);

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
      </Wrapper>
    );
  };
}
