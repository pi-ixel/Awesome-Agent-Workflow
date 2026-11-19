import type { ToolPackage, ToolSetting, ToolSettings, ToolSettingValue } from "../types.ts";

function validValue(field: ToolSetting, value: unknown): value is ToolSettingValue {
  switch (field.type) {
    case "text": return typeof value === "string" && value.length <= 4096;
    case "boolean": return typeof value === "boolean";
    case "number": return typeof value === "number" && Number.isFinite(value)
      && (field.min === undefined || value >= field.min) && (field.max === undefined || value <= field.max);
    case "select": return field.options.some((option) => option.value === value);
  }
}

export function readSettingsSchema(value: unknown): readonly ToolSetting[] | undefined {
  if (!Array.isArray(value) || value.length > 32) return undefined;
  const ids = new Set<string>();
  const fields: ToolSetting[] = [];
  for (const item of value as unknown[]) {
    if (!item || typeof item !== "object") return undefined;
    const field = item as ToolSetting;
    if (typeof field.id !== "string" || !/^[a-z][a-z0-9.-]{0,63}$/.test(field.id) || ids.has(field.id)
      || typeof field.label !== "string" || !field.label.trim() || field.label.length > 80
      || (field.description !== undefined && (typeof field.description !== "string" || field.description.length > 300))) return undefined;
    if (!["text", "number", "boolean", "select"].includes(field.type)) return undefined;
    if (field.type === "number" && ((field.min !== undefined && !Number.isFinite(field.min))
      || (field.max !== undefined && !Number.isFinite(field.max)))) return undefined;
    if (field.type === "select" && (!Array.isArray(field.options) || !field.options.length || field.options.length > 32
      || field.options.some((option: { label: string; value: string }) => !option || typeof option.label !== "string" || !option.label.trim() || option.label.length > 80
        || typeof option.value !== "string" || option.value.length > 200)
      || new Set(field.options.map((option: { value: string }) => option.value)).size !== field.options.length)) return undefined;
    if (!validValue(field, field.default)) return undefined;
    ids.add(field.id);
    fields.push(field);
  }
  return fields;
}

/** Old values survive updates only while valid under the current schema. */
export function resolveToolSettings(tool: ToolPackage, values: unknown = {}): ToolSettings {
  const record = values && typeof values === "object" ? values as Record<string, unknown> : {};
  return Object.fromEntries((tool.settingsSchema ?? []).map((field) => {
    const candidate = Object.hasOwn(record, field.id) ? record[field.id] : undefined;
    return [field.id, validValue(field, candidate) ? candidate : field.default];
  }));
}

export function validateToolSettings(tool: ToolPackage, values: ToolSettings): ToolSettings {
  for (const field of tool.settingsSchema ?? []) {
    if (!Object.hasOwn(values, field.id) || !validValue(field, values[field.id])) throw new Error(`请检查「${field.label}」的值。`);
  }
  return resolveToolSettings(tool, values);
}

export function toolSettingsScript(tool: ToolPackage, values?: unknown): string {
  const json = JSON.stringify(resolveToolSettings(tool, values)).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return `<script>Object.defineProperty(window, 'aawSettings', { value: Object.freeze(${json}), writable: false, configurable: false });</script>`;
}
