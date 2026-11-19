/**
 * skill 名录兜底：skillSources 的 key 是各 skill 目录全路径，
 * 取末段即 skill 名（去重排序、TTL 缓存）。
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  listSkillNamesFromSources,
  resetSkillCatalogForTests,
  skillNamesFromSources,
} from "../../../../../src/plugins/agents/enhancements/icode/skillCatalog.ts";

const SOURCES = [
  { source: "C:/Users/15802/.agents/skills/aaw-workflow", count: 1 },
  { source: "C:\\Users\\15802\\.agents\\skills\\after-effects", count: 1 },
  { source: "D:/project/.zcode/skills/code-check", count: 1 },
  { source: "C:/Users/15802/.agents/skills/aaw-workflow", count: 1 },
];

beforeEach(() => {
  resetSkillCatalogForTests();
});

describe("skillNamesFromSources", () => {
  it("skill 名 = source 路径末段（兼容反斜杠），去重排序", () => {
    expect(skillNamesFromSources(SOURCES)).toEqual([
      "aaw-workflow",
      "after-effects",
      "code-check",
    ]);
  });

  it("空串/空白末段过滤", () => {
    expect(
      skillNamesFromSources([
        { source: "C:/x/skills/", count: 1 },
        { source: "ok-skill", count: 1 },
      ]),
    ).toEqual(["ok-skill"]);
  });
});

describe("listSkillNamesFromSources（缓存）", () => {
  it("同签名命中缓存；签名变化重算", () => {
    const first = listSkillNamesFromSources(SOURCES);
    const second = listSkillNamesFromSources(SOURCES);
    expect(second).toBe(first); // 同引用 = 命中缓存
    const changed = listSkillNamesFromSources([
      { source: "C:/new/another-skill", count: 1 },
    ]);
    expect(changed).toEqual(["another-skill"]);
  });
});
