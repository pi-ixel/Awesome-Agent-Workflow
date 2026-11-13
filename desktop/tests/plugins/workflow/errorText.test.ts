import { describe, expect, it } from "vitest";
import { describeError, errorLine, joinHint, serviceExitText } from "../../../src/plugins/workflow/status/errorText.ts";
import { describeStartError } from "../../../src/plugins/workflow/ui/WorkflowLauncher.tsx";
import { failureLabel } from "../../../src/plugins/workflow/status/snapshot.ts";

describe("报错说明", () => {
  it("常见错误码单独说明，带上补充信息与处理建议", () => {
    expect(describeError(new Error("WORKFLOW_INPUT_REQUIRED:本次需求"))).toMatchObject({ title: "还需要填写「本次需求」。", code: "WORKFLOW_INPUT_REQUIRED" });
    expect(describeError("ANOTHER_INSTANCE_BLOCKED")).toEqual({
      title: "同一层还有别的并行实例卡着，现在不能回退这一个。", hint: "请先处理那个实例。", code: "ANOTHER_INSTANCE_BLOCKED",
    });
    expect(describeError("OWNER_PROCESS_EXITED").title).toContain("应用进程已经退出");
  });

  it("其余错误码按类别说明，原始信息放进技术详情", () => {
    const text = describeError("ACP_HANDSHAKE_INVALID: unexpected version");
    expect(text.title).toBe("和 Agent 的连接出了问题。");
    expect(text.hint).toContain("检查 Agent 配置");
    expect(text).toMatchObject({ code: "ACP_HANDSHAKE_INVALID", detail: "ACP_HANDSHAKE_INVALID: unexpected version" });
    expect(describeError("WORKFLOW_AGENT_SOMETHING").title).toBe("节点使用的 Agent 不可用。");
  });

  it("消息里夹着的已知错误码也能认出", () => {
    expect(describeError("world-read#1#2: PYTHON_OUTCOME_UNKNOWN")).toMatchObject({ title: "脚本执行中断，不确定有没有执行完。", code: "PYTHON_OUTCOME_UNKNOWN" });
  });

  it("认不出的错误码不作为正文，已是中文的说明原样显示", () => {
    const unknown = describeError("ZZZ_TOTALLY_NEW");
    expect(unknown.title).toBe("出现了内部错误。");
    expect(unknown.code).toBe("ZZZ_TOTALLY_NEW");
    expect(describeError("plain english failure")).toMatchObject({ title: "出现了内部错误。", detail: "plain english failure" });
    expect(describeError(new Error("这次运行原来使用的 Agent 不可用。"))).toEqual({ title: "这次运行原来使用的 Agent 不可用。" });
    expect(describeError(undefined).title).toBe("操作失败。");
  });

  it("一行显示时中文句子直接相接", () => {
    expect(errorLine("ACP_COMMAND_REQUIRED")).toBe("没有可用的 Agent 启动命令。请先在设置里配置 Agent。");
    expect(joinHint({ title: "动作执行异常，请核验后处理", hint: "可以处置。" })).toBe("动作执行异常，请核验后处理。可以处置。");
    expect(describeStartError(new Error("WORKSPACE_NOT_BOUND"))).toBe("请先打开一个项目，工作流会在该项目目录里运行。");
    expect(failureLabel("NO_MATCHING_ROUTE")).toBe("没有满足条件的后续连线");
  });

  it("服务退出时给出诊断日志末尾", () => {
    expect(serviceExitText(3, ["[1] boom", 7, "[2] database locked"], "重试")).toEqual({
      title: "工作流服务意外退出（退出码 3）。", hint: "点「重试」重新启动服务。", detail: "[1] boom\n[2] database locked",
    });
    expect(serviceExitText(null, undefined, "重试")).not.toHaveProperty("detail");
  });
});

describe("本机存储满了", () => {
  it("会话归属写不进去时报出原因", async () => {
    const { writeSessionOwner } = await import("../../../src/plugins/workflow/sessionHost/sessionOwner.ts");
    const full = { getItem: () => null, setItem: () => { throw new DOMException("Setting the value exceeded the quota.", "QuotaExceededError"); } };
    expect(() => writeSessionOwner(full, "D:/p", "s-1", { agentId: "a", configuration: "0".repeat(64) })).toThrow("WORKFLOW_STORAGE_FULL");
    expect(describeError("WORKFLOW_STORAGE_FULL").title).toContain("本机存储空间满了");
  });
});
