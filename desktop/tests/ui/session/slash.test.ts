import { AAW_ENTRY_DEFINITIONS } from "../../../src/plugins/workflow/entryWizard.ts";
/**
 * slash 命令面板纯逻辑：行首触发检测（含顿号归一）、目录组装与过滤
 * （静态命令 + skills 限额）、token 替换。
 */
import { describe, expect, it } from "vitest";

import {
  buildSlashItems,
  detectSlashTrigger,
  filterSlashItems,
  replaceSlashToken,
  skillInsertText,
} from "../../../src/plugins/project/conversation/ui/slash.ts";

describe("detectSlashTrigger", () => {
  it("行首 / 触发；行中 / 不触发；顿号行首归一", () => {
    expect(detectSlashTrigger("/")).toBe("");
    expect(detectSlashTrigger("/cl")).toBe("cl");
    expect(detectSlashTrigger("、sr")).toBe("sr");
    // 多行场景：光标在第二行行首
    expect(detectSlashTrigger("第一行\n/dev")).toBe("dev");
  });

  it("非行首、含空白、双斜杠都不触发", () => {
    expect(detectSlashTrigger("看 /cl")).toBeNull();
    expect(detectSlashTrigger("/a b")).toBeNull();
    expect(detectSlashTrigger("//")).toBeNull();
    expect(detectSlashTrigger("plain")).toBeNull();
  });
});

describe("buildSlashItems / filterSlashItems", () => {
  const entries = AAW_ENTRY_DEFINITIONS.map(({ id: label, title: description }) => ({
    id: `wizard-${label}`,
    label,
    description,
    run: () => {},
  }));
  const items = buildSlashItems(["aaw-workflow", "code-check"], [], undefined, entries);

  it("目录含内置命令、工作流入口与 skills", () => {
    const groups = new Set(items.map((item) => item.group));
    expect(groups).toEqual(new Set(["命令", "工作流入口", "Skills"]));
    expect(items.filter((item) => item.group === "命令")).toHaveLength(3);
    expect(items.filter((item) => item.group === "工作流入口")).toHaveLength(3);
    expect(items.some((item) => item.id === "skill:aaw-workflow")).toBe(true);
  });

  it("模糊过滤：前缀/子串命中；Skills 限额 6", () => {
    const manySkills = Array.from({ length: 20 }, (_, i) => `skill-${i}`);
    const all = buildSlashItems(manySkills, [], undefined, entries);
    // 空查询：静态 6 条 + skills 6 条
    const wide = filterSlashItems(all, "");
    expect(wide.filter((i) => i.group === "Skills")).toHaveLength(6);
    expect(wide).toHaveLength(12);

    // 子串：sr 命中 /sr 入口（也会命中 skill 名含 sr 的，这里无）
    const sr = filterSlashItems(all, "sr");
    expect(sr[0]).toMatchObject({ id: "wizard-sr", kind: "action" });

    // 归一子串：aaw workflow 命中 aaw-workflow（分隔符不敏感）
    const aaw = filterSlashItems(
      buildSlashItems(["aaw-workflow"]),
      "aawworkflow",
    );
    expect(aaw.some((item) => item.id === "skill:aaw-workflow")).toBe(true);

    // skill 项是 insert 类，携带提示文本
    const skill = aaw.find((item) => item.kind === "insert");
    expect(skill?.insertText).toBe(skillInsertText("aaw-workflow"));
  });

  it("agent 命令清单进「Agent 命令」组：插入 /名 尾空格，描述带参数提示", () => {
    const items = buildSlashItems(
      [],
      [
        { name: "review", description: "审查改动", inputHint: "可选说明" },
        { name: "plan", description: null, inputHint: null },
      ],
    );
    const agentItems = items.filter((item) => item.group === "Agent 命令");
    expect(agentItems.map((item) => item.id)).toEqual([
      "agent:review",
      "agent:plan",
    ]);
    expect(agentItems[0]).toMatchObject({
      label: "review",
      kind: "insert",
      insertText: "/review ",
      description: "审查改动（参数：可选说明）",
    });
    expect(agentItems[1]?.description).toBe("agent 侧命令");
    // 过滤与静态命令同口径
    expect(filterSlashItems(items, "rev")[0]?.id).toBe("agent:review");
  });

  it("无命中返回空", () => {
    expect(filterSlashItems(items, "zzz不存在的命令")).toHaveLength(0);
  });
});

describe("replaceSlashToken", () => {
  it("替换 /token 为插入文本并落光标", () => {
    const result = replaceSlashToken("帮我 /sr", "/sr".length + 3, "sr", "X ");
    expect(result.text).toBe("帮我 X ");
    expect(result.caret).toBe("帮我 X ".length);
  });

  it("action 类替换为空串（移除 /token）", () => {
    const result = replaceSlashToken("/clear", 6, "clear", "");
    expect(result.text).toBe("");
  });

  it("顿号形态同样可替换", () => {
    const result = replaceSlashToken("、dev", 4, "dev", "Y");
    expect(result.text).toBe("Y");
  });

  it("检测失准的兜底：追加在末尾", () => {
    const result = replaceSlashToken("abc", 1, "x", "Z");
    expect(result.text).toBe("abc Z");
  });
});
