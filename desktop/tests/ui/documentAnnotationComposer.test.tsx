import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatInput } from "../../src/ui/session/ChatInput.tsx";
import { AnnotationCards } from "../../src/ui/session/AnnotationCards.tsx";
import { UserMessage } from "../../src/ui/session/UserMessage.tsx";
import { useAnnotationDraftStore } from "../../src/stores/annotationDraftStore.ts";
import { useSessionStore } from "../../src/stores/sessionStore.ts";
import { useWorkspaceStore } from "../../src/stores/workspaceStore.ts";
import { draftScopeKey, readDraft } from "../../src/ui/session/draftStore.ts";
import {
  decodeAnnotationMessage,
  encodeAnnotationMessage,
  type DocumentAnnotation,
} from "../../src/core/documentAnnotations.ts";
const project = "D:/project";
const scope = draftScopeKey(project, "A");
const annotation: DocumentAnnotation = {
  id: "a1",
  project,
  path: project + "/design.md",
  source: false,
  quote: "需要修改的原文",
  prefix: "",
  suffix: "",
  offset: 0,
  revision: "rev",
  comment: "请简化",
};
beforeEach(() => {
  localStorage.clear();
  useAnnotationDraftStore.setState({ drafts: {}, migrations: {}, error: null });
  useWorkspaceStore.setState({ activePath: project });
  useSessionStore.getState().clear();
  useSessionStore.setState({ activeSessionId: "A" });
});
function setup(onSend: (text: string) => boolean | void = vi.fn(() => true)) {
  return render(
    <ChatInput
      isAgentRunning={false}
      onSend={onSend}
      onEnqueue={() => true}
      onCancel={() => {}}
    />,
  );
}
describe("批注与输入框", () => {
  it("只有批注也可发送，卡片移入可恢复提交记录", async () => {
    useAnnotationDraftStore.getState().put(scope, [annotation]);
    const send = vi.fn<(text: string) => boolean>(() => true);
    setup(send);
    await userEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(
      decodeAnnotationMessage(send.mock.calls[0]![0] ?? "")?.annotations,
    ).toEqual([annotation]);
    expect(
      useAnnotationDraftStore.getState().drafts[scope]?.annotations,
    ).toEqual([]);
    expect(
      Object.values(
        useAnnotationDraftStore.getState().drafts[scope]!.submissions,
      ),
    ).toHaveLength(1);
    expect(
      screen.queryByText("批注消息已提交，等待结果"),
    ).not.toBeInTheDocument();
  });
  it("评论默认折叠，点击展开小窗，Escape 关闭且不影响输入", async () => {
    useAnnotationDraftStore.getState().put(scope, [annotation]);
    setup();
    expect(screen.queryByText(annotation.quote)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "1 条评论" }));
    expect(
      screen.getByRole("dialog", { name: "文档评论" }),
    ).toBeInTheDocument();
    expect(screen.getByText(annotation.quote)).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(
      screen.queryByRole("dialog", { name: "文档评论" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1 条评论" })).toHaveFocus();
  });
  it("悬停打开详情，移入详情不关闭，移出后关闭且无重复标题", async () => {
    useAnnotationDraftStore.getState().put(scope, [annotation]);
    setup();
    const entry = screen.getByRole("button", { name: "1 条评论" });
    await userEvent.hover(entry);
    const dialog = screen.getByRole("dialog", { name: "文档评论" });
    expect(dialog).not.toHaveTextContent("1 条评论");
    await userEvent.hover(dialog);
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(dialog).toBeInTheDocument();
    await userEvent.unhover(dialog);
    await vi.waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "文档评论" }),
      ).not.toBeInTheDocument(),
    );
  });
  it("入口 X 一次删除全部批注，保留正文", async () => {
    useAnnotationDraftStore
      .getState()
      .put(scope, [annotation, { ...annotation, id: "a2", comment: "第二条" }]);
    setup();
    await userEvent.type(screen.getByLabelText("消息输入框"), "正文要保留");
    await userEvent.hover(screen.getByRole("button", { name: "2 条评论" }));
    await userEvent.click(screen.getByRole("button", { name: "删除全部评论" }));
    expect(
      useAnnotationDraftStore.getState().drafts[scope]?.annotations,
    ).toEqual([]);
    expect(screen.getByLabelText("消息输入框")).toHaveValue("正文要保留");
    expect(
      screen.queryByRole("dialog", { name: "文档评论" }),
    ).not.toBeInTheDocument();
  });
  it("发送被拒绝不清除原文或批注", async () => {
    useAnnotationDraftStore.getState().put(scope, [annotation]);
    setup(() => false);
    await userEvent.type(screen.getByLabelText("消息输入框"), "用户要求");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(screen.getByLabelText("消息输入框")).toHaveValue("用户要求");
    expect(
      screen.getByRole("button", { name: "1 条评论" }),
    ).toBeInTheDocument();
    expect(
      useAnnotationDraftStore.getState().drafts[scope]?.annotations,
    ).toEqual([annotation]);
  });
  it("切到另一会话不显示之前的卡片，切回恢复", () => {
    useAnnotationDraftStore.getState().put(scope, [annotation]);
    setup();
    expect(
      screen.getByRole("button", { name: "1 条评论" }),
    ).toBeInTheDocument();
    act(() => useSessionStore.setState({ activeSessionId: "B" }));
    expect(
      screen.queryByRole("button", { name: "1 条评论" }),
    ).not.toBeInTheDocument();
    act(() => useSessionStore.setState({ activeSessionId: "A" }));
    expect(
      screen.getByRole("button", { name: "1 条评论" }),
    ).toBeInTheDocument();
  });
  it("转正迁移仅生效一次，之后的新草稿切到旧会话不会被吞掉", () => {
    const fresh = draftScopeKey(project, null);
    useSessionStore.setState({ activeSessionId: null });
    setup();
    fireEvent.change(screen.getByLabelText("消息输入框"), {
      target: { value: "首个新草稿" },
    });
    act(() => {
      useAnnotationDraftStore.getState().migrate(fresh, scope);
      useSessionStore.setState({ activeSessionId: "A" });
    });
    expect(screen.getByLabelText("消息输入框")).toHaveValue("首个新草稿");
    act(() => useSessionStore.setState({ activeSessionId: null }));
    fireEvent.change(screen.getByLabelText("消息输入框"), {
      target: { value: "另一个新草稿" },
    });
    act(() => useSessionStore.setState({ activeSessionId: "A" }));
    expect(screen.getByLabelText("消息输入框")).toHaveValue("首个新草稿");
    expect(readDraft(fresh)).toBe("另一个新草稿");
  });
  it("卡片编辑保存失败时保留编辑态和新意见", async () => {
    render(
      <AnnotationCards annotations={[annotation]} onChange={() => false} />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "编辑批注 design.md" }),
    );
    fireEvent.change(screen.getByLabelText("修改批注意见"), {
      target: { value: "不能丢失的新意见" },
    });
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByLabelText("修改批注意见")).toHaveValue(
      "不能丢失的新意见",
    );
  });
  it("历史消息显示评论胶囊与只读详情，填回输入框恢复结构化引用", async () => {
    const prompt = encodeAnnotationMessage("修改建议", [annotation]);
    render(
      <>
        <UserMessage
          item={{
            id: "u1",
            kind: "user",
            createdAt: "2026-11-03T00:00:00Z",
            text: prompt,
          }}
        />
        <ChatInput
          isAgentRunning={false}
          onSend={() => true}
          onEnqueue={() => true}
          onCancel={() => {}}
        />
      </>,
    );
    expect(screen.getByText("修改建议")).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "文档评论" }),
    ).not.toBeInTheDocument();
    await userEvent.hover(screen.getByRole("button", { name: "1 条评论" }));
    expect(
      screen.getByRole("dialog", { name: "文档评论" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /删除批注/ }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "填回输入框" }));
    expect(screen.getByLabelText("消息输入框")).toHaveValue("修改建议");
    expect(
      useAnnotationDraftStore.getState().drafts[scope]?.annotations,
    ).toEqual([annotation]);
  });
});

it("仅评论的历史消息不渲染空文字气泡", () => {
  const { container } = render(
    <UserMessage
      item={{
        id: "only",
        createdAt: "2026-11-03T00:00:00Z",
        kind: "user",
        text: encodeAnnotationMessage("", [annotation]),
      }}
    />,
  );
  expect(screen.getByRole("button", { name: "1 条评论" })).toBeInTheDocument();
  expect(container.querySelector('[data-item-kind="user"] p')).toBeNull();
});
