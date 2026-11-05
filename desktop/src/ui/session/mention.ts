/**
 * @ 提及的纯逻辑（触发检测 + 多源候选过滤），与渲染解耦便于单测。
 *
 * 触发规则：光标前的文本以 `@` 起一段不含空白的结尾（`@` 前是行首或
 * 空白/常见开括号），如 `看一下 @src/app` / `(@aaw` 。命中返回 `@` 后的
 * 查询串（可为空串 = 刚敲出 @），未命中返回 null。
 *
 * 过滤规则：先大小写不敏感的子串匹配（分隔符不敏感：`/` `\` `.` 互相
 * 等价，输入 `aaw workflow` 能命中 `aaw-workflow` 这类），子串位置越靠
 * 前越靠前；子串落空的候选再做宽松子序列匹配兜底。文件上限 8 条。
 *
 * 多源（M6）：文件 + skills 两组共用同一模糊口径；skill 项选中插入
 * 自然语言提示（chrys 无用户侧触发语法，agent 读到提示自行 load_skill）。
 */
const TRIGGER_PATTERN = /(?:^|[\s([（【{,，、])@([^\s@]*)$/;

/** 检测光标前是否处在 @ 触发段；返回查询串（可空）或 null。 */
export function detectMentionTrigger(textBeforeCaret: string): string | null {
  const match = TRIGGER_PATTERN.exec(textBeforeCaret);
  return match === null ? null : (match[1] ?? "");
}

/** 归一：路径分隔符与大小写统一，便于「写得糙也能命中」。 */
function normalize(value: string): string {
  return value.toLowerCase().replaceAll(/[\\/]+/g, "/");
}

interface Scored {
  readonly path: string;
  readonly score: number;
}

/** 过滤候选文件（fuzzy：子串优先按位置，子序列兜底）。 */
export function filterMentionFiles(
  paths: readonly string[],
  query: string,
  limit = 8,
): string[] {
  const normalizedQuery = normalize(query.trim());
  if (normalizedQuery.length === 0) {
    return paths.slice(0, limit);
  }
  const substringHits: Scored[] = [];
  const subsequenceHits: Scored[] = [];
  for (const path of paths) {
    const normalized = normalize(path);
    const position = normalized.indexOf(normalizedQuery);
    if (position !== -1) {
      substringHits.push({ path, score: position });
      continue;
    }
    if (isSubsequence(normalized, normalizedQuery)) {
      subsequenceHits.push({ path, score: Number.MAX_SAFE_INTEGER });
    }
  }
  const rank = (a: Scored, b: Scored): number =>
    a.score - b.score || a.path.localeCompare(b.path);
  return [...substringHits.sort(rank), ...subsequenceHits.sort(rank)]
    .slice(0, limit)
    .map((hit) => hit.path);
}

/** query 的字符按顺序全出现在 target 中（宽松子序列）。 */
function isSubsequence(target: string, query: string): boolean {
  let cursor = 0;
  for (const character of target) {
    if (cursor < query.length && character === query[cursor]) {
      cursor++;
    }
  }
  return cursor === query.length;
}

/** @ 候选条目（文件引用 / skill 提示两种插入语义）。 */
export interface MentionOption {
  readonly kind: "file" | "skill";
  /** 显示名：文件相对路径 / skill 名。 */
  readonly label: string;
  /** 选中后的插入文本（含尾随空格）。 */
  readonly insert: string;
}

/** skill 项的插入文本（与 slash.ts 的口径一致）。 */
export function skillMentionInsert(name: string): string {
  return `${name} `;
}

/**
 * 多源过滤：文件沿用 filterMentionFiles 口径（≤6 条），skills 同口径
 * 模糊（≤4 条）；文件组在前、skills 组在后，各自组内按命中排序。
 */
export function filterMentionOptions(
  paths: readonly string[],
  skillNames: readonly string[],
  query: string,
  invocations?: Readonly<Record<string, string>>,
): MentionOption[] {
  const files = filterMentionFiles(paths, query, 6).map(
    (path): MentionOption => ({
      kind: "file",
      label: path,
      insert: `@${path} `,
    }),
  );
  const skills = filterMentionFiles(skillNames, query, 4).map(
    (name): MentionOption => ({
      kind: "skill",
      label: name,
      insert:
        invocations?.[name] !== undefined
          ? `${invocations[name]} `
          : skillMentionInsert(name),
    }),
  );
  return [...files, ...skills];
}
