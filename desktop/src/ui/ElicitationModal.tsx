import {
  fieldOptions,
  validateForm,
  type FormValue,
} from "../acp/elicitation.ts";
import { useElicitationStore } from "../stores/elicitationStore.ts";
import { btnPrimary, btnSecondary } from "./controls";

export function ElicitationModal() {
  const pending = useElicitationStore((s) => s.pending);
  const edit = useElicitationStore((s) => s.edit);
  const answer = useElicitationStore((s) => s.answer);
  const item = pending.find((v) => !v.stale) ?? pending[0];
  if (!item) return null;
  if (item.stale)
    return (
      <aside
        role="status"
        className="fixed bottom-4 right-4 z-40 max-w-sm rounded-lg border border-line bg-surface p-3 text-sm shadow-lg"
      >
        表单请求已结束，草稿已保留，等待重新绑定。
        <button
          className={btnSecondary}
          onClick={() => answer(item.id, "cancel")}
        >
          丢弃草稿
        </button>
      </aside>
    );
  const { errors } = validateForm(item.form, item.values);
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          answer(item.id, "cancel");
        }
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Agent 表单"
        className="max-h-[85vh] w-full max-w-lg overflow-auto rounded-xl border border-line bg-surface p-5 text-sm shadow-xl"
      >
        <div className="mb-2 text-xs text-muted">
          {item.label} · 表单
          {pending.length > 1 ? ` · ${pending.length} 项待处理` : ""}
        </div>
        <h2 className="font-semibold">
          {item.form.requestedSchema.title ?? "需要你的输入"}
        </h2>
        <p className="my-3 whitespace-pre-wrap">{item.form.message}</p>
        {item.form.requestedSchema.description && (
          <p className="mb-3 text-muted">
            {item.form.requestedSchema.description}
          </p>
        )}
        {item.stale && (
          <p role="status" className="mb-3 text-amber-600">
            连接或请求已结束。草稿已保留，等待 Agent 重新发起匹配的表单。
          </p>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            answer(item.id, "accept");
          }}
        >
          <fieldset disabled={item.stale} className="space-y-4">
            {Object.entries(item.form.requestedSchema.properties).map(
              ([key, field]) => {
                const id = `${item.id}-${key}`;
                const value = item.values[key];
                const choices = fieldOptions(field);
                const change = (v: FormValue) =>
                  edit(item.id, { ...item.values, [key]: v });
                const classes =
                  "mt-1 w-full rounded-md border border-line-strong bg-surface px-3 py-2";
                return (
                  <div key={key}>
                    <label htmlFor={id} className="font-medium">
                      {field.title ?? key}
                      {item.form.requestedSchema.required?.includes(key)
                        ? " *"
                        : ""}
                    </label>
                    {field.description && (
                      <p className="mt-1 text-xs text-muted">
                        {field.description}
                      </p>
                    )}
                    {field.type === "boolean" ? (
                      <select
                        id={id}
                        className={classes}
                        value={value === undefined ? "" : String(value)}
                        onChange={(e) => {
                          const next = { ...item.values };
                          if (e.target.value === "") delete next[key];
                          else next[key] = e.target.value === "true";
                          edit(item.id, next);
                        }}
                      >
                        <option value="">请选择</option>
                        <option value="true">是</option>
                        <option value="false">否</option>
                      </select>
                    ) : field.type === "array" && choices ? (
                      <div id={id} className="mt-2 space-y-2">
                        {choices.map((choice) => (
                          <label
                            key={choice.value}
                            className="flex items-center gap-2"
                          >
                            <input
                              type="checkbox"
                              checked={
                                Array.isArray(value) &&
                                value.includes(choice.value)
                              }
                              onChange={(e) =>
                                change(
                                  e.target.checked
                                    ? [
                                        ...(Array.isArray(value) ? value : []),
                                        choice.value,
                                      ]
                                    : (Array.isArray(value)
                                        ? value
                                        : []
                                      ).filter((v) => v !== choice.value),
                                )
                              }
                            />
                            {choice.label}
                          </label>
                        ))}
                      </div>
                    ) : field.type === "string" && choices ? (
                      <select
                        id={id}
                        className={classes}
                        value={typeof value === "string" ? value : ""}
                        onChange={(e) => change(e.target.value)}
                      >
                        <option value="" disabled>
                          请选择
                        </option>
                        {choices.map((c) => (
                          <option key={c.value} value={c.value}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    ) : ["string", "number", "integer"].includes(field.type) ? (
                      <input
                        id={id}
                        className={classes}
                        type={field.type === "string" ? "text" : "number"}
                        step={field.type === "integer" ? "1" : "any"}
                        value={
                          typeof value === "string" || typeof value === "number"
                            ? value
                            : ""
                        }
                        onChange={(e) => change(e.target.value)}
                      />
                    ) : (
                      <p className="text-amber-600">暂不支持此字段类型</p>
                    )}
                    {errors[key] && (
                      <p className="mt-1 text-xs text-amber-600">
                        {errors[key]}
                      </p>
                    )}
                  </div>
                );
              },
            )}
          </fieldset>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              className={btnSecondary}
              onClick={() => answer(item.id, "cancel")}
            >
              {item.stale ? "丢弃草稿" : "取消"}
            </button>
            <button
              type="button"
              className={btnSecondary}
              disabled={item.stale}
              onClick={() => answer(item.id, "decline")}
            >
              拒绝
            </button>
            <button
              type="submit"
              className={btnPrimary}
              disabled={item.stale || Object.keys(errors).length > 0}
            >
              提交
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
