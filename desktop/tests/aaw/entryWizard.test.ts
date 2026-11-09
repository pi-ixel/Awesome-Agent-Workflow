/**
 * 入口向导领域逻辑回归：三入口元数据、变量校验与首条 prompt 生成。
 */
import { describe, expect, it } from "vitest";
import {
  AAW_ENTRY_DEFINITIONS,
  buildEntryPrompt,
  entryTitleOf,
  validateEntryInput,
  type AawEntryInput,
} from "../../src/plugins/workflow/entryWizard.ts";

describe("AAW_ENTRY_DEFINITIONS", () => {
  it("三入口齐全且带中文场景说明", () => {
    expect(AAW_ENTRY_DEFINITIONS.map((entry) => entry.id)).toEqual([
      "sr",
      "ar",
      "dev",
    ]);
    for (const entry of AAW_ENTRY_DEFINITIONS) {
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.summary.length).toBeGreaterThan(0);
      expect(entry.vars.length).toBeGreaterThan(0);
    }
    expect(entryTitleOf("sr")).toBe("SR 严谨流程");
    expect(entryTitleOf("ar")).toBe("AR 从 AR 切入");
    expect(entryTitleOf("dev")).toBe("dev 个人轻量");
  });
});

describe("validateEntryInput", () => {
  const srPaste: AawEntryInput = {
    kind: "sr",
    sr: "SR-001",
    requirementMode: "paste",
    requirementFile: "",
    requirementText: "原始需求原文",
  };

  it("合法输入返回 null", () => {
    expect(validateEntryInput(srPaste)).toBeNull();
    expect(
      validateEntryInput({
        kind: "sr",
        sr: "SR-001",
        requirementMode: "file",
        requirementFile: "docs/req.md",
        requirementText: "",
      }),
    ).toBeNull();
    expect(
      validateEntryInput({
        kind: "ar",
        sr: "SR-001",
        ar: "AR-003",
        description: "登录改造",
      }),
    ).toBeNull();
    expect(
      validateEntryInput({
        kind: "dev",
        sr: "SR-009",
        requirement: "加深色模式",
      }),
    ).toBeNull();
  });

  it("缺失变量返回中文错误", () => {
    expect(validateEntryInput({ ...srPaste, sr: " " })).toMatch(/SR 编号/);
    expect(validateEntryInput({ ...srPaste, requirementText: "" })).toMatch(
      /需求原文/,
    );
    expect(
      validateEntryInput({
        kind: "sr",
        sr: "SR-001",
        requirementMode: "file",
        requirementFile: "",
        requirementText: "",
      }),
    ).toMatch(/需求文件路径/);
    expect(
      validateEntryInput({
        kind: "ar",
        sr: "SR-001",
        ar: "",
        description: "x",
      }),
    ).toMatch(/AR 编号/);
    expect(
      validateEntryInput({
        kind: "ar",
        sr: "SR-001",
        ar: "AR-1",
        description: "",
      }),
    ).toMatch(/AR 描述/);
    expect(
      validateEntryInput({ kind: "dev", sr: "SR-009", requirement: "" }),
    ).toMatch(/一句话/);
  });
});

describe("buildEntryPrompt", () => {
  it("SR 粘贴模式：含进入意图、入口、变量与原文围栏", () => {
    const prompt = buildEntryPrompt({
      kind: "sr",
      sr: "SR-001",
      requirementMode: "paste",
      requirementFile: "",
      requirementText: "第一行需求\n第二行需求",
    });
    expect(prompt).toContain("进入 AAW 工作流");
    expect(prompt).toContain("SR 严谨流程");
    expect(prompt).toContain("新建");
    expect(prompt).toContain("不要继续已有 SR");
    expect(prompt).toContain("SR 编号：SR-001");
    expect(prompt).toContain("<<<需求原文");
    expect(prompt).toContain("第一行需求\n第二行需求");
    expect(prompt).toContain(">>>");
    expect(prompt).toContain("落盘");
  });

  it("SR 文件模式：携带需求文件路径，不含原文围栏", () => {
    const prompt = buildEntryPrompt({
      kind: "sr",
      sr: "SR-002",
      requirementMode: "file",
      requirementFile: "docs/requirement.md",
      requirementText: "",
    });
    expect(prompt).toContain("requirement-file");
    expect(prompt).toContain("docs/requirement.md");
    expect(prompt).not.toContain("<<<需求原文");
  });

  it("AR 入口：携带 SR / AR 编号与描述", () => {
    const prompt = buildEntryPrompt({
      kind: "ar",
      sr: "SR-001",
      ar: "AR-003",
      description: "统一登录态",
    });
    expect(prompt).toContain("AR 从 AR 切入");
    expect(prompt).toContain("SR 编号：SR-001");
    expect(prompt).toContain("AR 编号：AR-003");
    expect(prompt).toContain("AR 描述：统一登录态");
  });

  it("dev 入口：携带一句话需求", () => {
    const prompt = buildEntryPrompt({
      kind: "dev",
      sr: "SR-009",
      requirement: "给设置页加深色模式开关",
    });
    expect(prompt).toContain("dev 个人轻量");
    expect(prompt).toContain("SR 编号：SR-009");
    expect(prompt).toContain("一句话需求：给设置页加深色模式开关");
    expect(prompt).toContain("进入 AAW 工作流");
  });
});
