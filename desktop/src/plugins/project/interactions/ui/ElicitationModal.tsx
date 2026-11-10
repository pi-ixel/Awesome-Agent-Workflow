import {
  useProject,
  useProjectPageValue,
} from "../../ui/bindings/projectView.tsx";
import { useStore } from "zustand";
import type { ProjectService } from "../../service.ts";
import {
  customAnswerDraftKey,
  fieldOptions,
  validateForm,
  type FormViewItem,
} from "../form.ts";
import { type FormValue } from "../../../../contracts/acp/elicitation.ts";
import { useProjectPreferences } from "../../ui/preferencesView.tsx";
import { Listbox, btnSecondary } from "../../../../shared/ui/controls.tsx";
import { QuestionChoices, QuestionPanel } from "./QuestionPanel.tsx";

function FormCard({
  item,
  project,
}: {
  item: FormViewItem;
  project: ProjectService;
}) {
  const { editForm: edit, progressForm: progress } = project.interactions;
  const {
    values: { autoAnswerQuestions: auto },
  } = useProjectPreferences();
  const fields = Object.entries(item.form.requestedSchema.properties);
  const page = Math.min(item.page, Math.max(0, fields.length - 1));
  const current = fields[page];
  const key = current?.[0],
    field = current?.[1];
  const value = key ? item.values[key] : undefined;
  const required = !!key && !!item.form.requestedSchema.required?.includes(key);
  const { errors } = validateForm(item.form, item.values);
  const options =
    field?.type === "boolean"
      ? [
          { value: "true", label: "是" },
          { value: "false", label: "否" },
        ]
      : field
        ? fieldOptions(field)
        : null;
  const customAnswer =
    !!key &&
    item.form.customAnswerField === key &&
    fields.length === 1 &&
    field?.type === "string" &&
    !!options?.length;
  const change = (next: FormValue) => {
    if (key) edit(item.id, { ...item.values, [key]: next });
  };
  const automatic = { ...item.values };
  const selectionOnly =
    fields.length > 0 &&
    fields.every(([name, schema]) => {
      const choices = fieldOptions(schema);
      if (schema.type !== "string" && schema.type !== "array") return false;
      if (!choices?.length) return false;
      automatic[name] =
        schema.type === "array"
          ? choices
              .slice(0, Math.max(1, schema.minItems ?? 1))
              .map((choice) => choice.value)
          : choices[0]!.value;
      return true;
    });
  const next = () => {
    const latest = project.interactions.forms
      .getState()
      .pending.find((entry) => entry.id === item.id);
    if (!latest || latest.stale || latest.submitting) return;
    if (page < fields.length - 1) {
      progress(item.id, { page: page + 1 });
      return;
    }
    const invalid = validateForm(item.form, latest.values).errors;
    const firstInvalid = fields.findIndex(([name]) => invalid[name]);
    if (firstInvalid >= 0) {
      progress(item.id, { page: firstInvalid });
      return;
    }
    if (!Object.keys(invalid).length)
      project.interactions.answerForm(item.id, "accept");
  };
  return (
    <QuestionPanel
      key={item.id}
      id={item.id}
      label="问题"
      title={
        field?.title ?? key ?? item.form.requestedSchema.title ?? "确认信息"
      }
      description={[
        item.form.message,
        field?.description ?? item.form.requestedSchema.description,
      ]
        .filter(Boolean)
        .join("\n")}
      page={page}
      count={Math.max(1, fields.length)}
      stale={item.stale}
      submitting={item.submitting}
      interacted={item.interacted}
      onInteract={() => {
        if (!item.interacted) progress(item.id, { interacted: true });
      }}
      valid={key ? !errors[key] : !Object.keys(errors).length}
      canSkip={!!key && !required}
      onBack={() => progress(item.id, { page: Math.max(0, page - 1) })}
      onSend={next}
      onSkip={() => {
        if (required || !key || item.stale) return;
        const values = { ...item.values };
        delete values[key];
        edit(item.id, values);
        next();
      }}
      onClose={() => project.interactions.answerForm(item.id, "cancel")}
      onAuto={
        auto &&
        selectionOnly &&
        !Object.keys(validateForm(item.form, automatic).errors).length
          ? () => {
              const current = project.interactions.forms
                .getState()
                .pending.find((entry) => entry.id === item.id);
              if (!current || current.stale || current.interacted) return;
              edit(item.id, automatic);
              project.interactions.answerForm(item.id, "accept");
            }
          : undefined
      }
    >
      {field && key && (
        <>
          {options ? (
            <>
              <QuestionChoices
                multi={field.type === "array"}
                options={options}
                selected={
                  Array.isArray(value)
                    ? value
                    : value === undefined
                      ? []
                      : [String(value)]
                }
                onToggle={(selected) => {
                  if (field.type === "array")
                    change(
                      Array.isArray(value) && value.includes(selected)
                        ? value.filter((v) => v !== selected)
                        : [...(Array.isArray(value) ? value : []), selected],
                    );
                  else
                    change(
                      field.type === "boolean" ? selected === "true" : selected,
                    );
                }}
              />
              {customAnswer && (
                <input
                  type="text"
                  aria-label="自定义回答或补充说明"
                  placeholder="输入自定义回答或补充说明"
                  value={
                    typeof item.values[customAnswerDraftKey] === "string"
                      ? item.values[customAnswerDraftKey]
                      : ""
                  }
                  onChange={(event) =>
                    edit(item.id, {
                      ...item.values,
                      [customAnswerDraftKey]: event.target.value,
                    })
                  }
                  className="w-full rounded-lg border border-line bg-base px-3 py-2 text-ui-base placeholder:text-ink-faint"
                />
              )}
            </>
          ) : ["string", "number", "integer"].includes(field.type) ? (
            <input
              key={key}
              aria-label={field.title ?? key}
              type={field.type === "string" ? "text" : "number"}
              step={field.type === "integer" ? "1" : "any"}
              value={
                typeof value === "string" || typeof value === "number"
                  ? value
                  : ""
              }
              onChange={(event) => change(event.target.value)}
              placeholder="填写回答"
              className="w-full rounded-lg border border-line-strong bg-base px-3 py-2 text-ui-base"
            />
          ) : (
            <p className="text-warn-ink">暂不支持此字段类型</p>
          )}
          {item.interacted && errors[key] && (
            <p className="text-ui-caption text-warn-ink">{errors[key]}</p>
          )}
        </>
      )}
    </QuestionPanel>
  );
}

function FormQueue({
  items,
  project,
}: {
  items: readonly FormViewItem[];
  project: ProjectService;
}) {
  const selected = useStore(project.interactions.forms, (s) => s.activeId);
  const item =
    items.find((item) => item.id === selected) ??
    items.find((item) => !item.stale) ??
    items[0];
  if (!item) return null;
  return (
    <div className="space-y-2">
      {items.length > 1 && (
        <Listbox
          label="待答表单批次"
          value={item.id}
          options={items.map((entry) => ({
            value: entry.id,
            label: `${entry.label} · ${entry.form.message}`,
          }))}
          onChange={project.interactions.selectForm}
        />
      )}
      <FormCard key={item.id} item={item} project={project} />
    </div>
  );
}
export function ElicitationDock() {
  const project = useProject();
  return project ? <ElicitationDockView project={project} /> : null;
}

function ElicitationDockView({ project }: { project: ProjectService }) {
  const pending = useStore(project.interactions.forms, (s) => s.pending);
  const overlayOpen = useProjectPageValue((s) => s.overlayOpen);
  if (overlayOpen) return null;
  return (
    <FormQueue
      project={project}
      items={pending.filter((item) => item.isForeground && !!item.sessionId)}
    />
  );
}

/** Compatibility export: non-modal card, with no backdrop. */
export function ElicitationModal() {
  const project = useProject();
  return project ? <ElicitationModalView project={project} /> : null;
}

function ElicitationModalView({ project }: { project: ProjectService }) {
  const pending = useStore(project.interactions.forms, (s) => s.pending);
  const foregroundVisible = useProjectPageValue(
    (s) => !s.overlayOpen && s.conversationPage,
  );
  const unscoped = pending.filter((item) => !item.sessionId);
  const background = pending.filter(
    (item) =>
      !!item.sessionId &&
      (!item.isForeground || !foregroundVisible) &&
      !item.stale,
  );
  if (!unscoped.length && !background.length) return null;
  return (
    <aside
      aria-label="Agent 待答问题"
      className="fixed bottom-4 right-4 z-40 w-[min(520px,calc(100vw-32px))] space-y-2"
    >
      {background.map((item) => (
        <div
          key={item.id}
          className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-ui-base text-ink shadow-lg"
        >
          <span className="min-w-0 flex-1 truncate">
            {item.label} 有问题待回答
          </span>
          <button
            type="button"
            className={`${btnSecondary} shrink-0 px-3 py-1`}
            onClick={() => project.interactions.activateForm(item.id)}
          >
            前往回答
          </button>
        </div>
      ))}
      <FormQueue items={unscoped} project={project} />
    </aside>
  );
}
