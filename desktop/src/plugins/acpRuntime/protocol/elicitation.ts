import {
  parseElicitationForm,
  type ElicitationForm,
  type FormField,
  type FormValues,
} from "../../../contracts/acp/elicitation.ts";
import { asRecord } from "../../../shared/valueGuards.ts";

export function parseRuntimeElicitationForm(
  params: Readonly<Record<string, unknown>>,
  agentId: string | undefined,
  supportsCustomAnswers = false,
): ElicitationForm | null {
  // A server request cannot grant itself permission to accept schema-external answers.
  const input = { ...params, customAnswerField: undefined };
  const form = parseElicitationForm(
    agentId === "codeagent" || supportsCustomAnswers
      ? normalizeCodeAgentForm(input)
      : input,
  );
  if (!supportsCustomAnswers || !form || form.customAnswerField) return form;
  const fields = Object.entries(form.requestedSchema.properties);
  const choice = fields[0];
  if (fields.length !== 1 || !choice || choice[1].type !== "string") return form;
  return fieldOptions(choice[1])?.length
    ? { ...form, customAnswerField: choice[0] }
    : form;
}

/** CodeAgent presents question text in the field description and option descriptions in titles. */
function normalizeCodeAgentForm(
  params: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if ("url" in params) return params;
  const schema = asRecord(params.requestedSchema);
  if (!schema) return params;
  const form = params.mode === undefined ? { ...params, mode: "form" } : params;
  if (params.mode !== undefined && params.mode !== "form") return form;
  const properties = asRecord(schema.properties);
  const field = asRecord(properties?.field);
  if (
    Object.keys(properties ?? {}).length !== 1 ||
    field?.type !== "string" ||
    (field.title !== undefined &&
      !(
        typeof field.title === "string" && /^field$/i.test(field.title.trim())
      )) ||
    typeof field.description !== "string" ||
    !field.description.trim() ||
    !Array.isArray(field.oneOf) ||
    typeof params.message !== "string" ||
    !/^answer questions\??$/i.test(params.message.trim())
  )
    return form;
  const options = field.oneOf as unknown[];
  if (
    !options.length ||
    !options.every((value) => {
      const option = asRecord(value);
      return (
        option &&
        typeof option.const === "string" &&
        typeof option.title === "string"
      );
    })
  )
    return form;
  return {
    ...form,
    customAnswerField: "field",
    message: "",
    requestedSchema: {
      ...schema,
      properties: {
        ...properties,
        field: {
          ...field,
          title: field.description,
          description: undefined,
          oneOf: options.map((value) => {
            const option = asRecord(value)!;
            return {
              ...option,
              description: option.title,
              title: option.const,
            };
          }),
        },
      },
    },
  };
}

export function fieldOptions(
  field: FormField,
): { value: string; label: string; description?: string }[] | null {
  const source = field.type === "array" ? field.items : field;
  if (!source) return null;
  const titled =
    "oneOf" in source
      ? source.oneOf
      : "anyOf" in source
        ? source.anyOf
        : undefined;
  if (titled)
    return titled.map((v) => ({
      value: v.const,
      label: v.title ?? v.const,
      ...("description" in v && typeof v.description === "string"
        ? { description: v.description }
        : {}),
    }));
  return source.enum?.map((value) => ({ value, label: value })) ?? null;
}

/** Stored with the form draft and excluded from the wire response. */
export const customAnswerDraftKey = "__aaw_custom_answer";

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
    let value = Object.hasOwn(values, key) ? values[key] : undefined;
    const custom =
      form.customAnswerField === key &&
      Object.keys(form.requestedSchema.properties).length === 1 &&
      field.type === "string" &&
      fieldOptions(field) !== null;
    if (custom) {
      const selected = typeof value === "string" ? value.trim() : "";
      const draft = values[customAnswerDraftKey];
      const note = typeof draft === "string" ? draft.trim() : "";
      const options = fieldOptions(field) ?? [];
      if (selected && !options.some((option) => option.value === selected)) {
        errors[key] = "请选择有效选项";
        continue;
      }
      value =
        selected && note
          ? selected + "\n补充说明：" + note
          : selected || note || undefined;
    }
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
        if (choices && !custom)
          valid &&= choices.some((c) => c.value === value);
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
