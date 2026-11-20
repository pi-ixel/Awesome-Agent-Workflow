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

export async function createSkillsCollection() {
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
  const catalog: SkillCatalog = {
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
        description: "审查发布准备",
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
        path: source + "/old",
        description: "已替换",
        kind: "directory",
      },
    ],
    warnings: [],
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
        change: () => Promise.resolve([]),
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
        <View project={project} />
        <WorkArea project={project} />
      </Wrapper>
    );
  };
}
