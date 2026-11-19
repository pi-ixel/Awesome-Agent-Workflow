import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { parseToolPackage } from "../../../src/plugins/tools/runtime/package.ts";
import { platformFrameworkFiles, ruleIds, runToolRules, splitViolations, describeViolations } from "../../../src/plugins/tools/runtime/rules.ts";
import { toolGuide, toolGuideSkill, repairMessage } from "../../../src/plugins/tools/runtime/guide.ts";

const tool = (extra: Record<string, unknown> = {}) => parseToolPackage(JSON.stringify({
  schemaVersion: 1,
  id: "demo",
  name: "演示",
  version: "1.0.0",
  html: "<button id=go>Go</button><script>window.aawActions={run:async()=>({ok:true})}</script>",
  actions: [{ id: "run", description: "跑一下", inputSchema: { type: "object", properties: {} } }],
  ...extra,
}));

const ids = (problems: readonly { ruleId: string }[]) => problems.map((problem) => problem.ruleId);

it("accepts a self-contained tool that implements its declared actions", () => {
  expect(runToolRules(tool())).toEqual([]);
});

it("R1 blocks renaming an installed tool", () => {
  const problems = runToolRules(tool(), { previousId: "older-id" });
  expect(ids(problems)).toContain("R1");
  expect(splitViolations(problems).blocking).toHaveLength(1);
  // 提示要给出两条明确出路，否则 AI 只会把 id 改回去又撞一次。
  expect(problems[0]!.hint).toContain("older-id");
});

it("R2 blocks remote scripts and styles, because the sandbox cannot load them", () => {
  const external = tool({ html: '<script src="https://cdn.example/x.js"></script>' });
  expect(ids(runToolRules(external))).toContain("R2");
  const linked = tool({ html: '<link rel="stylesheet" href="//cdn.example/theme.css"><p>x</p>' });
  expect(ids(runToolRules(linked))).toContain("R2");
  // `<script src=>` 只是脚本字符串里的普通文本，不该被当成外链。
  expect(ids(runToolRules(tool({ html: "<script>const s='<script src=>'</script>" }))))
    .not.toContain("R2");
  // 相对路径是工具目录内的文件，ZIP 导入会一起落盘——这不是"加载不到的外部资源"。
  expect(ids(runToolRules(tool({
    html: '<link rel="stylesheet" href="./app.css"><script src="./app.js"></script>',
  })))).not.toContain("R2");
});

it("R3 blocks actions that were declared but never implemented", () => {
  const problems = runToolRules(tool({ html: "<p>没有动作实现</p>" }));
  expect(ids(problems)).toContain("R3");
  expect(splitViolations(problems).blocking.map((problem) => problem.ruleId)).toContain("R3");
});

it("R4/R6/R7 warn without blocking, so users keep their freedom", () => {
  const problems = runToolRules(tool({
    html: `<style>body{width:1200px}</style><script>
      localStorage.setItem("setting.indent", "2");
      localStorage.setItem("rows", "12");
      window.aawActions={run:async()=>({})};
    </script>`,
  }));
  expect(ids(problems)).toEqual(expect.arrayContaining(["R4", "R6", "R7"]));
  expect(splitViolations(problems).blocking).toEqual([]);
});

it("R5 flags a secret but never blocks", () => {
  const problems = runToolRules(tool({
    html: `<script>const token="sk-abcdefghijklmnopqrstuvwxyz";window.aawActions={run:async()=>({})}</script>`,
  }));
  const r5 = problems.filter((problem) => problem.ruleId === "R5");
  expect(r5).toHaveLength(1);
  expect(r5[0]!.level).toBe("warn");
});

it("R8 blocks networking that was not declared, and passes once declared", () => {
  const html = `<script>fetch("https://intranet.example/api").then(r=>r.json());window.aawActions={run:async()=>({})}</script>`;
  expect(ids(runToolRules(tool({ html })))).toContain("R8");
  expect(ids(runToolRules(tool({ html, permissions: { network: true } })))).not.toContain("R8");
});

it("R9 blocks smuggling platform framework files into the tool package", () => {
  // 框架文件由宿主提供，塞进 sourceFiles 等于把地基当成行李打包。
  const smuggled = tool({ sourceFiles: { "AGENTS.md": "平台规范", "notes/keep.md": "自己的笔记" } });
  const problems = runToolRules(smuggled).filter((problem) => problem.ruleId === "R9" && problem.level === "block");
  expect(problems).toHaveLength(1);
  expect(problems[0]!.message).toContain("AGENTS.md");
  expect(problems[0]!.message).not.toContain("keep.md");
  expect(splitViolations(runToolRules(smuggled)).blocking.map((p) => p.ruleId)).toContain("R9");
});

it("R9 warns on machine-bound paths without blocking a usable tool", () => {
  const bound = tool({ html: '<img src="C:\\Users\\me\\logo.png"><script>window.aawActions={run:async()=>({})}</script>' });
  const problems = runToolRules(bound).filter((problem) => problem.ruleId === "R9");
  expect(problems).toHaveLength(1);
  expect(problems[0]!.level).toBe("warn");
  expect(splitViolations(runToolRules(bound)).blocking).toEqual([]);
});

it("the framework file list the manual prints is the exact one the checker uses", () => {
  expect(platformFrameworkFiles).toContain("AGENTS.md");
  expect(platformFrameworkFiles).toContain("runtime.mjs");
  expect(new Set(platformFrameworkFiles).size).toBe(platformFrameworkFiles.length);
  // 手册正文（guide.ts 生成）必须真的列出这份清单，不能只写个概念。
  expect(toolGuide({ id: "demo", name: "演示" })).toContain("runtime.mjs");
});

it("keeps the manual and the checker on the same rule ids", () => {
  // vitest 在 jsdom 环境下 import.meta.url 不是 file:，用 cwd 定位仓库根更稳。
  const manual = readFileSync(resolve(process.cwd(), "../skills/tool-dev/SKILL.md"), "utf8");
  const guide = toolGuide({ id: "demo", name: "演示" });
  for (const id of ruleIds) {
    expect(manual).toContain(`| ${id} |`);
    expect(guide).toContain(`| ${id} |`);
  }
});

it("the committed skill manual is exactly the generated one (no drift)", () => {
  // 仓库里的 SKILL.md 是 `npm run tools:guide-skill` 的产物，不允许手改——
  // 一旦手改就会和运行时写进用户技能目录的版本漂移（历史上真实发生过）。
  const manual = readFileSync(resolve(process.cwd(), "../skills/tool-dev/SKILL.md"), "utf8");
  expect(manual).toBe(toolGuideSkill());
});

it("hands violations back to the agent as repair instructions", () => {
  const problems = runToolRules(tool({ html: "<p>没有动作实现</p>" }));
  const text = repairMessage(problems);
  expect(text).toContain("必须修");
  expect(text).toContain("R3");
  expect(text).toContain("改法：");
  expect(describeViolations(problems)).toContain("R3");
});
