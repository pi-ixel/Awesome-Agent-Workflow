import type { PendingPermission, PendingQuestions } from "../../src/plugins/project/types.ts";
/**
 * 项目审批与问答 store 测试。
 * - 挂起项的 wire→领域定型（_meta.chrys 工具名、rawInput 摘要、待办标题）；
 * - 决策 / 作答 / 取消的 Promise 回传形状（对齐 chrys 侧校验）；
 * - 多挂起焦点切换与自动转移；
 * - 全部交互写日志通道；
 * - 纯函数 buildAnswers / summarizeRawInput 的边界。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { buildAnswers, summarizeRawInput, createApprovalStore } from "../../src/plugins/project/interactions/approvalStore.ts";
import { LogSink } from "../../src/plugins/diagnostics/capture/logSink.ts";
import type { RequestPermissionOutcome } from "../../src/contracts/acp/protocol.ts";

/** 捕获 Promise 结果的辅助（resolve 同步发生，一个微任务即可冲刷）。 */
function capture<T>(promise: Promise<T>): { value: T | undefined } {
  const box = { value: undefined as T | undefined };
  void promise.then((result) => {
    box.value = result;
  });
  return box;
}

const CHRYS_OPTIONS = [
  { optionId: "allow", name: "Allow once", kind: "allow_once" as const },
  { optionId: "reject", name: "Reject once", kind: "reject_once" as const },
];

const DEMO_TOOL_CALL = {
  toolCallId: "call-1",
  title: "执行 aaw run --stage review",
  kind: "execute",
  status: "pending",
  rawInput: { command: "aaw run --stage review", cwd: "D:/dev/demo" },
  _meta: { chrys: { tool_name: "bash", tool_kind: "execute" } },
};

const DEMO_QUESTIONS = [
  {
    question: "评审结论采用哪种严格度？",
    header: "评审严格度",
    multiSelect: false,
    options: [
      { label: "标准", description: "列出全部级别" },
      { label: "宽松", description: "仅阻塞级" },
    ],
  },
  {
    question: "报告需要哪些附录？",
    header: "报告附录",
    multiSelect: true,
    options: [
      { label: "完整 diff", description: "" },
      { label: "测试输出", description: "" },
    ],
  },
];

const logs = new LogSink(undefined, "debug");
const useApprovalStore = createApprovalStore(logs.createLogger("approval"));

beforeEach(() => {
  useApprovalStore.getState().clear();
  logs.clear();
});

describe("useApprovalStore 审批流", () => {
  it("offerPermission 挂起并完成领域定型", () => {
    const box = capture(
      useApprovalStore.getState().offerPermission({
        sessionId: "s1",
        toolCall: DEMO_TOOL_CALL,
        options: CHRYS_OPTIONS,
      }),
    );
    const state = useApprovalStore.getState();
    expect(state.pending).toHaveLength(1);
    const item = state.pending[0];
    expect(item?.kind).toBe("permission");
    if (item?.kind !== "permission") {
      return;
    }
    const permission: PendingPermission = item;
    expect(permission.toolCallId).toBe("call-1");
    expect(permission.id).toBe("permission:call-1");
    expect(permission.toolName).toBeNull(); // 私有字段必须经 adapter 翻译
    expect(permission.toolKind).toBe("execute"); // 标准 kind
    expect(permission.title).toBe("执行 aaw run --stage review");
    expect(permission.inboxTitle).toBe("执行 aaw run --stage review");
    // rawInput 摘要：优先字段 command 在前，至多两个字段
    expect(permission.inputSummary).toBe(
      "command=aaw run --stage review · cwd=D:/dev/demo",
    );
    expect(permission.reason).toBeNull();
    // 无焦点时自动聚焦新挂起项
    expect(state.activeId).toBe("permission:call-1");
    // 未决策前 Promise 保持未决
    expect(box.value).toBeUndefined();
    // 挂起即写 approval 日志通道
    expect(
      logs
        .snapshot()
        .some(
          (entry) =>
            entry.channel === "approval" &&
            entry.message.includes("审批请求已挂起"),
        ),
    ).toBe(true);
  });

  it("decidePermission 回传 selected 并移除挂起项", async () => {
    const box = capture(
      useApprovalStore.getState().offerPermission({
        sessionId: "s1",
        toolCall: DEMO_TOOL_CALL,
        options: CHRYS_OPTIONS,
      }),
    );
    useApprovalStore.getState().decidePermission("permission:call-1", "allow");
    await Promise.resolve();
    const outcome: RequestPermissionOutcome | undefined = box.value;
    expect(outcome).toEqual({ outcome: "selected", optionId: "allow" });
    expect(useApprovalStore.getState().pending).toHaveLength(0);
    expect(useApprovalStore.getState().activeId).toBeNull();
    expect(
      logs
        .snapshot()
        .some((entry) => entry.message === "审批已决策：允许"),
    ).toBe(true);
  });

  it("cancelPermission 回传 cancelled", async () => {
    const box = capture(
      useApprovalStore.getState().offerPermission({
        sessionId: "s1",
        toolCall: DEMO_TOOL_CALL,
        options: CHRYS_OPTIONS,
      }),
    );
    useApprovalStore.getState().cancelPermission("permission:call-1");
    await Promise.resolve();
    expect(box.value).toEqual({ outcome: "cancelled" });
  });

  it("重复 toolCallId 的请求按取消回传且不新增挂起", async () => {
    const first = capture(
      useApprovalStore.getState().offerPermission({
        sessionId: "s1",
        toolCall: DEMO_TOOL_CALL,
        options: CHRYS_OPTIONS,
      }),
    );
    const second = capture(
      useApprovalStore.getState().offerPermission({
        sessionId: "s1",
        toolCall: DEMO_TOOL_CALL,
        options: CHRYS_OPTIONS,
      }),
    );
    await Promise.resolve();
    expect(second.value).toEqual({ outcome: "cancelled" });
    // 第一条不受影响
    expect(first.value).toBeUndefined();
    expect(useApprovalStore.getState().pending).toHaveLength(1);
  });

  it("clear 把未决审批按取消回传", async () => {
    const box = capture(
      useApprovalStore.getState().offerPermission({
        sessionId: "s1",
        toolCall: DEMO_TOOL_CALL,
        options: CHRYS_OPTIONS,
      }),
    );
    useApprovalStore.getState().clear();
    await Promise.resolve();
    expect(box.value).toEqual({ outcome: "cancelled" });
    expect(useApprovalStore.getState().pending).toHaveLength(0);
  });
});

describe("useApprovalStore 问答流", () => {
  it("offerQuestions 挂起，submitAnswers 按位组装 answers 回传", async () => {
    const box = capture(
      useApprovalStore.getState().offerQuestions({
        sessionId: "s1",
        requestId: "req-1",
        questions: DEMO_QUESTIONS,
        callerName: "skill-eval",
      }),
    );
    const state = useApprovalStore.getState();
    const item = state.pending[0];
    expect(item?.kind).toBe("questions");
    if (item?.kind === "questions") {
      const questions: PendingQuestions = item;
      expect(questions.inboxTitle).toBe("评审严格度");
      expect(questions.callerName).toBe("skill-eval");
    }

    useApprovalStore
      .getState()
      .submitAnswers("questions:req-1", [["标准"], ["完整 diff", "测试输出"]]);
    await Promise.resolve();
    expect(box.value).toEqual({
      answers: [{ values: ["标准"] }, { values: ["完整 diff", "测试输出"] }],
    });
    expect(useApprovalStore.getState().pending).toHaveLength(0);
    expect(
      logs
        .snapshot()
        .some((entry) => entry.message.includes("提问已作答")),
    ).toBe(true);
  });

  it("作答数量不符按 cancelled 回传并告警", async () => {
    const box = capture(
      useApprovalStore.getState().offerQuestions({
        sessionId: "s1",
        requestId: "req-1",
        questions: DEMO_QUESTIONS,
        callerName: null,
      }),
    );
    useApprovalStore.getState().submitAnswers("questions:req-1", [["标准"]]);
    await Promise.resolve();
    expect(box.value).toEqual({ cancelled: true });
    expect(
      logs
        .snapshot()
        .some(
          (entry) =>
            entry.level === "warn" && entry.message.includes("作答未通过校验"),
        ),
    ).toBe(true);
  });

  it("cancelQuestions 回传 cancelled", async () => {
    const box = capture(
      useApprovalStore.getState().offerQuestions({
        sessionId: "s1",
        requestId: "req-1",
        questions: DEMO_QUESTIONS,
        callerName: null,
      }),
    );
    useApprovalStore.getState().cancelQuestions("questions:req-1");
    await Promise.resolve();
    expect(box.value).toEqual({ cancelled: true });
  });
});

describe("useApprovalStore 焦点管理", () => {
  it("多挂起可切换焦点，决策后焦点自动落到剩余项", () => {
    const store = useApprovalStore.getState();
    void store.offerPermission({
      sessionId: "s1",
      toolCall: DEMO_TOOL_CALL,
      options: CHRYS_OPTIONS,
    });
    void store.offerQuestions({
      sessionId: "s1",
      requestId: "req-1",
      questions: DEMO_QUESTIONS,
      callerName: null,
    });

    const state = useApprovalStore.getState();
    expect(state.pending).toHaveLength(2);
    // 首条自动聚焦；第二条到达不抢焦点
    expect(state.activeId).toBe("permission:call-1");

    useApprovalStore.getState().select("questions:req-1");
    expect(useApprovalStore.getState().activeId).toBe("questions:req-1");

    // 决策当前焦点项后，焦点自动落到最旧的剩余项
    useApprovalStore.getState().decidePermission("permission:call-1", "reject");
    expect(useApprovalStore.getState().activeId).toBe("questions:req-1");
    expect(useApprovalStore.getState().pending).toHaveLength(1);

    // 未知 id 的 select 是安全 no-op
    useApprovalStore.getState().select("permission:不存在");
    expect(useApprovalStore.getState().activeId).toBe("questions:req-1");
  });
});

describe("useApprovalStore 挂起通路", () => {
  it("审批与提问可同时挂起：按到达顺序排队且互不干扰", async () => {
    void useApprovalStore.getState().offerPermission({
      sessionId: "s1",
      toolCall: DEMO_TOOL_CALL,
      options: CHRYS_OPTIONS,
    });
    const question = capture(
      useApprovalStore.getState().offerQuestions({
        sessionId: "s1",
        requestId: "req-9",
        questions: DEMO_QUESTIONS,
        callerName: "skill-eval",
      }),
    );

    const state = useApprovalStore.getState();
    expect(state.pending).toHaveLength(2);
    expect(state.pending[0]?.kind).toBe("permission");
    expect(state.pending[1]?.kind).toBe("questions");
    // 首条自动聚焦，第二条到达不抢焦点
    expect(state.activeId).toBe("permission:call-1");

    // 逐条收口：审批决策 + 提问取消，均按 wire 形状回传
    useApprovalStore.getState().decidePermission("permission:call-1", "allow");
    useApprovalStore.getState().cancelQuestions("questions:req-9");
    await Promise.resolve();
    expect(question.value).toEqual({ cancelled: true });
    expect(useApprovalStore.getState().pending).toHaveLength(0);

    // 挂起与收口全程写 approval 日志通道
    const entries = logs.snapshot();
    expect(
      entries.some(
        (entry) =>
          entry.channel === "approval" &&
          entry.message.includes("审批请求已挂起"),
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.channel === "approval" &&
          entry.message.includes("结构化提问已挂起"),
      ),
    ).toBe(true);
  });
});

describe("buildAnswers（对齐 chrys validate_ask_user_answers）", () => {
  const singleQuestion = DEMO_QUESTIONS[0];
  const multiQuestion = DEMO_QUESTIONS[1];
  if (singleQuestion === undefined || multiQuestion === undefined) {
    throw new Error("测试夹具不完整");
  }

  it("正常组装：trim、去重、单选单值、多选多值", () => {
    expect(
      buildAnswers(
        [singleQuestion, multiQuestion],
        [[" 标准 "], ["完整 diff", "完整 diff", "测试输出"]],
      ),
    ).toEqual([{ values: ["标准"] }, { values: ["完整 diff", "测试输出"] }]);
  });

  it("数量不符 / 空选 / 单选多值返回 null", () => {
    expect(buildAnswers([singleQuestion], [])).toBeNull();
    expect(buildAnswers([singleQuestion], [["", "  "]])).toBeNull();
    expect(buildAnswers([singleQuestion], [["标准", "宽松"]])).toBeNull();
  });
});

describe("summarizeRawInput（对齐 Python tool_input_summary）", () => {
  it("对象输入：优先字段在前，至多两项，值截断 120 字符", () => {
    expect(
      summarizeRawInput(
        { cwd: "D:/x", command: "aaw run", extra: 1 },
        "执行 aaw run",
      ),
    ).toBe("command=aaw run · cwd=D:/x");
  });

  it("跳过与标题重复的值；嵌套值 JSON 化", () => {
    expect(
      summarizeRawInput({ command: "aaw run", args: ["--x", 1] }, "aaw run"),
    ).toBe('args=["--x",1]');
  });

  it("字符串输入折叠空白并截断；非对象非字符串返回空", () => {
    expect(summarizeRawInput("aaw   run\n--stage  review", "标题")).toBe(
      "aaw run --stage review",
    );
    expect(summarizeRawInput("与标题相同", "与标题相同")).toBe("");
    expect(summarizeRawInput(42, "标题")).toBe("");
    expect(summarizeRawInput(null, "标题")).toBe("");
    expect(summarizeRawInput(undefined, "标题")).toBe("");
  });

  it("超长值截断到 120 字符", () => {
    const long = "x".repeat(200);
    expect(summarizeRawInput({ command: long }, "")).toBe(
      `command=${long.slice(0, 120)}`,
    );
  });
});
