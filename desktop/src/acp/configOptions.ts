import { asRecord, asString } from "./parse.ts";
import type { ModelInfo } from "./types.ts";

/** ACP v1 select configuration. Unknown option types remain unsupported. */
export interface SessionConfigOption {
  readonly id: string;
  readonly name: string;
  readonly category: string | null;
  readonly currentValue: string;
  readonly options: readonly {
    value: string;
    name: string;
    description?: string;
  }[];
}

export function parseConfigOptions(
  raw: unknown,
): readonly SessionConfigOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    const entry = asRecord(value);
    if (!entry || entry.type !== "select") return [];
    const id = asString(entry.id),
      name = asString(entry.name),
      currentValue = asString(entry.currentValue);
    if (!id || !name || currentValue === null || !Array.isArray(entry.options))
      return [];
    const flat = entry.options.flatMap((item: unknown) => {
      const group = asRecord(item);
      return group && Array.isArray(group.options)
        ? (group.options as unknown[])
        : [item];
    });
    const options = flat.flatMap((item: unknown) => {
      const option = asRecord(item);
      const value = option && asString(option.value),
        label = option && asString(option.name);
      return value && label
        ? [
            {
              value,
              name: label,
              ...(typeof option?.description === "string"
                ? { description: option.description }
                : {}),
            },
          ]
        : [];
    });
    return [
      { id, name, currentValue, category: asString(entry.category), options },
    ];
  });
}

export function configModels(config: readonly SessionConfigOption[]): {
  currentModelId: string;
  availableModels: readonly ModelInfo[];
} | null {
  const model = config.find((option) => option.category === "model");
  return model
    ? {
        currentModelId: model.currentValue,
        availableModels: model.options.map((option) => ({
          modelId: option.value,
          name: option.name,
          description: option.description,
        })),
      }
    : null;
}

export function configModes(config: readonly SessionConfigOption[]) {
  const mode = config.find((option) => option.category === "mode");
  return mode
    ? {
        currentModeId: mode.currentValue,
        availableModes: mode.options.map((option) => ({
          id: option.value,
          name: option.name,
          description: option.description,
        })),
      }
    : null;
}
