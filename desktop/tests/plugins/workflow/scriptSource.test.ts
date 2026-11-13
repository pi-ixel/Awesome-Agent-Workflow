/**
 * 工作流脚本来源槽位（health/scriptSource.ts）：workbench 注入的 skills
 * 来源 → 健康检查的 aaw.py 路径回退（可选依赖 workflow -.-> skills 的
 * 消费点；旧 workspaceBinding 的 fallback 语义）。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  aawScriptFallback,
  attachAawScriptSource,
} from "../../../src/plugins/workflow/health/scriptSource.ts";
import type { SkillsSource } from "../../../src/plugins/skills/types.ts";

const sources: SkillsSource[] = [];

/** 一次性 SkillsSource 桩（快照 = 用户配置的 Skills 目录）。 */
function stubSource(directory: string): SkillsSource {
  const source: SkillsSource = {
    getSnapshot: () => directory,
    subscribe: () => {
      return () => {};
    },
  };
  sources.push(source);
  return source;
}

afterEach(() => {
  attachAawScriptSource(undefined);
});

describe("aawScriptFallback", () => {
  it("未注入来源 → 空串（不参与回退）", () => {
    expect(aawScriptFallback()).toBe("");
  });

  it("注入 skills 来源 → 按 deriveAawScriptPath 推导 aaw.py 路径", () => {
    attachAawScriptSource(stubSource("D:/repo/skills"));
    expect(aawScriptFallback()).toBe("D:/repo/skills/aaw-workflow/scripts/aaw.py");
  });

  it("来源目录为空 → 空串；注销后不再回退", () => {
    attachAawScriptSource(stubSource("   "));
    expect(aawScriptFallback()).toBe("");
    attachAawScriptSource(undefined);
    expect(aawScriptFallback()).toBe("");
  });
});
