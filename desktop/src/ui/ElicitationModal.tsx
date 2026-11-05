import {
  fieldOptions,
  validateForm,
  type FormValue,
} from "../acp/elicitation.ts";
import {
  useElicitationStore,
  type PendingForm,
} from "../stores/elicitationStore.ts";
import { useSettingsStore } from "../stores/settingsStore.ts";
import { useWorkbenchUiStore } from "../stores/workbenchUiStore.ts";
import { Listbox, btnSecondary } from "./controls.tsx";
import { QuestionChoices, QuestionPanel } from "./session/QuestionPanel.tsx";

function FormCard({ item }: { item: PendingForm }) {
  const edit = useElicitationStore((s) => s.edit);
  const answer = useElicitationStore((s) => s.answer);
  const progress = useElicitationStore((s) => s.progress);
  const auto = useSettingsStore((s) => s.autoAnswerQuestions);
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
    const latest = useElicitationStore
      .getState()
      .pending.find((entry) => entry.id === item.id);
    if (!latest || latest.stale) return;
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
    if (!Object.keys(invalid).length) answer(item.id, "accept");
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
      onClose={() => answer(item.id, "cancel")}
      onAuto={
        auto &&
        selectionOnly &&
        !Object.keys(validateForm(item.form, automatic).errors).length
          ? () => {
              const current = useElicitationStore
                .getState()
                .pending.find((entry) => entry.id === item.id);
              if (!current || current.stale || current.interacted) return;
              edit(item.id, automatic);
              answer(item.id, "accept");
            }
          : undefined
      }
    >
      {field && key && (
        <>
          {options ? (
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
          {errors[key] && (
            <p className="text-ui-caption text-warn-ink">{errors[key]}</p>
          )}
        </>
      )}
    </QuestionPanel>
  );
}

function FormQueue({ items }: { items: PendingForm[] }) {
  const selected = useElicitationStore((s) => s.activeId);
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
          onChange={(activeId) => useElicitationStore.setState({ activeId })}
        />
      )}
      <FormCard key={item.id} item={item} />
    </div>
  );
}
export function ElicitationDock() {
  const pending = useElicitationStore((s) => s.pending);
  const owner = useElicitationStore((s) => s.activeOwner);
  const overlay = useWorkbenchUiStore((s) => s.overlay);
  if (overlay) return null;
  return (
    <FormQueue
      items={pending.filter(
        (item) => item.owner === owner && !!item.context?.sessionId,
      )}
    />
  );
}

/** Compatibility export: non-modal card, with no backdrop. */
export function ElicitationModal() {
  const pending = useElicitationStore((s) => s.pending);
  const owner = useElicitationStore((s) => s.activeOwner);
  const overlay = useWorkbenchUiStore((s) => s.overlay);
  const view = useWorkbenchUiStore((s) => s.treeView);
  const foregroundVisible = !overlay && view === "session";
  const unscoped = pending.filter((item) => !item.context?.sessionId);
  const background = pending.filter(
    (item) =>
      !!item.context?.sessionId &&
      (item.owner !== owner || !foregroundVisible) &&
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
            onClick={() => item.context?.activate()}
          >
            前往回答
          </button>
        </div>
      ))}
      <FormQueue items={unscoped} />
    </aside>
  );
}
