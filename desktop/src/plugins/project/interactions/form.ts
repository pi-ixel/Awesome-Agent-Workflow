import type { ElicitationForm, FormField, FormValues } from "../../../contracts/acp/elicitation.ts";

export interface PendingForm {
  readonly id: string;
  readonly owner: object;
  readonly label: string;
  readonly form: ElicitationForm;
  readonly values: FormValues;
  readonly stale: boolean;
  readonly page: number;
  readonly interacted: boolean;
  readonly context?: {
    readonly workspacePath: string;
    readonly sessionId: string | null;
    readonly activate: () => void;
  };
}

export interface ProjectFormState {
  readonly pending: readonly PendingForm[];
  readonly activeOwner: object | null;
  readonly activeId: string | null;
  readonly select: (id: string) => void;
  readonly progress: (id: string, patch: { page?: number; interacted?: boolean }) => void;
  readonly edit: (id: string, values: FormValues) => void;
}

export interface FormViewItem
  extends Omit<PendingForm, "owner" | "context"> {
  readonly isForeground: boolean;
  readonly sessionId: string | null;
}

export interface FormViewState {
  readonly pending: readonly FormViewItem[];
  readonly activeId: string | null;
}

export function fieldOptions(
  field: FormField,
): { value: string; label: string }[] | null {
  const source = field.type === "array" ? field.items : field;
  if (!source) return null;
  const titled =
    "oneOf" in source
      ? source.oneOf
      : "anyOf" in source
        ? source.anyOf
        : undefined;
  if (titled)
    return titled.map((v) => ({ value: v.const, label: v.title ?? v.const }));
  return source.enum?.map((value) => ({ value, label: value })) ?? null;
}

export function formDefaults(form: ElicitationForm): FormValues {
  return Object.fromEntries(
    Object.entries(form.requestedSchema.properties)
      .filter(([, f]) => f.default != null)
      .map(([k, f]) => [k, f.default!]),
  );
}

/** Validate again at submission: UI controls alone are not a protocol boundary. */
export function validateForm(
  form: ElicitationForm,
  values: FormValues,
): { content: FormValues; errors: Record<string, string> } {
  const content: FormValues = Object.create(null) as FormValues;
  const errors: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const [key, field] of Object.entries(form.requestedSchema.properties)) {
    const value = Object.hasOwn(values, key) ? values[key] : undefined;
    const required = form.requestedSchema.required?.includes(key) ?? false;
    if (
      !["string", "number", "integer", "boolean", "array"].includes(field.type)
    ) {
      errors[key] = "暂不支持此字段类型，请拒绝或取消表单";
      continue;
    }
    if (value === undefined || (field.type !== "string" && value === "")) {
      if (required) errors[key] = "请填写此项";
      continue;
    }
    let valid: boolean;
    const choices = fieldOptions(field);
    if (field.type === "string") {
      valid = typeof value === "string";
      if (typeof value === "string") {
        const length = [...value].length;
        valid &&=
          (field.minLength == null || length >= field.minLength) &&
          (field.maxLength == null || length <= field.maxLength);
        if (field.pattern) {
          try {
            valid &&= new RegExp(field.pattern, "u").test(value);
          } catch {
            valid = false;
          }
        }
        if (field.format === "email")
          valid &&= /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
        if (field.format === "uri") {
          try {
            new URL(value);
          } catch {
            valid = false;
          }
        }
        if (field.format === "date")
          valid &&=
            /^\d{4}-\d{2}-\d{2}$/.test(value) &&
            Number.isFinite(Date.parse(value)) &&
            new Date(value).toISOString().slice(0, 10) === value;
        if (field.format === "date-time")
          valid &&=
            /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(value) &&
            Number.isFinite(Date.parse(value));
        if (choices) valid &&= choices.some((c) => c.value === value);
      }
    } else if (field.type === "number" || field.type === "integer") {
      const numeric =
        typeof value === "string" && value.trim() !== ""
          ? Number(value)
          : value;
      valid =
        typeof numeric === "number" &&
        Number.isFinite(numeric) &&
        (field.type !== "integer" || Number.isSafeInteger(numeric)) &&
        (field.minimum == null || numeric >= field.minimum) &&
        (field.maximum == null || numeric <= field.maximum);
      if (valid) content[key] = numeric;
    } else if (field.type === "boolean") valid = typeof value === "boolean";
    else
      valid =
        Array.isArray(value) &&
        choices !== null &&
        value.every((v) => choices.some((c) => c.value === v)) &&
        new Set(value).size === value.length &&
        (field.minItems == null || value.length >= field.minItems) &&
        (field.maxItems == null || value.length <= field.maxItems);
    if (!valid) errors[key] = "输入不符合字段要求";
    else if (!Object.hasOwn(content, key)) content[key] = value;
  }
  for (const key of form.requestedSchema.required ?? [])
    if (!Object.hasOwn(form.requestedSchema.properties, key))
      errors[key] = "表单缺少必填字段定义";
  return { content, errors };
}
