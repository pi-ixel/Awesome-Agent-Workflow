/**
 * 入口启动向导组件测试：三入口选择、按入口收集变量、prompt 预览与
 * 提交回调；以及本次新增的交互约定——
 * - 无活跃会话：「交给会话发送」禁用并提示；
 * - 发送被拒（onSubmitPrompt 返回 false）：表单内容与步骤保留；
 * - 发送被拒（结构化 { ok:false, reason }）：reason 以 role=alert 展示；
 * - 连接 / 发送进行中：发送按钮禁用（防重复提交）；
 * - 已选入口进入第 2/3 步：入口卡片折叠为一行摘要（「更换」可回第 1 步）；
 * - 发送成功：整体折叠为「已发起 <SR> · 查看」摘要条。
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import EntryWizard, { type WizardMemory } from "../../../../src/plugins/workflow/ui/EntryWizard.tsx";
import type { WizardSubmitResult } from "../../../../src/plugins/workflow/ui/wizardSubmit.ts";

const user = userEvent.setup();

interface SetupOptions {
  readonly hasActiveSession?: boolean;
  readonly onSubmitPrompt?: (
    prompt: string,
  ) =>
    | boolean
    | void
    | WizardSubmitResult
    | Promise<boolean | void | WizardSubmitResult>;
  readonly onViewSession?: () => void;
}

function setup(options: SetupOptions = {}) {
  // 经 vi.fn 包装：断言可用 .mock，返回值仍兼容组件的回调约定
  const onSubmitPrompt = vi.fn(options.onSubmitPrompt ?? (() => undefined));
  const onViewSession = options.onViewSession ?? vi.fn();
  render(
    <EntryWizard
      onSubmitPrompt={onSubmitPrompt}
      hasActiveSession={options.hasActiveSession ?? true}
      onViewSession={onViewSession}
    />,
  );
  return { onSubmitPrompt, onViewSession };
}

/** 走 dev 入口到确认发送步（填写 SR 与一句话需求）。 */
async function walkToReview(): Promise<void> {
  await user.click(screen.getByLabelText(/dev 个人轻量/));
  await user.click(screen.getByRole("button", { name: "下一步：填写变量" }));
  await user.type(screen.getByLabelText("SR 编号"), "SR-009");
  await user.type(
    screen.getByLabelText("一句话需求"),
    "给设置页加深色模式开关",
  );
  await user.click(screen.getByRole("button", { name: "下一步：确认发送" }));
}

describe("EntryWizard", () => {
  it("斜杠入口优先于项目旧入口和步骤，且保留草稿字段", async () => {
    const drafts = new Map<string, WizardMemory>();
    const draftKey = "test-project-initial-entry-draft";
    const first = render(
      <EntryWizard
        drafts={drafts}
        draftKey={draftKey}
        initialEntry="sr"
        onSubmitPrompt={() => undefined}
      />,
    );
    await user.type(screen.getByLabelText("SR 编号"), "SR-009");
    await user.type(
      screen.getByLabelText("需求原文（保持原文，不总结不改写）"),
      "保留的原始需求",
    );
    first.unmount();

    render(
      <EntryWizard
        drafts={drafts}
        draftKey={draftKey}
        initialEntry="dev"
        onSubmitPrompt={() => undefined}
      />,
    );
    expect(screen.getByText("dev 个人轻量")).toBeInTheDocument();
    expect(screen.getByLabelText("一句话需求")).toBeInTheDocument();
    expect(screen.getByLabelText("SR 编号")).toHaveValue("SR-009");
    await user.click(screen.getByRole("button", { name: "更换" }));
    await user.click(screen.getByLabelText(/SR 严谨流程/));
    await user.click(screen.getByRole("button", { name: "下一步：填写变量" }));
    expect(
      screen.getByLabelText("需求原文（保持原文，不总结不改写）"),
    ).toHaveValue("保留的原始需求");
  });

  it("显式斜杠入口不被同项目已发起摘要遮住", async () => {
    const drafts = new Map<string, WizardMemory>();
    const draftKey = "test-project-initial-entry-sent";
    const first = render(
      <EntryWizard
        drafts={drafts}
        draftKey={draftKey}
        initialEntry="dev"
        onSubmitPrompt={() => true}
      />,
    );
    await user.type(screen.getByLabelText("SR 编号"), "SR-009");
    await user.type(screen.getByLabelText("一句话需求"), "完成一个小功能");
    await user.click(screen.getByRole("button", { name: "下一步：确认发送" }));
    await user.click(screen.getByRole("button", { name: "交给会话发送" }));
    expect(screen.getByText(/已发起/)).toBeInTheDocument();
    first.unmount();

    render(
      <EntryWizard
        drafts={drafts}
        draftKey={draftKey}
        initialEntry="ar"
        onSubmitPrompt={() => undefined}
      />,
    );
    expect(screen.queryByText(/已发起/)).not.toBeInTheDocument();
    expect(screen.getByText("AR 从 AR 切入")).toBeInTheDocument();
    expect(screen.getByLabelText("AR 编号")).toBeInTheDocument();
  });

  it("第一步渲染三入口与中文场景说明", () => {
    setup();
    expect(screen.getByText("SR 严谨流程")).toBeInTheDocument();
    expect(screen.getByText("AR 从 AR 切入")).toBeInTheDocument();
    expect(screen.getByText("dev 个人轻量")).toBeInTheDocument();
    expect(
      screen.getByText(/企业 \/ 严谨流程，需求需完整留痕/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/已有架构基线，从某个 AR 直接切入/),
    ).toBeInTheDocument();
    expect(screen.getByText(/个人开发者 \/ 轻量迭代/)).toBeInTheDocument();
  });

  it("未选择入口时不能进入下一步", () => {
    setup();
    const next = screen.getByRole("button", { name: "下一步：填写变量" });
    expect(next).toBeDisabled();
  });

  it("已选入口进入第 2/3 步：入口卡片折叠为摘要行，「更换」可点回第 1 步", async () => {
    setup();
    await user.click(screen.getByLabelText(/dev 个人轻量/));
    await user.click(screen.getByRole("button", { name: "下一步：填写变量" }));

    // 第 2 步：三张入口卡片收起，只剩一行紧凑摘要
    expect(screen.queryByText("SR 严谨流程")).not.toBeInTheDocument();
    expect(screen.getByText(/已选入口：/)).toBeInTheDocument();
    expect(screen.getByText("dev 个人轻量")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "更换" }));
    // 回到第 1 步：卡片重新展开
    expect(screen.getByText("SR 严谨流程")).toBeInTheDocument();
  });

  it("dev 入口走完流程：预览含意图与变量，提交回传 prompt 并折叠为摘要条", async () => {
    const { onSubmitPrompt, onViewSession } = setup();
    await walkToReview();

    const preview = screen.getByText(/进入 AAW 工作流/, { exact: false });
    expect(preview.textContent).toContain("dev 个人轻量");
    expect(preview.textContent).toContain("SR 编号：SR-009");
    expect(preview.textContent).toContain("一句话需求：给设置页加深色模式开关");
    expect(preview.textContent).toContain("不要继续已有 SR");

    await user.click(screen.getByRole("button", { name: "交给会话发送" }));
    expect(onSubmitPrompt).toHaveBeenCalledTimes(1);
    const prompt = onSubmitPrompt.mock.calls[0]?.[0] as string;
    expect(prompt).toContain("进入 AAW 工作流");
    expect(prompt).toContain("给设置页加深色模式开关");
    // 发送成功：整体折叠为横向摘要条
    expect(screen.getByText("已发起 SR-009")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "交给会话发送" }),
    ).not.toBeInTheDocument();
    // 摘要条「查看」切到会话视图；「重新发起」展开向导
    await user.click(screen.getByRole("button", { name: "查看" }));
    expect(onViewSession).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "重新发起" }));
    expect(
      screen.getByRole("button", { name: "下一步：填写变量" }),
    ).toBeDisabled();
  });

  it("无活跃会话：「交给会话发送」禁用并提示，点击不触发发送", async () => {
    const { onSubmitPrompt } = setup({ hasActiveSession: false });
    await walkToReview();

    const submit = screen.getByRole("button", { name: "交给会话发送" });
    expect(submit).toBeDisabled();
    expect(screen.getByText("先在项目页打开项目建立会话")).toBeInTheDocument();
    await user.click(submit);
    expect(onSubmitPrompt).not.toHaveBeenCalled();
  });

  it("发送被拒时表单内容与步骤原样保留（仅成功才清空）", async () => {
    const { onSubmitPrompt } = setup({
      onSubmitPrompt: vi.fn(() => false),
    });
    await walkToReview();

    await user.click(screen.getByRole("button", { name: "交给会话发送" }));
    expect(onSubmitPrompt).toHaveBeenCalledTimes(1);
    // 仍停在确认发送步：预览还在，未出现摘要条
    expect(
      screen.getByText(/进入 AAW 工作流/, { exact: false }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/已发起/)).not.toBeInTheDocument();
    // 返回修改：草稿值原样保留，可直接修复重试
    await user.click(screen.getByRole("button", { name: "返回修改" }));
    expect(screen.getByLabelText("SR 编号")).toHaveValue("SR-009");
    expect(screen.getByLabelText("一句话需求")).toHaveValue(
      "给设置页加深色模式开关",
    );
  });

  it("结构化失败（{ ok:false, reason }）：reason 以 role=alert 展示在发送按钮旁", async () => {
    setup({
      onSubmitPrompt: vi.fn(() => ({
        ok: false as const,
        reason:
          "连接 agent 失败：chrys.exe 不存在，请在设置中检查 agent 可执行路径",
      })),
    });
    await walkToReview();

    await user.click(screen.getByRole("button", { name: "交给会话发送" }));
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/连接 agent 失败/);
    expect(alert).toHaveTextContent(/请在设置中检查 agent 可执行路径/);
    // 表单保留可重试
    expect(screen.getByRole("button", { name: "交给会话发送" })).toBeEnabled();
  });

  it("连接 / 发送进行中发送按钮禁用（防重复提交），结束后恢复", async () => {
    let resolveSubmit: (value: { ok: true }) => void = () => {};
    setup({
      onSubmitPrompt: vi.fn(
        () =>
          new Promise<{ ok: true }>((resolve) => {
            resolveSubmit = resolve;
          }),
      ),
    });
    await walkToReview();

    const submit = screen.getByRole("button", { name: "交给会话发送" });
    await user.click(submit);
    // 提交未落定：按钮禁用且文案呈进行中
    expect(
      screen.getByRole("button", { name: "连接并发送中…" }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "交给会话发送" }),
    ).not.toBeInTheDocument();

    resolveSubmit({ ok: true });
    // 成功后折叠为摘要条（按钮退场即收口）
    expect(await screen.findByText("已发起 SR-009")).toBeInTheDocument();
  });

  it("SR 入口粘贴模式：缺原文时提示，补齐后预览带原文围栏", async () => {
    setup();
    await user.click(screen.getByLabelText(/SR 严谨流程/));
    await user.click(screen.getByRole("button", { name: "下一步：填写变量" }));

    await user.type(screen.getByLabelText("SR 编号"), "SR-001");
    await user.click(screen.getByRole("button", { name: "下一步：确认发送" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/需求原文/);

    await user.type(
      screen.getByLabelText(/需求原文（保持原文/),
      "支持批量导出账单",
    );
    await user.click(screen.getByRole("button", { name: "下一步：确认发送" }));
    const preview = screen.getByText(/进入 AAW 工作流/, { exact: false });
    expect(preview.textContent).toContain("<<<需求原文");
    expect(preview.textContent).toContain("支持批量导出账单");
  });

  it("SR 入口可切换为需求文件路径模式", async () => {
    setup();
    await user.click(screen.getByLabelText(/SR 严谨流程/));
    await user.click(screen.getByRole("button", { name: "下一步：填写变量" }));
    await user.type(screen.getByLabelText("SR 编号"), "SR-002");

    await user.click(screen.getByLabelText("选择需求文件"));
    await user.type(
      screen.getByLabelText(/需求文件路径/),
      "docs/requirement.md",
    );
    await user.click(screen.getByRole("button", { name: "下一步：确认发送" }));

    const preview = screen.getByText(/进入 AAW 工作流/, { exact: false });
    expect(preview.textContent).toContain("docs/requirement.md");
    expect(preview.textContent).not.toContain("<<<需求原文");
  });

  it("AR 入口收集编号与描述", async () => {
    const { onSubmitPrompt } = setup();
    await user.click(screen.getByLabelText(/AR 从 AR 切入/));
    await user.click(screen.getByRole("button", { name: "下一步：填写变量" }));

    await user.type(screen.getByLabelText("SR 编号"), "SR-001");
    await user.type(screen.getByLabelText("AR 编号"), "AR-003");
    await user.type(screen.getByLabelText("AR 描述"), "统一登录态");
    await user.click(screen.getByRole("button", { name: "下一步：确认发送" }));
    await user.click(screen.getByRole("button", { name: "交给会话发送" }));

    const prompt = onSubmitPrompt.mock.calls[0]?.[0] as string;
    expect(prompt).toContain("AR 编号：AR-003");
    expect(prompt).toContain("AR 描述：统一登录态");
  });
});
