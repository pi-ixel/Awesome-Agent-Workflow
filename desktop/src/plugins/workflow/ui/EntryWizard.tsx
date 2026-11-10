/**
 * 入口启动向导：选择 AAW 工作流入口（SR / AR / dev）→ 按入口收集变量 →
 * 生成首条中文 prompt 预览 → 交给会话发送。
 *
 * 领域逻辑（入口元数据、校验、prompt 生成）在 `src/aaw/entryWizard.ts`，
 * 本组件只做表单与流程编排；`onSubmitPrompt` 由父组件接到会话发送
 * （开发页的 sessionStore），组件不直接触碰协议层。
 *
 * 交互约定：
 * - 无活跃会话时「交给会话发送」禁用，并提示先打开项目；
 * - 发送被会话侧拒绝（`onSubmitPrompt` 返回 false 或 `{ ok:false, reason }`）
 *   时表单内容与步骤原样保留，reason 在发送按钮旁以 role=alert 展示，
 *   用户修复后可直接重试；仅发送成功才清空并折叠为摘要条；
 * - 连接 / 发送进行中发送按钮禁用（防重复提交）；
 * - 已选定入口进入第 2/3 步后，第一步的三张入口卡片折叠为一行紧凑摘要
 *   （「更换」可点回第一步）；
 * - 发送成功后整体折叠为一条横向摘要条（「查看」切到会话视图）。
 */
import { useEffect, useState } from "react";
import {
  AAW_ENTRY_DEFINITIONS,
  buildEntryPrompt,
  entryTitleOf,
  validateEntryInput,
  type AawEntryId,
  type AawEntryInput,
  type SrRequirementMode,
} from "../launch/entryWizard.ts";
import type { WizardSubmitResult } from "./wizardSubmit.ts";
import {
  Badge,
  btnGhost,
  btnPrimary,
  focusVisibleRing,
  RadioDot,
} from "../../../shared/ui/controls.tsx";

/** SR 入口的需求原文多行输入行数。 */
const REQUIREMENT_TEXTAREA_ROWS = 6;

interface EntryWizardProps {
  /** 仅进程内保留项目草稿；不写 localStorage，不在重启后恢复。 */
  readonly draftKey?: string;
  readonly drafts?: Map<string, WizardMemory>;
  /**
   * 首条 prompt 已生成，交给会话发送。失败形态：显式 false（含 Promise
   * resolve 为 false）或 `{ ok:false, reason }`（reason 为用户可读原因，
   * 如「先连接再发送」的异步流程失败）——两种形态均保留表单供重试；
   * 结构化 reason 会展示在发送按钮旁。返回 void / true / { ok:true }
   * 视为已接受。
   */
  readonly onSubmitPrompt: (
    prompt: string,
  ) =>
    | boolean
    | void
    | WizardSubmitResult
    | Promise<boolean | void | WizardSubmitResult>;
  /** 是否存在活跃会话；缺省视为有（独立渲染 / 既有用例兼容）。 */
  readonly hasActiveSession?: boolean;
  /** 摘要条上的「查看」：切到会话视图（未提供则不渲染该按钮）。 */
  readonly onViewSession?: () => void;
  /** 初始入口（slash 命令定位用）：非空时向导直接从该入口的表单开始。 */
  readonly initialEntry?: AawEntryId;
}

/** 表单草稿（允许中间空值，提交前由 validateEntryInput 把关）。 */
interface WizardDraft {
  sr: string;
  requirementMode: SrRequirementMode;
  requirementFile: string;
  requirementText: string;
  ar: string;
  arDescription: string;
  devRequirement: string;
}

const EMPTY_DRAFT: WizardDraft = {
  sr: "",
  requirementMode: "paste",
  requirementFile: "",
  requirementText: "",
  ar: "",
  arDescription: "",
  devRequirement: "",
};

export interface WizardMemory {
  step: 1 | 2 | 3;
  entryId: AawEntryId | null;
  draft: WizardDraft;
  sentSr: string | null;
}

const inputClassName = `w-full rounded-md border border-line-strong bg-base px-3 py-2 text-sm text-ink placeholder:text-ink-ghost focus:border-ink-faint ${focusVisibleRing}`;

/** 步骤圆圈三态：完成 = accent 实底白勾；当前 = accent 描边高亮；
 *  未到 = 灰描边弱化。 */
function stepCircleClass(state: "done" | "current" | "upcoming"): string {
  switch (state) {
    case "done":
      return "border-sky-600 bg-sky-600 text-white";
    case "current":
      return "border-sky-500 bg-sky-600/20 font-medium text-accent-ink";
    case "upcoming":
      return "border-line-strong text-ink-faint";
  }
}

/** 步骤间连接线：按完成度着色（前方步骤已完成 → accent，未完成 → 灰）。 */
function connectorClass(state: "done" | "upcoming"): string {
  return state === "done" ? "bg-sky-500" : "bg-line-strong";
}

function EntryWizard({
  draftKey,
  drafts,
  onSubmitPrompt,
  hasActiveSession = true,
  onViewSession,
  initialEntry,
}: EntryWizardProps) {
  const saved = draftKey ? drafts?.get(draftKey) : undefined;
  // 显式斜杠入口优先于项目上次选择；草稿字段仍可恢复。
  const [step, setStep] = useState<1 | 2 | 3>(
    initialEntry !== undefined ? 2 : (saved?.step ?? 1),
  );
  const [entryId, setEntryId] = useState<AawEntryId | null>(
    initialEntry ?? saved?.entryId ?? null,
  );
  const [draft, setDraft] = useState<WizardDraft>(saved?.draft ?? EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);
  /** 发送失败的用户可见原因（连接失败 / 发送被拒；role=alert 展示）。 */
  const [submitError, setSubmitError] = useState<string | null>(null);
  /** 连接 / 发送进行中：禁用发送按钮防重复提交。 */
  const [isSubmitting, setIsSubmitting] = useState(false);
  /** 发送成功后的折叠摘要（SR 编号）；非 null 时向导整体折叠为摘要条。 */
  const [sentSr, setSentSr] = useState<string | null>(
    initialEntry !== undefined ? null : (saved?.sentSr ?? null),
  );
  useEffect(() => {
    if (draftKey) drafts?.set(draftKey, { step, entryId, draft, sentSr });
  }, [draftKey, drafts, step, entryId, draft, sentSr]);

  function patch(fields: Partial<WizardDraft>): void {
    setDraft((prev) => ({ ...prev, ...fields }));
  }

  /** 草稿 → 领域输入模型（按入口挑选字段）。 */
  function buildInput(): AawEntryInput | null {
    if (entryId === null) {
      return null;
    }
    switch (entryId) {
      case "sr":
        return {
          kind: "sr",
          sr: draft.sr,
          requirementMode: draft.requirementMode,
          requirementFile: draft.requirementFile,
          requirementText: draft.requirementText,
        };
      case "ar":
        return {
          kind: "ar",
          sr: draft.sr,
          ar: draft.ar,
          description: draft.arDescription,
        };
      case "dev":
        return { kind: "dev", sr: draft.sr, requirement: draft.devRequirement };
    }
  }

  function goToReview(): void {
    const input = buildInput();
    if (input === null) {
      return;
    }
    const violation = validateEntryInput(input);
    if (violation !== null) {
      setError(violation);
      return;
    }
    setError(null);
    setStep(3);
  }

  async function handleSubmit(): Promise<void> {
    const input = buildInput();
    if (input === null) {
      return;
    }
    if (validateEntryInput(input) !== null) {
      setStep(2);
      return;
    }
    // 连接 / 发送进行中禁用发送按钮（防重复提交），结束后解除
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      // 显式 false 或结构化失败均视为发送被拒：表单与步骤原样保留，让
      // 用户修复后重试；结构化 reason（连接失败的具体原因 + 指引）在
      // 发送按钮旁以 role=alert 展示；void / true / { ok:true } 按成功收口
      const outcome = await onSubmitPrompt(buildEntryPrompt(input));
      if (outcome === false) {
        setSubmitError("发送未完成，请重试");
        return;
      }
      if (typeof outcome === "object" && outcome !== null && !outcome.ok) {
        setSubmitError(outcome.reason);
        return;
      }
      setSentSr(input.sr);
      setDraft(EMPTY_DRAFT);
      setEntryId(null);
      setStep(1);
      setError(null);
      setSubmitError(null);
    } finally {
      setIsSubmitting(false);
    }
  }

  const previewInput = step === 3 ? buildInput() : null;

  // 发送成功：整体折叠为一条横向摘要条（查看切会话视图 / 重新发起展开）
  if (sentSr !== null) {
    return (
      <section
        aria-label="入口启动向导"
        className="rounded-lg border border-line bg-surface p-4"
      >
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-info-line bg-info-bg/40 px-3 py-2"
        >
          <span className="text-xs text-info-ink">已发起 {sentSr}</span>
          <span className="flex items-center gap-3">
            {onViewSession !== undefined ? (
              <button
                type="button"
                onClick={onViewSession}
                className="text-xs text-accent-ink transition-colors hover:text-accent-ink-strong"
              >
                查看
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                setSentSr(null);
              }}
              className="text-xs text-ink-mute transition-colors hover:text-ink"
            >
              重新发起
            </button>
          </span>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label="入口启动向导"
      className="rounded-lg border border-line bg-surface p-4"
    >
      <header className="mb-4">
        <h3 className="text-base font-medium text-ink">入口启动向导</h3>
        <p className="mt-1 text-xs text-ink-faint">
          选择入口并填写变量，生成首条 prompt 交给会话；实际启动由会话侧的
          aaw-workflow 技能执行。
        </p>
      </header>

      <ol
        className="mb-4 flex items-center gap-2 text-xs"
        aria-label="向导步骤"
      >
        {["选择入口", "填写变量", "确认发送"].map((title, index) => {
          const value = (index + 1) as 1 | 2 | 3;
          const state =
            step === value
              ? ("current" as const)
              : step > value
                ? ("done" as const)
                : ("upcoming" as const);
          return (
            <li key={title} className="flex items-center gap-2">
              <span
                aria-current={state === "current" ? "step" : undefined}
                className={`flex h-5 w-5 items-center justify-center rounded-full border text-2xs transition-colors ${stepCircleClass(state)}`}
              >
                {state === "done" ? (
                  // 完成步：accent 实底上的白勾（数字保留给 aria 之外的场景）
                  <svg
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden={true}
                    className="h-2.5 w-2.5"
                  >
                    <path d="M2.5 6.5 5 9l4.5-6" />
                  </svg>
                ) : (
                  value
                )}
              </span>
              <span
                className={state === "current" ? "text-ink" : "text-ink-faint"}
              >
                {title}
              </span>
              {value < 3 ? (
                <span
                  aria-hidden={true}
                  className={`h-px w-6 transition-colors ${connectorClass(step > value ? "done" : "upcoming")}`}
                />
              ) : null}
            </li>
          );
        })}
      </ol>

      {step === 1 ? (
        <fieldset>
          <legend className="mb-2 text-sm text-ink-soft">选择工作流入口</legend>
          <div className="space-y-2">
            {AAW_ENTRY_DEFINITIONS.map((entry) => (
              <label
                key={entry.id}
                className={`flex cursor-pointer items-center gap-3 rounded-md border p-3 transition-colors ${
                  entryId === entry.id
                    ? "border-sky-600 bg-info-bg/40"
                    : "border-line bg-base hover:border-line-strong"
                }`}
              >
                {/* radio 固定为左竖栏并垂直居中于卡片，文案块整体右移，
                    原生 input 只承担语义与键盘（视觉隐藏）。 */}
                <input
                  type="radio"
                  name="aaw-entry"
                  value={entry.id}
                  checked={entryId === entry.id}
                  onChange={() => {
                    setEntryId(entry.id);
                    setError(null);
                  }}
                  className="peer sr-only"
                />
                <RadioDot checked={entryId === entry.id} />
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="block text-sm font-medium text-ink">
                      {entry.title}
                    </span>
                    {entry.id === "dev" ? (
                      <Badge tone="info">新手推荐</Badge>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block text-xs text-ink-mute">
                    {entry.summary}
                  </span>
                  <span className="mt-1 block text-xs leading-relaxed text-ink-faint">
                    {entry.detail}
                  </span>
                  <span className="mt-1.5 flex flex-wrap gap-1">
                    {entry.vars.map((name) => (
                      <Badge key={name} tone="neutral">
                        <span className="font-mono">{name}</span>
                      </Badge>
                    ))}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              disabled={entryId === null}
              onClick={() => setStep(2)}
              className={`${btnPrimary} px-3 py-1.5 text-sm`}
            >
              下一步：填写变量
            </button>
          </div>
        </fieldset>
      ) : null}

      {/* 已选定入口走到第 2/3 步：第一步的三张入口卡片折叠为一行紧凑
          摘要，「更换」可点回第一步重新选择。 */}
      {step !== 1 && entryId !== null ? (
        <div className="mb-3 flex items-center justify-between gap-2 rounded-md border border-line bg-base px-3 py-2">
          <span className="min-w-0 truncate text-xs text-ink-mute">
            已选入口：
            <span className="font-medium text-ink">
              {entryTitleOf(entryId)}
            </span>
          </span>
          <button
            type="button"
            onClick={() => {
              setStep(1);
            }}
            className="shrink-0 text-xs text-accent-ink transition-colors hover:text-accent-ink-strong"
          >
            更换
          </button>
        </div>
      ) : null}

      {step === 2 && entryId !== null ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            goToReview();
          }}
        >
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-xs text-ink-mute">SR 编号</span>
              <input
                type="text"
                value={draft.sr}
                onChange={(event) => patch({ sr: event.target.value })}
                placeholder="SR-001"
                className={inputClassName}
              />
            </label>
            <span className="mt-1 block text-xs text-ink-faint">
              没有现成编号就自拟一个（如 SR-001），仅用于标识这次工作流。
            </span>

            {entryId === "sr" ? (
              <>
                <fieldset>
                  <legend className="mb-1 text-xs text-ink-mute">
                    原始需求提供方式
                  </legend>
                  <div className="flex gap-4 text-xs text-ink-soft">
                    <label className="flex cursor-pointer items-center gap-1.5">
                      <input
                        type="radio"
                        name="requirement-mode"
                        checked={draft.requirementMode === "file"}
                        onChange={() => patch({ requirementMode: "file" })}
                        className="peer sr-only"
                      />
                      <RadioDot checked={draft.requirementMode === "file"} />
                      选择需求文件
                    </label>
                    <label className="flex cursor-pointer items-center gap-1.5">
                      <input
                        type="radio"
                        name="requirement-mode"
                        checked={draft.requirementMode === "paste"}
                        onChange={() => patch({ requirementMode: "paste" })}
                        className="peer sr-only"
                      />
                      <RadioDot checked={draft.requirementMode === "paste"} />
                      粘贴需求原文
                    </label>
                  </div>
                </fieldset>
                {draft.requirementMode === "file" ? (
                  <label className="block">
                    <span className="mb-1 block text-xs text-ink-mute">
                      需求文件路径（仓库内 Markdown 文件）
                    </span>
                    <input
                      type="text"
                      value={draft.requirementFile}
                      onChange={(event) =>
                        patch({ requirementFile: event.target.value })
                      }
                      placeholder="docs/requirement.md"
                      className={inputClassName}
                    />
                  </label>
                ) : (
                  <label className="block">
                    <span className="mb-1 block text-xs text-ink-mute">
                      需求原文（保持原文，不总结不改写）
                    </span>
                    <textarea
                      value={draft.requirementText}
                      onChange={(event) =>
                        patch({ requirementText: event.target.value })
                      }
                      rows={REQUIREMENT_TEXTAREA_ROWS}
                      placeholder="在此粘贴原始需求…"
                      className={`${inputClassName} resize-y font-mono`}
                    />
                  </label>
                )}
              </>
            ) : null}

            {entryId === "ar" ? (
              <>
                <label className="block">
                  <span className="mb-1 block text-xs text-ink-mute">
                    AR 编号
                  </span>
                  <input
                    type="text"
                    value={draft.ar}
                    onChange={(event) => patch({ ar: event.target.value })}
                    placeholder="AR-003"
                    className={inputClassName}
                  />
                </label>
                <span className="mt-1 block text-xs text-ink-faint">
                  没有现成编号就自拟一个（如 AR-001）。
                </span>
                <label className="block">
                  <span className="mb-1 block text-xs text-ink-mute">
                    AR 描述
                  </span>
                  <textarea
                    value={draft.arDescription}
                    onChange={(event) =>
                      patch({ arDescription: event.target.value })
                    }
                    rows={2}
                    placeholder="这个 AR 要完成什么…"
                    className={`${inputClassName} resize-y`}
                  />
                </label>
              </>
            ) : null}

            {entryId === "dev" ? (
              <label className="block">
                <span className="mb-1 block text-xs text-ink-mute">
                  一句话需求
                </span>
                <input
                  type="text"
                  value={draft.devRequirement}
                  onChange={(event) =>
                    patch({ devRequirement: event.target.value })
                  }
                  placeholder="例：为用户模块增加 JWT 登录，含注册/登录接口，密码 bcrypt 存储，失败返回明确错误提示"
                  className={inputClassName}
                />
              </label>
            ) : null}
          </div>

          {error !== null ? (
            <p role="alert" className="mt-3 text-xs text-danger-ink">
              {error}
            </p>
          ) : null}

          <div className="mt-4 flex justify-between">
            <button
              type="button"
              onClick={() => setStep(1)}
              className={`${btnGhost} px-3 py-1.5 text-sm`}
            >
              上一步
            </button>
            <button
              type="submit"
              className={`${btnPrimary} px-3 py-1.5 text-sm`}
            >
              下一步：确认发送
            </button>
          </div>
        </form>
      ) : null}

      {previewInput !== null ? (
        <div>
          <p className="mb-2 text-sm text-ink-soft">
            首条 prompt 预览（含「进入工作流」意图与入口变量）：
          </p>
          <pre className="max-h-64 overflow-auto rounded-md border border-line bg-base p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink-soft">
            {buildEntryPrompt(previewInput)}
          </pre>
          {/* 无活跃会话：发送禁用并提示；表单内容保留不受影响。
              连接 / 发送失败：reason 以 role=alert 展示在按钮旁。 */}
          <div className="mt-4 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => {
                setSubmitError(null);
                setStep(2);
              }}
              className={`${btnGhost} px-3 py-1.5 text-sm`}
            >
              返回修改
            </button>
            <div className="flex max-w-[60%] flex-col items-end gap-1">
              <button
                type="button"
                onClick={() => {
                  void handleSubmit();
                }}
                disabled={!hasActiveSession || isSubmitting}
                className={`${btnPrimary} px-3 py-1.5 text-sm`}
              >
                {isSubmitting ? "连接并发送中…" : "交给会话发送"}
              </button>
              {!hasActiveSession ? (
                <span className="text-2xs text-warn-ink">
                  先在项目页打开项目建立会话
                </span>
              ) : null}
              {submitError !== null ? (
                <p
                  role="alert"
                  className="text-right text-2xs leading-relaxed text-danger-ink"
                >
                  {submitError}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export default EntryWizard;
