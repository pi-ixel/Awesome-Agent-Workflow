import { useApprovalValue, useConversation } from "../../ui/bindings/conversationView.ts";
import { useProjectPageValue } from "../../ui/bindings/projectView.tsx";
import { useSessionCommands } from "../../conversation/ui/useSessionCommands.ts";
import {
  EMPTY_QUESTION_DRAFT,
} from "../approvalStore.ts";
import { useProjectPreferences } from "../../ui/preferencesView.tsx";
import { Listbox } from "../../../../shared/ui/controls.tsx";
import { QuestionChoices, QuestionPanel } from "./QuestionPanel.tsx";

export function QuestionDock() {
  const { submitAnswers, cancelQuestions, select, setQuestionDraft } = useSessionCommands();
  const foregroundApproval = useConversation()?.approval;
  const pending = useApprovalValue((s) => s.pending);
  const activeId = useApprovalValue((s) => s.activeId);
  const drafts = useApprovalValue((s) => s.questionDrafts);
  const overlayOpen = useProjectPageValue((s) => s.overlayOpen);
  const { values: { autoAnswerQuestions: auto } } = useProjectPreferences();
  const active = pending.find((item) => item.id === activeId);
  if (active?.kind !== "questions" || overlayOpen) return null;
  const draft = drafts[active.id] ?? EMPTY_QUESTION_DRAFT;
  const page = Math.min(
    draft.page ?? 0,
    Math.max(0, active.questions.length - 1),
  );
  const question = active.questions[page];
  const write = (patch: Partial<typeof draft>) =>
    setQuestionDraft(active.id, { ...draft, ...patch });
  const valid = (index: number) => {
    const q = active.questions[index],
      values = [...(draft.selections[index] ?? [])];
    if (!q) return false;
    if (values.length === 0) return Boolean(draft.notes[index]?.trim());
    return (q.multiSelect || values.length === 1) &&
      values.every((value) => q.options.some((option) => option.label === value));
  };
  const send = () => {
    if (!valid(page) || active.stale) return;
    if (page < active.questions.length - 1) {
      write({ page: page + 1 });
      return;
    }
    const invalid = active.questions.findIndex((_, i) => !valid(i));
    if (invalid >= 0) {
      write({ page: invalid });
      return;
    }
    submitAnswers(
      active.id,
      active.questions.map((_, i) => [...(draft.selections[i] ?? [])]),
      active.questions.map((_, i) => draft.notes[i]),
    );
  };
  const batches = pending.filter((item) => item.kind === "questions");
  return (
    <div className="space-y-2">
      {batches.length > 1 && (
        <Listbox
          label="待答问题批次"
          value={active.id}
          options={batches.map((item) => ({
            value: item.id,
            label: item.inboxTitle,
          }))}
          onChange={select}
        />
      )}
      <QuestionPanel
        key={active.id}
        id={active.id}
        label="问题"
        title={question?.question ?? "暂无问题"}
        page={page}
        count={active.questions.length}
        valid={valid(page)}
        stale={active.stale}
        canSkip={false}
        interacted={!!draft.interacted}
        onInteract={() => {
          if (!draft.interacted) write({ interacted: true });
        }}
        onBack={() => write({ page: Math.max(0, page - 1) })}
        onSend={send}
        onSkip={() => {}}
        onClose={() => cancelQuestions(active.id)}
        onAuto={
          auto &&
          active.questions.length > 0 &&
          active.questions.every((q) => q.options.length > 0)
            ? () => {
                if (
                  foregroundApproval?.getState().questionDrafts[active.id]
                    ?.interacted
                )
                  return;
                if (
                  foregroundApproval?.getState()
                    .pending.find((item) => item.id === active.id)?.stale
                )
                  return;
                submitAnswers(
                  active.id,
                  active.questions.map((q) => [q.options[0]!.label]),
                );
              }
            : undefined
        }
      >
        {question && (
          <>
            <QuestionChoices
              multi={question.multiSelect}
              options={question.options.map((option) => ({
                value: option.label,
                label: option.label,
                description: option.description,
              }))}
              selected={[...(draft.selections[page] ?? [])]}
              onToggle={(value) => {
                const next = new Set(draft.selections[page] ?? []);
                if (next.has(value)) next.delete(value);
                else {
                  if (!question.multiSelect) next.clear();
                  next.add(value);
                }
                write({ selections: { ...draft.selections, [page]: next } });
              }}
            />
            <input
              type="text"
              aria-label={`问题 ${page + 1} 自定义回答或补充说明`}
              placeholder="输入自定义回答或补充说明"
              value={draft.notes[page] ?? ""}
              onChange={(event) =>
                write({ notes: { ...draft.notes, [page]: event.target.value } })
              }
              className="w-full rounded-lg border border-line bg-base px-3 py-2 text-ui-base placeholder:text-ink-faint"
            />
          </>
        )}
      </QuestionPanel>
    </div>
  );
}
