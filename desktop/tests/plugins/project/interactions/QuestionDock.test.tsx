import type { PendingQuestions } from "../../../../src/plugins/project/types.ts";
import { useWorkbenchUiStore } from "../../../helpers/layout.ts";
import { useApprovalStore } from "../../../helpers/foreground.ts";
import type { ChrysRequestInputResult } from "../../../../src/plugins/agents/enhancements/icode/types.ts";
/**
 * src/ui/session/QuestionDock 测试：停靠面板渲染（header/题干/选项/
 * 调用方/已答进度）、单选/多选交互、note 备注随答案回传、提交门禁与取消，
 * 全部经真实 approvalStore 生效；面板自取焦点项（不再由外部传 item）。
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QuestionDock } from "../../../../src/plugins/project/interactions/ui/QuestionDock";

const QUESTIONS = [
  {
    question: "评审结论采用哪种严格度？",
    header: "评审严格度",
    multiSelect: false,
    options: [
      { label: "标准", description: "阻塞级与建议级问题都列出" },
      { label: "宽松", description: "仅列出阻塞级问题" },
    ],
  },
  {
    question: "报告需要包含哪些附录？",
    header: "报告附录",
    multiSelect: true,
    options: [
      { label: "完整 diff", description: "附上全部改动差异" },
      { label: "测试输出", description: "附上测试运行日志摘要" },
      { label: "耗时统计", description: "附上各阶段执行耗时" },
    ],
  },
];

/** 挂起一批提问并取出定型后的项，可选用 box 捕获回传结果。 */
function seedQuestions(questions = QUESTIONS): {
  item: PendingQuestions;
  result: { value: ChrysRequestInputResult | null | undefined };
} {
  const box = {
    value: undefined as ChrysRequestInputResult | null | undefined,
  };
  void useApprovalStore
    .getState()
    .offerQuestions({
      sessionId: "s1",
      requestId: "req-1",
      questions,
      callerName: "skill-eval",
    })
    .then((value) => {
      box.value = value;
    });
  const item = useApprovalStore.getState().pending[0];
  if (item === undefined || item.kind !== "questions") {
    throw new Error("应挂起提问项");
  }
  return { item, result: box };
}

beforeEach(() => {
  useWorkbenchUiStore.setState({ overlay: null });
  useApprovalStore.getState().clear();
});

describe("QuestionDock", () => {
  it("无挂起提问时不渲染", () => {
    const { container } = render(<QuestionDock />);
    expect(container.firstElementChild).toBeNull();
  });

  it("渲染 header、题干、选项、调用方与已答进度", () => {
    seedQuestions();
    render(<QuestionDock />);
    expect(screen.queryByText("报告附录")).toBeNull();
    expect(screen.getByText("评审结论采用哪种严格度？")).toBeInTheDocument();
    expect(screen.getByText("阻塞级与建议级问题都列出")).toBeInTheDocument();
    expect(screen.queryByText(/skill-eval/)).toBeNull();
    expect(screen.getByText(/第 1／2 题/)).toBeInTheDocument();
    // 单选题是 radio 语义，多选题是 checkbox 语义；每问一个 note 输入
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });

  it("未全部作答时提交禁用；进度随作答更新；作答后按位回传", async () => {
    const user = userEvent.setup();
    const { result } = seedQuestions();
    render(<QuestionDock />);

    const submit = screen.getByRole("button", { name: "发送" });
    expect(submit).toBeDisabled();

    // 只答第一问：进度 1/2，仍禁用
    await user.click(screen.getByRole("radio", { name: /标准/ }));
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(result.value).toBeUndefined();
    expect(screen.getByText(/第 2／2 题/)).toBeInTheDocument();
    expect(submit).toBeDisabled();

    // 补答第二问（多选两项）→ 可提交
    await user.click(screen.getByRole("checkbox", { name: /完整 diff/ }));
    await user.click(screen.getByRole("checkbox", { name: /耗时统计/ }));
    expect(submit).toBeEnabled();

    await user.click(submit);
    await Promise.resolve();
    expect(result.value).toEqual({
      answers: [{ values: ["标准"] }, { values: ["完整 diff", "耗时统计"] }],
    });
    expect(useApprovalStore.getState().pending).toHaveLength(0);
  });

  it.each(["点击发送", "按 Enter"])("只输入自定义回答也能%s", async (method) => {
    const user = userEvent.setup();
    const { result } = seedQuestions(QUESTIONS.slice(0, 1));
    render(<QuestionDock />);

    const send = screen.getByRole("button", { name: "发送" });
    expect(send).toBeDisabled();
    const input = screen.getByRole("textbox");
    await user.type(input, "  ");
    expect(send).toBeDisabled();
    await user.type(input, "大萨达  ");
    expect(send).toBeEnabled();
    expect(screen.getAllByRole("radio", { checked: false })).toHaveLength(2);

    if (method === "按 Enter") await user.keyboard("{Enter}");
    else await user.click(send);
    expect(result.value).toEqual({ answers: [{ values: ["大萨达"] }] });
  });

  it("note 备注随对应问题的答案回传（空备注不带 note 键）", async () => {
    const user = userEvent.setup();
    const { result } = seedQuestions();
    render(<QuestionDock />);
    await user.click(screen.getByRole("radio", { name: /标准/ }));
    await user.click(screen.getByRole("button", { name: "发送" }));
    await user.click(screen.getByRole("checkbox", { name: /完整 diff/ }));
    await user.type(
      screen.getByLabelText("问题 2 自定义回答或补充说明"),
      "diff 只要 src 部分",
    );
    await user.click(screen.getByRole("button", { name: "发送" }));
    await Promise.resolve();
    expect(result.value).toEqual({
      answers: [
        { values: ["标准"] },
        { values: ["完整 diff"], note: "diff 只要 src 部分" },
      ],
    });
  });

  it("单选可改选；再点同项取消选择", async () => {
    const user = userEvent.setup();
    seedQuestions();
    render(<QuestionDock />);

    const standard = screen.getByRole("radio", { name: /标准/ });
    const loose = screen.getByRole("radio", { name: /宽松/ });
    await user.click(standard);
    expect(standard).toHaveAttribute("aria-checked", "true");
    await user.click(loose);
    expect(loose).toHaveAttribute("aria-checked", "true");
    expect(standard).toHaveAttribute("aria-checked", "false");
    // 取消选择后提交回到禁用
    await user.click(loose);
    expect(loose).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  it("取消整批按 cancelled 回传", async () => {
    const user = userEvent.setup();
    const { result } = seedQuestions();
    render(<QuestionDock />);
    await user.click(screen.getByRole("button", { name: "关闭整组提问" }));
    await Promise.resolve();
    expect(result.value).toEqual({ cancelled: true });
    expect(useApprovalStore.getState().pending).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- 自动应答倒计时（M5）
import { act, fireEvent } from "@testing-library/react";
import { createTestProjectPreferences, projectPreferencesWrapper } from "../../../helpers/projectPreferences.tsx";

const projectPreferences = createTestProjectPreferences();
const PreferencesWrapper = projectPreferencesWrapper(projectPreferences);

describe("QuestionDock 自动应答倒计时", () => {
  beforeEach(() => {
    projectPreferences.setAutoAnswerQuestions(false);
  });

  it("默认关闭：无倒计时提示；开启后显示剩余秒数与将选的首项", () => {
    seedQuestions();
    render(<QuestionDock />, { wrapper: PreferencesWrapper });
    expect(document.querySelector("[data-auto-answer-countdown]")).toBeNull();

    act(() => {
      projectPreferences.setAutoAnswerQuestions(true);
    });
    expect(
      document.querySelector("[data-auto-answer-countdown]"),
    ).toHaveTextContent(/60s 后自动应答/);
  });

  it("到点自动提交每题首个选项", async () => {
    vi.useFakeTimers();
    try {
      projectPreferences.setAutoAnswerQuestions(true);
      const { result } = seedQuestions();
      render(<QuestionDock />, { wrapper: PreferencesWrapper });
      await act(() => Promise.resolve(vi.advanceTimersByTime(60_000)));
      expect(result.value).toEqual({
        answers: [{ values: ["标准"] }, { values: ["完整 diff"] }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("面板内交互即取消本次倒计时（不自动提交）", () => {
    vi.useFakeTimers();
    try {
      projectPreferences.setAutoAnswerQuestions(true);
      const { result } = seedQuestions();
      render(<QuestionDock />, { wrapper: PreferencesWrapper });
      const option = screen.getByText("标准").closest("button");
      if (option === null) throw new Error("选项按钮不存在");
      fireEvent.pointerDown(option);
      act(() => {
        vi.advanceTimersByTime(120_000);
      });
      expect(result.value).toBeUndefined();
      expect(document.querySelector("[data-auto-answer-countdown]")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

vi.mock("../../../../src/plugins/project/conversation/ui/useSessionCommands.ts", () => ({
  useSessionCommands: () => useApprovalStore((state) => state),
}));

vi.mock("../../../../src/plugins/project/ui/bindings/conversationView.ts", async () => {
  const { conversationViewFixture } = await import("../../../helpers/foreground.ts");
  return conversationViewFixture();
});

vi.mock(import("../../../../src/plugins/project/ui/bindings/projectView.tsx"), async (original) => {
  const { projectPageFixture } = await import("../../../helpers/layout.ts");
  return { ...(await original()), ...projectPageFixture() };
});
