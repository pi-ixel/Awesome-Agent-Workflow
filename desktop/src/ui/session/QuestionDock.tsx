/**
 * 结构化问答停靠面板（原 QuestionForm 模态的换代）：渲染一批挂起的
 * `_chrys/request_input` 提问，停靠在会话流与输入区之间——不弹窗、无
 * 遮罩，上方会话全程可见可滚动，回答所需的上下文（agent 刚说了什么、
 * 工具刚跑了什么）就在眼前。
 *
 * - 全部问题一次可见；问题多时面板内部滚动（max-h 限制），不把会话挤走；
 * - 头部给「已答 n/N」进度与来源（caller）；多项挂起时提示待办总数；
 * - 每问支持可选 note 备注（协议 AgentAnswer.note，随答案回传）；
 * - 每问一张卡：header 徽标 + 已答状态点 + 题干 + 选项行（单选 radio /
 *   多选 checkbox 语义）+ note 输入；全部问题都已选择时「提交回答」才
 *   可用（chrys ask_user.py 要求每问恰好一条非空答案，空选提交会被对端
 *   判为取消）。
 *
 * 组件持有本地选择/备注状态（纯 UI 态不入 store）；提交/取消调用
 * approvalStore 的 action。数据自取（activeId 焦点项），无需外部传参。
 */
import { useEffect, useRef, useState } from "react";

import {
  useApprovalStore,
  EMPTY_QUESTION_DRAFT,
} from "../../stores/approvalStore.ts";
import { useSettingsStore } from "../../stores/settingsStore.ts";
import type { AgentQuestion } from "../../acp/types.ts";
import {
  Badge,
  btnGhost,
  btnPrimary,
  CheckSquare,
  RadioDot,
} from "../controls.tsx";

/** 只读空集兜底，避免每次渲染新建对象。 */
const emptySelection: ReadonlySet<string> = new Set<string>();

/** 问答自动应答倒计时（评审确认 60s；设置项默认关闭）。 */
const AUTO_ANSWER_SECONDS = 60;

function QuestionCard({
  question,
  index,
  selections,
  notes,
  onToggle,
  onNote,
}: {
  readonly question: AgentQuestion;
  readonly index: number;
  readonly selections: Readonly<Record<number, ReadonlySet<string>>>;
  readonly notes: Readonly<Record<number, string>>;
  readonly onToggle: (
    index: number,
    multiSelect: boolean,
    label: string,
  ) => void;
  readonly onNote: (index: number, note: string) => void;
}): React.JSX.Element {
  const selected = selections[index] ?? emptySelection;
  return (
    <fieldset className="rounded-lg border border-line bg-surface/60 p-3">
      <div className="mb-1.5 flex items-center gap-2">
        <Badge tone="neutral">
          {question.header.length > 0 ? question.header : `问题 ${index + 1}`}
        </Badge>
        {question.multiSelect ? (
          <span className="text-2xs text-ink-ghost">可多选</span>
        ) : null}
        <span aria-hidden={true} className="flex-1" />
        {selected.size > 0 ? (
          <span
            className="size-1.5 rounded-full bg-ok"
            title="已作答"
            aria-label={`问题 ${index + 1} 已作答`}
          />
        ) : (
          <span
            className="size-1.5 rounded-full border border-line-strong"
            title="未作答"
            aria-label={`问题 ${index + 1} 未作答`}
          />
        )}
      </div>
      <p className="mb-2 text-sm leading-relaxed text-ink">
        {question.question}
      </p>
      <div className="grid grid-cols-1 gap-1.5">
        {question.options.map((option) => {
          const isSelected = selected.has(option.label);
          return (
            <button
              key={option.label}
              type="button"
              role={question.multiSelect ? "checkbox" : "radio"}
              aria-checked={isSelected}
              onClick={() => {
                onToggle(index, question.multiSelect, option.label);
              }}
              className={`flex cursor-pointer items-center gap-2.5 rounded-md border px-2.5 py-1.5 text-left transition-colors ${
                isSelected
                  ? "border-sky-600 bg-info-bg/40"
                  : "border-line hover:border-line-strong"
              }`}
            >
              {question.multiSelect ? (
                <CheckSquare checked={isSelected} />
              ) : (
                <RadioDot checked={isSelected} />
              )}
              <span className="min-w-0">
                <span className="block text-sm text-ink">{option.label}</span>
                {option.description.length > 0 ? (
                  <span className="mt-0.5 block text-xs leading-relaxed text-ink-mute">
                    {option.description}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
      <input
        type="text"
        value={notes[index] ?? ""}
        onChange={(event) => {
          onNote(index, event.target.value);
        }}
        placeholder="备注（可选，随答案回传）"
        aria-label={`问题 ${index + 1} 备注`}
        className="mt-2 w-full rounded-md border border-line bg-base/60 px-2.5 py-1.5 text-xs text-ink placeholder:text-ink-ghost focus:border-sky-600 focus:outline-none"
      />
    </fieldset>
  );
}

export function QuestionDock(): React.JSX.Element | null {
  const pending = useApprovalStore((state) => state.pending);
  const activeId = useApprovalStore((state) => state.activeId);
  const submitAnswers = useApprovalStore((state) => state.submitAnswers);
  const cancelQuestions = useApprovalStore((state) => state.cancelQuestions);

  const active =
    pending.find((item) => item.id === activeId && item.kind === "questions") ??
    null;

  // 题目索引 → 已选 label 集合 / 备注文本；面板按挂起项 id 重挂即重置
  const draft = useApprovalStore(
    (state) => state.questionDrafts[active?.id ?? ""] ?? EMPTY_QUESTION_DRAFT,
  );
  const { selections, notes } = draft;
  const setSelections = (
    update: (previous: typeof selections) => typeof selections,
  ) => {
    if (active)
      useApprovalStore
        .getState()
        .setQuestionDraft(active.id, { selections: update(selections), notes });
  };
  const setNotes = (update: (previous: typeof notes) => typeof notes) => {
    if (active)
      useApprovalStore
        .getState()
        .setQuestionDraft(active.id, { selections, notes: update(notes) });
  };

  // ---- 自动应答倒计时（M5）：设置开启才起表；面板内任何交互即取消本次，
  // 这一批必须手动提交——不会"刚想点另一个选项它自己交了"。
  // interactiveBatch 记录"已交互过的批次 id"：新批次天然重新起表，
  // 不需要 effect 里重置状态
  const autoAnswerEnabled = useSettingsStore(
    (state) => state.autoAnswerQuestions,
  );
  const [interactiveBatch, setInteractiveBatch] = useState<string | null>(null);

  if (active === null || active.kind !== "questions") {
    return null;
  }
  const questions = active.questions;
  const answeredCount = questions.filter(
    (_, index) => (selections[index] ?? emptySelection).size > 0,
  ).length;
  const allAnswered = answeredCount === questions.length;
  const otherPending = pending.filter(
    (item) => item.kind === "questions" && item.id !== active.id,
  ).length;

  function toggle(index: number, multiSelect: boolean, label: string): void {
    setSelections((previous) => {
      const current = previous[index] ?? emptySelection;
      const next = new Set<string>(current);
      if (next.has(label)) {
        next.delete(label);
      } else if (multiSelect) {
        next.add(label);
      } else {
        next.clear();
        next.add(label);
      }
      return { ...previous, [index]: next };
    });
  }

  // 到点自动提交：未作答的题用首个选项兜底（交互过即整批取消，到此为空选）
  function handleAutoAnswerExpire(): void {
    const orderedSelections = questions.map((question, index) => {
      const existing = selections[index];
      if (existing !== undefined && existing.size > 0) {
        return [...existing];
      }
      return [question.options[0]?.label ?? ""];
    });
    submitAnswers(
      focused.id,
      orderedSelections,
      questions.map((_, index) => notes[index]),
    );
  }

  // 闭包捕获收窄后的挂起项（function 声明会提升，丢掉上面的类型收窄）
  const focused = active;
  function handleSubmit(): void {
    const ordered = questions.map((_, index) => [
      ...(selections[index] ?? emptySelection),
    ]);
    const orderedNotes = questions.map((_, index) => notes[index]);
    submitAnswers(focused.id, ordered, orderedNotes);
  }

  return (
    <section
      aria-label="结构化问答"
      key={active.id}
      data-question-dock=""
      onPointerDownCapture={() => {
        setInteractiveBatch(focused.id);
      }}
      onFocusCapture={() => {
        setInteractiveBatch(focused.id);
      }}
      className="w-full overflow-hidden rounded-2xl border border-info-line bg-surface shadow-lg"
    >
      <header className="flex items-center gap-2 border-b border-line px-4 py-2">
        <Badge tone="info">
          {active.stale ? "等待重连后重新绑定" : "结构化提问"}
        </Badge>
        <span className="text-xs text-ink-faint">
          {`已答 ${answeredCount}/${questions.length}`}
          {active.callerName !== null && active.callerName.length > 0
            ? ` · 来自 ${active.callerName}`
            : ""}
        </span>
        {otherPending > 0 ? (
          <span className="text-2xs text-ink-ghost">
            另有 {otherPending} 项待答（顶栏待办可切换）
          </span>
        ) : null}
        <span aria-hidden={true} className="flex-1" />
        {autoAnswerEnabled &&
        !focused.stale &&
        interactiveBatch !== focused.id ? (
          <AutoAnswerCountdown
            key={focused.id}
            firstLabel={questions[0]?.options[0]?.label ?? ""}
            onExpire={handleAutoAnswerExpire}
          />
        ) : null}
        <button
          type="button"
          onClick={() => {
            cancelQuestions(active.id);
          }}
          className={`${btnGhost} px-2.5 py-1 text-xs`}
        >
          取消整批
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!allAnswered || active.stale}
          className={`${btnPrimary} px-3 py-1 text-xs`}
        >
          提交回答
        </button>
      </header>
      {/* 问题区：面板内部滚动，上方会话保持可见 */}
      <div className="max-h-64 space-y-2.5 overflow-y-auto px-4 py-3">
        {questions.map((question, index) => (
          <QuestionCard
            key={index}
            question={question}
            index={index}
            selections={selections}
            notes={notes}
            onToggle={toggle}
            onNote={(qIndex, note) => {
              setNotes((previous) => ({ ...previous, [qIndex]: note }));
            }}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * 自动应答倒计时（QuestionDock 私有）：挂载即起表 60s；到点经 onExpire
 * 提交（回调经 ref 取最新闭包）。按批次 key 重挂即重置，交互取消由
 * 父组件卸载本组件实现（interval 随清理收口）。
 */
function AutoAnswerCountdown({
  firstLabel,
  onExpire,
}: {
  readonly firstLabel: string;
  readonly onExpire: () => void;
}): React.JSX.Element {
  const [secondsLeft, setSecondsLeft] = useState(AUTO_ANSWER_SECONDS);
  const onExpireRef = useRef(onExpire);
  useEffect(() => {
    onExpireRef.current = onExpire;
  }, [onExpire]);
  useEffect(() => {
    if (secondsLeft !== 0) {
      return;
    }
    onExpireRef.current();
    return () => {
      // 到点后不再需要计时（组件通常随即随挂起项一起消失，防御性收口）
    };
  }, [secondsLeft]);
  useEffect(() => {
    const timer = setInterval(() => {
      setSecondsLeft((current) => Math.max(0, current - 1));
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return (
    <span className="text-2xs text-ink-ghost" data-auto-answer-countdown="">
      {secondsLeft}s 后自动选「{firstLabel}」
    </span>
  );
}
