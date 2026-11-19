import { isAbsolutePath, pathKey } from "../../../shared/panelPaths.ts";

export interface SkillReference {
  readonly name: string;
  readonly path?: string;
  readonly command: string;
}

export interface PromptSkillReference extends SkillReference {
  readonly offset: number;
}

export function skillReferenceKey(reference: SkillReference): string {
  return reference.path
    ? pathKey(reference.path)
    : reference.command.toLowerCase();
}

// 草稿内保留引用身份，发送时由输入框转成 Agent 的斜杠命令。
const referencePrefix = "\0aaw-skill-reference.v1:";

function parseSkillReference(value: unknown): SkillReference | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !value.name ||
    !("command" in value) ||
    typeof value.command !== "string" ||
    !value.command ||
    ("path" in value &&
      (typeof value.path !== "string" ||
        !isAbsolutePath(value.path) ||
        !/[\\/]SKILL\.md$/i.test(value.path)))
  )
    return null;
  return {
    name: value.name,
    command: value.command,
    ...("path" in value && typeof value.path === "string"
      ? { path: value.path }
      : {}),
  };
}

export function skillPrompt(
  text: string,
  references: readonly SkillReference[],
) {
  const commands = new Set<string>();
  const marks: PromptSkillReference[] = [];
  let prefix = "";
  for (const reference of references) {
    if (commands.has(reference.command)) continue;
    commands.add(reference.command);
    marks.push({ ...reference, offset: prefix.length });
    prefix += `/${reference.command} `;
  }
  return { text: (prefix + text.trim()).trimEnd(), skillReferences: marks };
}

/** 快照和队列只恢复能与对应正文精确核对的引用。 */
export function readPromptSkillReferences(
  raw: unknown,
  text: string,
): PromptSkillReference[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const references: PromptSkillReference[] = [];
  let end = 0;
  for (const value of raw as unknown[]) {
    const reference = parseSkillReference(value);
    if (
      !reference ||
      !value ||
      typeof value !== "object" ||
      !("offset" in value)
    )
      continue;
    const offset = value.offset;
    if (
      typeof offset !== "number" ||
      !Number.isSafeInteger(offset) ||
      offset < end
    )
      continue;
    const command = `/${reference.command}`;
    const next = offset + command.length;
    if (
      !text.startsWith(command, offset) ||
      (next < text.length && !/\s/.test(text[next]!))
    )
      continue;
    references.push({ ...reference, offset });
    end = next;
  }
  return references.length ? references : undefined;
}

export function appendPromptSkillReferences(
  first: readonly PromptSkillReference[] | undefined,
  second: readonly PromptSkillReference[] | undefined,
  offset: number,
): readonly PromptSkillReference[] | undefined {
  if (!second?.length) return first;
  return [
    ...(first ?? []),
    ...second.map((reference) => ({
      ...reference,
      offset: reference.offset + offset,
    })),
  ];
}

export function promptWithEditableSkills(
  text: string,
  references: readonly PromptSkillReference[] | undefined,
): string {
  if (!references?.length) return text;
  let start = 0;
  const rest: string[] = [];
  for (const reference of references) {
    rest.push(text.slice(start, reference.offset));
    start = reference.offset + reference.command.length + 1;
    if (text[start] === " ") start++;
  }
  rest.push(text.slice(start));
  return withSkillReferences(
    rest.join(""),
    references.map(({ name, command, path }) => ({ name, command, path })),
  );
}

export function withSkillReferences(
  text: string,
  references: readonly SkillReference[],
): string {
  if (!references.length) return text;
  const header = references
    .map((reference) => referencePrefix + JSON.stringify(reference))
    .join("\n");
  return text ? header + "\n\n" + text : header;
}

export function readSkillReferences(draft: string): {
  text: string;
  references: readonly SkillReference[];
} {
  if (!draft.includes(referencePrefix)) return { text: draft, references: [] };
  const references = new Map<string, SkillReference>();
  const parts: string[] = [];
  let afterReference = false;
  for (const line of draft.split("\n")) {
    let value: unknown;
    if (line.startsWith(referencePrefix)) {
      try {
        value = JSON.parse(line.slice(referencePrefix.length));
      } catch {
        /* 保留普通输入 */
      }
    }
    const reference = parseSkillReference(value);
    if (reference) {
      references.set(skillReferenceKey(reference), reference);
      afterReference = true;
      continue;
    }
    if (line !== "" || !afterReference) parts.push(line);
    afterReference = false;
  }
  return { text: parts.join("\n"), references: [...references.values()] };
}
