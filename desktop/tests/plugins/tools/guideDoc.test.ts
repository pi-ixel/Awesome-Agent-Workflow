import { expect, it } from "vitest";
import {
  GUIDE_BODY_ANCHOR,
  guideBodyFromDoc,
  toolGuide,
  toolGuideFromDoc,
  toolGuideMarkdown,
  toolGuideSkill,
  toolGuideSkillFromDoc,
  type ToolGuideContext,
} from "../../../src/plugins/tools/runtime/guide.ts";
import {
  createToolProject,
  projectGuide,
  syncToolProjectGuide,
  syncToolProjectGuides,
  type ToolProjectIO,
} from "../../../src/plugins/tools/runtime/project.ts";

/**
 * 「改开发指导 → AGENTS.md / SKILL.md 跟着变」的传播链。
 *
 * 用户副本（`<数据根>/guide/guide.md`）以前只是指导窗口自己看的；现在它是
 * AGENTS.md 与技能目录的正文来源。这一组测试钉住三件事：
 * 1. 默认正文与编译模板逐字等价（不引入"窗口一份、项目一份"的第二真相）；
 * 2. 用户改了正文里的项目段落，AI 读到的跟着变；
 * 3. 正文被改坏（定位不到项目段落）时退回编译模板，绝不把残稿塞给 AI。
 */

const context: ToolGuideContext = { id: "demo", name: "演示" };

/** 带开发指导副本的内存宿主：模拟 Rust 侧 `tools_guide_runtime_text` 的返回。 */
function memoryIO(guideDoc: string | undefined | Error, initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const io: ToolProjectIO = {
    userDataDir: (namespace, directory) => Promise.resolve(`/data/${namespace}/${directory}`),
    pathExists: (path) => Promise.resolve(
      files.has(path) || [...files.keys()].some((key) => key.startsWith(`${path}/`)),
    ),
    listDirNames: (path) => Promise.resolve([...new Set([...files.keys()]
      .filter((key) => key.startsWith(`${path}/`))
      .map((key) => key.slice(path.length + 1).split("/")[0]!)
      .filter((name) => name.includes("/") === false))]),
    readTextFile: (path) => {
      const value = files.get(path);
      return value === undefined ? Promise.reject(new Error(`ENOENT ${path}`)) : Promise.resolve(value);
    },
    writeTextFile: (path, contents) => { files.set(path, contents); return Promise.resolve(); },
    movePath: (from, to) => {
      const moved = [...files.keys()].filter((key) => key === from || key.startsWith(`${from}/`));
      if (!moved.length) return Promise.reject(new Error(`ENOENT ${from}`));
      for (const key of moved) {
        const value = files.get(key)!;
        files.delete(key);
        files.set(`${to}${key.slice(from.length)}`, value);
      }
      return Promise.resolve();
    },
    ...(guideDoc === undefined ? {} : {
      readGuideDoc: () => guideDoc instanceof Error
        ? Promise.reject(guideDoc)
        : Promise.resolve(guideDoc),
    }),
  };
  return { io, files };
}

it("the compiled default doc round-trips to the exact compiled AGENTS.md body", () => {
  const doc = toolGuideMarkdown();
  expect(doc).toContain(GUIDE_BODY_ANCHOR);
  // 没人改过文档时，生成的 AGENTS.md 必须与编译模板逐字一致——
  // 传播链本身不能成为"窗口和项目悄悄分叉"的源头。
  expect(toolGuideFromDoc(doc, context)).toBe(toolGuide(context));
  expect(toolGuideSkillFromDoc(doc)).toBe(toolGuideSkill());
});

it("editing the doc's project section flows into AGENTS.md and SKILL.md", () => {
  const edited = toolGuideMarkdown().replace(
    "2. **有歧义一次问完**：把问题凑齐一次问，不要挤牙膏式逐条确认。",
    "2. **有歧义一次问完，并写进需求单**：这是团队加的硬规矩。",
  );
  expect(edited).not.toBe(toolGuideMarkdown());
  const guide = toolGuideFromDoc(edited, context)!;
  expect(guide).toContain("这是团队加的硬规矩。");
  expect(guide).toContain("工具 id 是 `demo`");
  // 占位符必须被换掉：AGENTS.md 是给一个具体项目读的，不是给人读的模板。
  expect(guide).not.toContain("<工具 id>");
  expect(toolGuideSkillFromDoc(edited)).toContain("这是团队加的硬规矩。");
  // 给人看的开头几节（怎么用指导窗口）不进 AGENTS.md。
  expect(guide).not.toContain("## 从这里开始");
});

it("falls back to the compiled template when the doc is unrecognisable", () => {
  const guide = toolGuideFromDoc("# 我乱改的一版\n\n没有那段正文了。", context);
  expect(guide).toBeUndefined();
  // 残稿截断：定位到锚点但正文太短，同样不能当规范用。
  expect(guideBodyFromDoc(`${GUIDE_BODY_ANCHOR}。`)).toBeUndefined();
});

it("createToolProject writes the user's guide copy into AGENTS.md", async () => {
  const edited = toolGuideMarkdown().replace(
    GUIDE_BODY_ANCHOR,
    `${GUIDE_BODY_ANCHOR}（团队定制版）`,
  );
  const { io, files } = memoryIO(edited);
  const created = await createToolProject(io, { id: "demo", name: "演示", owner: "u1" });
  const agents = files.get(`${created.dir}/AGENTS.md`)!;
  expect(agents).toContain("团队定制版");
  expect(agents).toContain("`demo`");
  // 对照：没有副本时仍是编译模板。
  const plain = memoryIO(undefined);
  const plainProject = await createToolProject(plain.io, { id: "demo", name: "演示", owner: "u1" });
  expect(plain.files.get(`${plainProject.dir}/AGENTS.md`)).toBe(toolGuide({ id: "demo", name: "演示" }));
});

it("projectGuide falls back to the compiled template when the host is absent or fails", async () => {
  expect(await projectGuide(memoryIO(undefined).io, context)).toBe(toolGuide(context));
  // 宿主抖动（存储迁移中、IPC 失败）：退回模板，不让一次读失败打断生成。
  expect(await projectGuide(memoryIO(new Error("storage migrated")).io, context)).toBe(toolGuide(context));
  // 副本被改得认不出项目段落：同样是退回模板。
  expect(await projectGuide(memoryIO("# 被改坏的文档").io, context)).toBe(toolGuide(context));
});

it("syncToolProjectGuide rewrites stale AGENTS.md and skips what is already current", async () => {
  const doc = toolGuideMarkdown();
  const edited = doc.replace("3. **先做最小版本**", "3. **先做最小可用版本（团队规矩）**");
  const { io, files } = memoryIO(doc);
  const created = await createToolProject(io, { id: "demo", name: "演示", owner: "u1" });
  // 文档没变：不写盘。
  expect(await syncToolProjectGuide(io, created.dir)).toBe(false);
  const before = files.get(`${created.dir}/AGENTS.md`);
  // 文档改了：刷新成新的。
  const changed = memoryIO(edited, {
    [`${created.dir}/manifest.json`]: files.get(`${created.dir}/manifest.json`)!,
    [`${created.dir}/AGENTS.md`]: before!,
  });
  expect(await syncToolProjectGuide(changed.io, created.dir)).toBe(true);
  expect(changed.files.get(`${created.dir}/AGENTS.md`)).toContain("团队规矩");
  // manifest 读不出来：跳过，不用目录名冒充 id 写一份错规范进去。
  const broken = memoryIO(edited, { [`${created.dir}/manifest.json`]: "{ 不是 JSON" });
  expect(await syncToolProjectGuide(broken.io, created.dir)).toBe(false);
});

it("syncToolProjectGuides keeps going when one project is broken", async () => {
  const doc = toolGuideMarkdown();
  const { io, files } = memoryIO(doc);
  const first = await createToolProject(io, { id: "one", name: "一", owner: "u1" });
  const second = await createToolProject(io, { id: "two", name: "二", owner: "u1" });
  files.set(`${second.dir}/manifest.json`, "不是 JSON");
  // 第二个项目坏了，第一个仍要刷新成功；不抛错——列表刷新带着它们跑。
  await expect(syncToolProjectGuides(io, [first.dir, second.dir])).resolves.toBeGreaterThanOrEqual(0);
  expect(files.get(`${first.dir}/AGENTS.md`)).toBeTruthy();
});
