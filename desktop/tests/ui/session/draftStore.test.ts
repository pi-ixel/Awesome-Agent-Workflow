/**
 * 草稿持久化（draftStore）：key 形状（工作区编码 + 会话档位）与写读往返。
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  draftScopeKey,
  NEW_SESSION_DRAFT_SCOPE,
  readDraft,
  writeDraft,
} from "../../../src/ui/session/draftStore.ts";

describe("draftStore", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("key 形状：工作区编码；会话未建立时落 __new__ 档位", () => {
    expect(draftScopeKey("D:/dev/项目 A", null)).toBe(
      `aaw-desktop/draft/${encodeURIComponent("D:/dev/项目 A")}/${NEW_SESSION_DRAFT_SCOPE}`,
    );
    expect(draftScopeKey("D:/w", "s-42")).toBe(
      `aaw-desktop/draft/${encodeURIComponent("D:/w")}/s-42`,
    );
  });

  it("写读往返；空串删键不留残迹", () => {
    const key = draftScopeKey("D:/w", "s1");
    writeDraft(key, "下一条要问的");
    expect(readDraft(key)).toBe("下一条要问的");
    writeDraft(key, "");
    expect(window.localStorage.getItem(key)).toBeNull();
    expect(readDraft(key)).toBe("");
  });

  it("未发送草稿按项目共用，切换 Agent 不产生副本；正式会话仍按 Agent 隔离", () => {
    const a = draftScopeKey("D:/w", null, "agent-a");
    const b = draftScopeKey("D:/w", null, "agent-b");
    expect(a).toBe(b);
    writeDraft(a, "当前输入");
    expect(readDraft(b)).toBe("当前输入");
    expect(localStorage.length).toBe(1);
    expect(draftScopeKey("D:/w", "same", "agent-a")).not.toBe(
      draftScopeKey("D:/w", "same", "agent-b"),
    );
    expect(draftScopeKey("D:/other", null, "agent-a")).not.toBe(a);
  });

  it("不同会话 / 工作区的草稿互不串档", () => {
    writeDraft(draftScopeKey("D:/w", "s1"), "会话一的草稿");
    writeDraft(draftScopeKey("D:/w", "s2"), "会话二的草稿");
    writeDraft(draftScopeKey("D:/other", "s1"), "另一工作区的草稿");
    expect(readDraft(draftScopeKey("D:/w", "s1"))).toBe("会话一的草稿");
    expect(readDraft(draftScopeKey("D:/w", "s2"))).toBe("会话二的草稿");
    expect(readDraft(draftScopeKey("D:/other", "s1"))).toBe("另一工作区的草稿");
  });
});
