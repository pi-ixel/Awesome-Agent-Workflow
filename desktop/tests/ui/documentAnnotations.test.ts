import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeAnnotationMessage,
  documentRevision,
  encodeAnnotationMessage,
  locateAnnotation,
  type DocumentAnnotation,
} from "../../src/contracts/documentAnnotations.ts";
import { createAnnotationDraftStore } from "../../src/plugins/project/composer/annotationDraftStore.ts";
import { webviewStorage } from "../../src/plugins/host/storage.ts";
import { draftScopeKey } from "../../src/plugins/project/composer/draftStore.ts";
import { documentTextIndex } from "../../src/plugins/documents/ui/documentAnnotationIndex.ts";
import { createSessionStore } from "../../src/plugins/project/conversation/sessionStore.ts";

const scope = draftScopeKey("D:/project", "A");
const other = draftScopeKey("D:/project", "B");
export const annotation: DocumentAnnotation = {
  id: "a1",
  project: "D:/project",
  path: "D:/project/design.md",
  source: false,
  quote: "目标文本",
  prefix: "之前 ",
  suffix: " 之后",
  offset: 3,
  revision: documentRevision("之前 目标文本 之后"),
  comment: "请解释这段",
};
let annotationDrafts = createAnnotationDraftStore(webviewStorage).service;
beforeEach(() => {
  localStorage.clear();
  annotationDrafts = createAnnotationDraftStore(webviewStorage).service;
});
afterEach(() => vi.restoreAllMocks());

describe("文档批注数据与恢复", () => {
  it("纯文本 ACP 往返保留原文、意见和定位信息，支持仅批注发送及历史 trim", () => {
    for (const text of ["", "请按这些意见修改"]) {
      const prompt = encodeAnnotationMessage(text, [annotation]);
      expect(decodeAnnotationMessage(prompt.trim())).toMatchObject({
        text,
        annotations: [annotation],
      });
    }
    expect(decodeAnnotationMessage("普通消息")).toBeNull();
  });
  it("拒绝损坏或过大引用，不将任意 JSON 识别为批注", () => {
    expect(
      decodeAnnotationMessage(
        encodeAnnotationMessage("", [
          { ...annotation, quote: "x".repeat(10001) },
        ]),
      ),
    ).toBeNull();
    expect(
      decodeAnnotationMessage(
        encodeAnnotationMessage("", [annotation]) + "invalid",
      ),
    ).toBeNull();
  });
  it("项目与会话隔离；重启恢复草稿", () => {
    const store = annotationDrafts.getState();
    expect(store.put(scope, [annotation])).toBe(true);
    store.ensure(other);
    expect(
      annotationDrafts.getState().drafts[other]?.annotations,
    ).toEqual([]);
    annotationDrafts = createAnnotationDraftStore(webviewStorage).service;
    annotationDrafts.getState().ensure(scope);
    expect(
      annotationDrafts.getState().drafts[scope]?.annotations,
    ).toEqual([annotation]);
  });
  it("新会话转正迁移草稿和待确认消息，迟到的结果不清除其他会话批注", () => {
    const store = annotationDrafts.getState(),
      fresh = draftScopeKey("D:/project", null);
    store.put(fresh, [annotation]);
    const prompt = encodeAnnotationMessage("修改", [annotation]);
    store.submit(fresh, prompt);
    store.put(fresh, [{ ...annotation, id: "later", comment: "后来补充" }]);
    store.put(other, [annotation]);
    store.migrate(fresh, scope);
    store.settle(prompt, false);
    expect(
      annotationDrafts
        .getState()
        .drafts[scope]?.annotations.map((a) => a.id),
    ).toEqual(["later"]);
    expect(
      annotationDrafts.getState().drafts[other]?.annotations,
    ).toEqual([annotation]);
    expect(
      annotationDrafts.getState().drafts[fresh]?.annotations,
    ).toEqual([]);
  });
  it("提交中重启只标记状态未确认，手动取回，不自动发送", () => {
    const store = annotationDrafts.getState();
    store.put(scope, [annotation]);
    const prompt = encodeAnnotationMessage("修改", [annotation]);
    store.submit(scope, prompt);
    annotationDrafts = createAnnotationDraftStore(webviewStorage).service;
    annotationDrafts.getState().ensure(scope);
    const parsed = decodeAnnotationMessage(prompt)!;
    expect(
      annotationDrafts.getState().drafts[scope]?.submissions[parsed.id]
        ?.state,
    ).toBe("uncertain");
    expect(annotationDrafts.getState().recover(scope, parsed.id)).toBe("修改");
    expect(
      annotationDrafts.getState().drafts[scope]?.annotations,
    ).toEqual([annotation]);
  });
  it("存储失败时不清除原批注，也不报告保存成功", () => {
    const store = annotationDrafts.getState();
    store.put(scope, [annotation]);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(
      store.submit(scope, encodeAnnotationMessage("修改", [annotation])),
    ).toBe(false);
    expect(
      annotationDrafts.getState().drafts[scope]?.annotations,
    ).toEqual([annotation]);
    expect(annotationDrafts.getState().error).toContain("保存失败");
  });
  it("失败发送保留可恢复记录，重试成功后清理备份", async () => {
    const session = createSessionStore(undefined, annotationDrafts);
    const store = annotationDrafts.getState();
    store.put(scope, [annotation]);
    const prompt = encodeAnnotationMessage("修改", [annotation]);
    store.submit(scope, prompt);
    session
      .getState()
      .bindSession({
        prompt: () => Promise.reject(new Error("连接中断")),
        cancel: () => {},
      });
    expect(session.getState().sendPrompt(prompt)).toBe(true);
    await vi.waitFor(() =>
      expect(
        Object.values(
          annotationDrafts.getState().drafts[scope]!.submissions,
        )[0]?.state,
      ).toBe("uncertain"),
    );
    session
      .getState()
      .bindSession({
        prompt: () => Promise.resolve({ stopReason: "end_turn" as const }),
        cancel: () => {},
      });
    session.getState().sendPrompt(prompt);
    await vi.waitFor(() =>
      expect(
        annotationDrafts.getState().drafts[scope]?.submissions,
      ).toEqual({}),
    );
    session.getState().clear();
  });
});

describe("文档锚点", () => {
  it("修改后唯一原文可重定位；多处重复且无唯一上下文时不误跳", () => {
    expect(
      locateAnnotation("新增 之前 目标文本 之后", annotation, "changed"),
    ).toBe(6);
    expect(
      locateAnnotation(
        "目标文本 目标文本",
        { ...annotation, prefix: "", suffix: "" },
        "changed",
      ),
    ).toBeNull();
    expect(locateAnnotation("原文被删除", annotation, "changed")).toBeNull();
  });
  it("跨 Markdown 行内样式选区映射到同一文本，忽略工具按钮", () => {
    const root = document.createElement("div");
    root.innerHTML =
      "<p>之前 <strong>目标</strong>文本 之后</p><button>复制</button>";
    const index = documentTextIndex(root);
    expect(index.text).toBe("之前 目标文本 之后");
    const range = index.range(3, 7)!;
    expect(range.toString()).toBe("目标文本");
    expect(index.selection(range)).toEqual({ start: 3, end: 7 });
  });
  it("代码索引不包含行号，按逻辑行拼接", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<div aria-label="文件源码"><div data-file-line="1"><span>1</span><code>const <span>x</span> = 1;</code></div><div data-file-line="2"><span>2</span><code>next();</code></div></div>';
    expect(documentTextIndex(root).text).toBe("const x = 1;\nnext();");
  });
});
