import type { PendingPermission } from "../../src/plugins/project/types.ts";
import { useApprovalStore } from "../helpers/foreground.ts";
import { chrysAgentAdapter } from "../../src/plugins/agents/enhancements/icode/adapter.ts";
/**
 * src/ui/ApprovalModal 测试：渲染关键信息、按 kind 渲染选项、
 * 决策/取消（含 Esc）经真实 store 生效。
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalModal } from "../../src/plugins/project/interactions/ui/ApprovalModal";

const TOOL_CALL = {
  toolCallId: "call-1",
  title: "执行 aaw run --stage review",
  kind: "execute",
  status: "pending",
  rawInput: { command: "aaw run --stage review", cwd: "D:/dev/demo" },
  _meta: { chrys: { tool_name: "bash", tool_kind: "execute" } },
};

/** chrys 当前实际下发的两项权限选项（server.py _request_permission）。 */
const CHRYS_OPTIONS = [
  { optionId: "allow", name: "Allow once", kind: "allow_once" as const },
  { optionId: "reject", name: "Reject once", kind: "reject_once" as const },
];

/** 经 offerPermission 真实通路挂起一条审批并取出定型后的项。 */
function seedPermission(
  options: ReadonlyArray<{
    optionId: string;
    name: string;
    kind:
      | "allow_once"
      | "allow_always"
      | "reject_once"
      | "reject_always"
      | "unknown";
  }> = CHRYS_OPTIONS,
): PendingPermission {
  void useApprovalStore.getState().offerPermission({
    sessionId: "s1",
    toolCall: chrysAgentAdapter.normalizePermission!(TOOL_CALL),
    options,
  });
  const item = useApprovalStore.getState().pending[0];
  if (item === undefined || item.kind !== "permission") {
    throw new Error("应挂起审批项");
  }
  return item;
}

beforeEach(() => {
  useApprovalStore.getState().clear();
});

describe("ApprovalModal", () => {
  it("模态展示工具名、标题、命令预览（execute 类）与对话框语义", () => {
    const item = seedPermission();
    render(<ApprovalModal item={item} />);
    expect(
      screen.getByRole("dialog", { name: "权限审批" }),
    ).toBeInTheDocument();
    expect(screen.getByText("bash")).toBeInTheDocument();
    expect(screen.getByText("执行 aaw run --stage review")).toBeInTheDocument();
    // execute 类：完整命令预览替代 key=value 摘要
    expect(screen.getByText("将执行的命令")).toBeInTheDocument();
    expect(screen.getByText("aaw run --stage review")).toBeInTheDocument();
    expect(
      screen.queryByText("command=aaw run --stage review · cwd=D:/dev/demo"),
    ).not.toBeInTheDocument();
  });

  it("按 kind 渲染「允许 / 拒绝」，点击允许后挂起项清空", async () => {
    const user = userEvent.setup();
    const item = seedPermission();
    render(<ApprovalModal item={item} />);

    const allow = screen.getByRole("button", { name: "允许" });
    const reject = screen.getByRole("button", { name: "拒绝" });
    expect(allow).toBeInTheDocument();
    expect(reject).toBeInTheDocument();

    await user.click(allow);
    expect(useApprovalStore.getState().pending).toHaveLength(0);
  });

  it("点击拒绝同样清空挂起项", async () => {
    const user = userEvent.setup();
    const item = seedPermission();
    render(<ApprovalModal item={item} />);
    await user.click(screen.getByRole("button", { name: "拒绝" }));
    expect(useApprovalStore.getState().pending).toHaveLength(0);
  });

  it("Esc 触发取消回传", async () => {
    const user = userEvent.setup();
    let outcome: string | undefined;
    void useApprovalStore
      .getState()
      .offerPermission({
        sessionId: "s1",
        toolCall: chrysAgentAdapter.normalizePermission!(TOOL_CALL),
        options: [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
        ],
      })
      .then((value) => {
        outcome = value.outcome;
      });
    const item = useApprovalStore.getState().pending[0];
    if (item === undefined || item.kind !== "permission") {
      throw new Error("应挂起审批项");
    }
    render(<ApprovalModal item={item} />);
    await user.keyboard("{Escape}");
    await Promise.resolve();
    expect(outcome).toBe("cancelled");
    expect(useApprovalStore.getState().pending).toHaveLength(0);
  });

  it("协议预留 allow_always 出现时渲染「本会话总是允许」", () => {
    const item = seedPermission([
      { optionId: "allow", name: "Allow once", kind: "allow_once" },
      { optionId: "always", name: "Allow always", kind: "allow_always" },
      { optionId: "reject", name: "Reject once", kind: "reject_once" },
    ]);
    render(<ApprovalModal item={item} />);
    expect(
      screen.getByRole("button", { name: "本会话总是允许" }),
    ).toBeInTheDocument();
  });

  it("默认焦点落在拒绝一侧（打字途中弹出时 Enter 不等于批准）", () => {
    const item = seedPermission();
    render(<ApprovalModal item={item} />);
    expect(screen.getByRole("button", { name: "拒绝" })).toHaveFocus();
  });

  it("只有允许项时默认焦点落在排序末位而非首位", () => {
    const item = seedPermission([
      { optionId: "allow", name: "Allow once", kind: "allow_once" },
      { optionId: "always", name: "Allow always", kind: "allow_always" },
    ]);
    render(<ApprovalModal item={item} />);
    expect(
      screen.getByRole("button", { name: "本会话总是允许" }),
    ).toHaveFocus();
    expect(screen.getByRole("button", { name: "允许" })).not.toHaveFocus();
  });

  it("未知 kind 呈现原始 name 与中性文案，排序在最后", () => {
    // 协议演进/私有方言出现表外 kind（协议边界守卫回落 unknown）：
    // 绝不渲染成「允许」，agent 原始 name 可见
    const item = seedPermission([
      { optionId: "odd", name: "Mystery", kind: "unknown" },
      { optionId: "allow", name: "Allow once", kind: "allow_once" },
      { optionId: "reject", name: "Reject once", kind: "reject_once" },
    ]);
    render(<ApprovalModal item={item} />);
    const mystery = screen.getByRole("button", { name: "未知（Mystery）" });
    expect(mystery).toBeInTheDocument();
    // 顺序：允许 → 拒绝 → 未知（比较 DOM 位置）
    const buttons = screen.getAllByRole("button");
    const order = buttons.map((button) => button.textContent);
    expect(order.indexOf("允许")).toBeLessThan(order.indexOf("拒绝"));
    expect(order.indexOf("拒绝")).toBeLessThan(
      order.indexOf("未知（Mystery）"),
    );
  });

  it("展示重审原因与空输入占位", () => {
    void useApprovalStore.getState().offerPermission({
      sessionId: "s1",
      toolCall: {
        ...TOOL_CALL,
        toolCallId: "call-3",
        title: "再次执行命令",
        rawInput: undefined,
        rawOutput: "上一次执行超时",
      },
      options: CHRYS_OPTIONS,
    });
    const item = useApprovalStore.getState().pending[0];
    if (item === undefined || item.kind !== "permission") {
      throw new Error("应挂起审批项");
    }
    render(<ApprovalModal item={item} />);
    expect(screen.getByText("原因：上一次执行超时")).toBeInTheDocument();
    expect(screen.getByText("（无输入参数）")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- 工具预览（M5）
describe("ApprovalModal 工具预览", () => {
  function seedWith(toolCall: Record<string, unknown>): void {
    void useApprovalStore.getState().offerPermission({
      sessionId: "s1",
      toolCall: chrysAgentAdapter.normalizePermission!(toolCall),
      options: CHRYS_OPTIONS,
    });
  }

  it("edit_file 审批渲染 diff 预览（路径 + 增删行）", () => {
    seedWith({
      toolCallId: "call-edit",
      title: "edit_file src/app.ts",
      _meta: { chrys: { tool_name: "edit_file", tool_kind: "edit" } },
      rawInput: {
        path: "src/app.ts",
        old_string: "const a = 1;",
        new_string: "const a = 2;",
      },
    });
    const item = useApprovalStore.getState().pending[0];
    if (item === undefined || item.kind !== "permission") {
      throw new Error("应挂起审批项");
    }
    render(<ApprovalModal item={item} />);
    expect(screen.getByText("改动预览")).toBeInTheDocument();
    const diff = screen.getByLabelText("行级差异");
    expect(diff).toHaveTextContent("const a = 1;");
    expect(diff).toHaveTextContent("const a = 2;");
  });

  it("形状不认识的工具回落 key=value 摘要", () => {
    seedWith({
      toolCallId: "call-other",
      title: "web_fetch example.com",
      _meta: { chrys: { tool_name: "web_fetch", tool_kind: "fetch" } },
      rawInput: { url: "https://example.com" },
    });
    const item = useApprovalStore.getState().pending[0];
    if (item === undefined || item.kind !== "permission") {
      throw new Error("应挂起审批项");
    }
    render(<ApprovalModal item={item} />);
    expect(screen.getByText("工具输入")).toBeInTheDocument();
    expect(screen.getByText(/url=/)).toBeInTheDocument();
    expect(screen.queryByText("改动预览")).not.toBeInTheDocument();
  });
});

vi.mock("../../src/plugins/project/conversation/ui/useSessionCommands.ts", () => ({
  useSessionCommands: () => useApprovalStore((state) => state),
}));

vi.mock("../../src/plugins/project/ui/bindings/conversationView.ts", async () => {
  const { conversationViewFixture } = await import("../helpers/foreground.ts");
  return conversationViewFixture();
});
