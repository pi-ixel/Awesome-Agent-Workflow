/**
 * @ 提及纯逻辑：触发检测（@ 段结尾）与候选过滤（子串优先 + 子序列兜底）。
 */
import { describe, expect, it } from "vitest";

import {
  detectMentionTrigger,
  filterMentionFiles,
} from "../../../src/plugins/project/conversation/ui/mention.ts";

describe("detectMentionTrigger", () => {
  it("行首/空白后的 @ 段命中，返回查询串", () => {
    expect(detectMentionTrigger("@")).toBe("");
    expect(detectMentionTrigger("@sr")).toBe("sr");
    expect(detectMentionTrigger("看一下 @src/ap")).toBe("src/ap");
    expect(detectMentionTrigger("（@aaw")).toBe("aaw");
  });

  it("邮箱 / 文本中段的 @ 不触发", () => {
    expect(detectMentionTrigger(" mail@example.com")).toBeNull();
    expect(detectMentionTrigger("没有符号")).toBeNull();
    expect(detectMentionTrigger("a@b")).toBeNull();
  });

  it("@ 后跟空白即结束触发段", () => {
    expect(detectMentionTrigger("@sr ")).toBeNull();
  });
});

describe("filterMentionFiles", () => {
  const files = [
    "README.md",
    ".sdd/SR-001/state.json",
    "skills/aaw-workflow/SKILL.md",
    "src/ui/session/ChatInput.tsx",
    "docs/architecture.md",
  ];

  it("空查询给前几条；子串匹配按位置排序", () => {
    expect(filterMentionFiles(files, "", 3)).toEqual([
      "README.md",
      ".sdd/SR-001/state.json",
      "skills/aaw-workflow/SKILL.md",
    ]);
    expect(filterMentionFiles(files, "sdd")).toEqual([
      ".sdd/SR-001/state.json",
    ]);
  });

  it("分隔符与大小写不敏感：糙输入也能命中", () => {
    expect(filterMentionFiles(["src/ui/ChatInput.tsx"], "chatinput")).toEqual([
      "src/ui/ChatInput.tsx",
    ]);
    expect(filterMentionFiles(["src\\ui\\Chat.tsx"], "ui/chat")).toEqual([
      "src\\ui\\Chat.tsx",
    ]);
  });

  it("子串落空时子序列兜底；命中上限 8", () => {
    expect(filterMentionFiles(["architecture.md"], "ach")).toEqual([
      "architecture.md",
    ]);
    const many = Array.from({ length: 20 }, (_, i) => `mod${i}.ts`);
    expect(filterMentionFiles(many, "mod")).toHaveLength(8);
  });
});

// ---------------------------------------------------------------- 多源候选（M6）
import {
  filterMentionOptions,
  skillMentionInsert,
} from "../../../src/plugins/project/conversation/ui/mention.ts";

describe("filterMentionOptions 多源（文件 + skills）", () => {
  it("文件组在前插 @路径，skills 组在后插提示文本", () => {
    const options = filterMentionOptions(
      ["src/app.ts", "README.md"],
      ["aaw-workflow", "code-check"],
      "",
    );
    expect(options[0]).toMatchObject({ kind: "file", label: "src/app.ts" });
    expect(options[0]?.insert).toBe("@src/app.ts ");
    const skill = options.find((option) => option.kind === "skill");
    expect(skill?.label).toBe("aaw-workflow");
    expect(skill?.insert).toBe(skillMentionInsert("aaw-workflow"));
  });

  it("query 同时过滤两组：文件与 skill 同口径模糊", () => {
    const options = filterMentionOptions(
      ["src/aaw-config.ts", "docs/x.md"],
      ["aaw-workflow", "other"],
      "aaw",
    );
    expect(options.some((o) => o.label === "src/aaw-config.ts")).toBe(true);
    expect(options.some((o) => o.label === "aaw-workflow")).toBe(true);
    expect(options.some((o) => o.label === "docs/x.md")).toBe(false);
    expect(options.some((o) => o.label === "other")).toBe(false);
  });
});
