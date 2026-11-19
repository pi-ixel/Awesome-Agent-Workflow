import type { ToolAction, ToolBackground, ToolPackage, ToolPermissions, ToolRequires, ToolViolation } from "../types.ts";
import { readSettingsSchema } from "./settings.ts";
import { readSourceFiles, safeSourcePath } from "./sourceFiles.ts";
/**
 * 运行时（`tools-runtime/runtime.mjs`）也从 `package-contract.mjs` 取这个函数。
 *
 * `readNetworkRule` 的定义在顶层 `types.ts`，而 `package.ts` 是本文件的入口，
 * esbuild 只按这里的导出产 bundle——少了这一行，产物里就没有这个导出，
 * `runtime.mjs` 的顶层 import 会在加载阶段直接抛
 * `does not provide an export named 'readNetworkRule'`，表现是工具窗口一片空白、
 * 标题变成 "Error"，日志里什么都没有。改动这里时务必同步检查
 * `runtime.mjs` / `cli.mjs` 从 `package-contract.mjs` 引用的每一个名字。
 */
export { readNetworkRule } from "../types.ts";
export { resolveToolSettings, toolSettingsScript } from "./settings.ts";
export {
  capabilitiesAt,
  capabilityEntries,
  readCapability,
  toolCapabilities,
  toolContractVersion,
} from "./contract.ts";
export { checkCompatibility, currentHostContract, explainIncompatibility } from "./compat.ts";

/**
 * 账号标识转成目录段：只留安全字符，其余换成下划线。
 *
 * 这是**单一真源**：`runtime/project.ts` 用它算源码/运行副本的落点，
 * `tools-runtime/tool-storage.mjs` 通过构建产物 `package-contract.mjs` 拿同一个函数
 * 算 `aawStore` 的落点。以前两边各写一份、靠注释提醒"改一边要改另一边"，结果
 * 一边改了另一边没跟上——现象是工具数据在 `<账号>/` 里、源码在 `anonymous/` 里，
 * 用户以为东西丢了。
 *
 * SSO 的 user id 可能带 `@ / :`（Windows 非法）或 `..`（路径穿越），所以要规整。
 * 读不到账号时**抛错，不返回 `anonymous`**：静默写进一个用户永远看不到的目录
 * 比直接报错糟得多——前者的数据找不回来，后者至少当场就知道该先登录。
 */
export function toolOwnerSegment(userId: string | undefined): string {
  if (typeof userId !== "string" || !userId.trim())
    throw new Error("工具需要有效的账号才能确定存储位置，请先登录 AAW。");
  const cleaned = userId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[._]+|\.+$/g, "");
  if (!cleaned) throw new Error("账号标识无法转换成安全的目录名，请联系管理员。");
  return cleaned;
}

/** 域名校验：允许 `*.corp.example.com` 与 `host:port`，挡住会污染 CSP 的字符。 */
const hostPattern = /^(\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/i;

/**
 * 清单（含 html 快照）的体积上限。
 *
 * 从 512 KB 抬到 4 MB：工具开始能带 `node_modules` 之后，`index.html` 常常是
 * 构建产物（Vite 打出的单文件通常几百 KB 到 2 MB）。真正的重货（`node_modules`、
 * 图片、wasm）不进清单，它们躺在工具目录里，所以这个上限不必开到几十 MB——
 * 清单仍然要塞进 `preferences.json`，开太大等于让启动器每次唤起都读一个大文件。
 */
export const toolPackageLimit = 4 * 1024 * 1024;
export const toolIdPattern = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const settingIdPattern = /^[a-z][a-z0-9.-]{0,63}$/;

/** 字形最多 2 个码位（一个 emoji 或两个字母），且不允许控制字符。 */
export function readToolIcon(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const icon = value.trim();
  if (!icon || [...icon].length > 2) return undefined;
  for (const character of icon) {
    if ((character.codePointAt(0) ?? 0) < 0x20) return undefined;
  }
  return icon;
}

/**
 * 清单校验失败时的错误：除了给用户看的首条消息，还带着完整的问题列表。
 *
 * 之所以要列表：以前任何字段写错都只有一句"工具包需要有效的 schemaVersion、
 * id、name…"，用户和 AI 都只能逐字段猜。现在每条问题自带 `hint`，AI 能照着改。
 */
export class ToolPackageError extends Error {
  readonly violations: readonly ToolViolation[];
  constructor(violations: readonly ToolViolation[]) {
    super(violations[0]?.message ?? "工具包无效。");
    this.name = "ToolPackageError";
    this.violations = violations;
  }
}

function fail(
  ruleId: string,
  message: string,
  hint: string,
  where?: string,
  level: ToolViolation["level"] = "block",
): ToolViolation {
  return { ruleId, level, ...(where === undefined ? {} : { where }), message, hint };
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** 把校验过的 permissions 归一化成可存储的形状（丢掉无效项，不保留脏数据）。 */
function normalizePermissions(value: unknown): ToolPermissions | undefined {
  const record = objectOf(value);
  const network = record?.network;
  if (network === undefined) return undefined;
  if (typeof network === "boolean") return { network };
  const asObject = objectOf(network);
  if (!asObject) return undefined;
  const hosts = Array.isArray(asObject.hosts)
    ? asObject.hosts.filter((item): item is string => typeof item === "string")
    : [];
  return {
    network: {
      ...(hosts.length ? { hosts } : {}),
      ...(asObject.insecure === true ? { insecure: true } : {}),
    },
  };
}

function normalizeRequires(value: unknown): ToolRequires | undefined {
  const record = objectOf(value);
  if (!record) return undefined;
  const capabilities = Array.isArray(record.capabilities)
    ? record.capabilities.filter((item): item is string => typeof item === "string")
    : [];
  const normalized: ToolRequires = {
    ...(typeof record.contract === "number" ? { contract: record.contract } : {}),
    ...(capabilities.length ? { capabilities } : {}),
  };
  return Object.keys(normalized).length ? normalized : undefined;
}

function normalizeBackground(value: unknown): ToolBackground | undefined {
  const record = objectOf(value);
  if (!record) return undefined;
  const normalized: ToolBackground = {
    ...(typeof record.reason === "string" && record.reason.trim() ? { reason: record.reason.trim() } : {}),
    ...(record.schedule === true ? { schedule: true as const } : {}),
  };
  return Object.keys(normalized).length ? normalized : undefined;
}

function checkSetting(item: unknown, index: number, seen: Set<string>): ToolViolation[] {
  const where = `settingsSchema[${index}]`;
  const field = objectOf(item);
  if (!field) return [fail("FIELD", `${where} 必须是对象。`, "每项设置写成 { id, label, type, default }。", where)];
  const problems: ToolViolation[] = [];
  if (typeof field.id !== "string" || !settingIdPattern.test(field.id))
    problems.push(fail("FIELD", `${where}.id 必须是小写字母开头的标识符（可含数字、点、短横）。`, "例如 \"indent\"、\"max.rows\"。", `${where}.id`));
  else if (seen.has(field.id))
    problems.push(fail("FIELD", `${where}.id 与前面重复：${field.id}。`, "同一份清单里设置 id 必须唯一。", `${where}.id`));
  else seen.add(field.id);
  if (typeof field.label !== "string" || !field.label.trim() || field.label.length > 80)
    problems.push(fail("FIELD", `${where}.label 必填，且不超过 80 字。`, "写用户能看懂的字段名，例如「缩进空格数」。", `${where}.label`));
  if (field.description !== undefined && (typeof field.description !== "string" || field.description.length > 300))
    problems.push(fail("FIELD", `${where}.description 不超过 300 字。`, "可省略；写这一项是做什么的。", `${where}.description`));
  const type = field.type;
  if (type !== "text" && type !== "number" && type !== "boolean" && type !== "select") {
    problems.push(fail("FIELD", `${where}.type 只能是 text、number、boolean、select。`, `把 type 改成这四种之一；现在是 ${JSON.stringify(type)}。`, `${where}.type`));
    return problems;
  }
  if (type === "text" && (typeof field.default !== "string" || field.default.length > 4096))
    problems.push(fail("FIELD", `${where}.default 必须是字符串（不超过 4096 字）。`, "例如 \"\" 或 \"默认值\"。", `${where}.default`));
  if (type === "boolean" && typeof field.default !== "boolean")
    problems.push(fail("FIELD", `${where}.default 必须是 true 或 false。`, "写 true 或 false，不要写 \"true\"。", `${where}.default`));
  if (type === "number") {
    const min = field.min;
    const max = field.max;
    if (min !== undefined && !Number.isFinite(min))
      problems.push(fail("FIELD", `${where}.min 必须是数字。`, "省略 min 或写一个数字。", `${where}.min`));
    if (max !== undefined && !Number.isFinite(max))
      problems.push(fail("FIELD", `${where}.max 必须是数字。`, "省略 max 或写一个数字。", `${where}.max`));
    if (typeof field.default !== "number" || !Number.isFinite(field.default))
      problems.push(fail("FIELD", `${where}.default 必须是数字。`, "例如 2，不要写 \"2\"。", `${where}.default`));
    else if ((typeof min === "number" && Number.isFinite(min) && field.default < min)
      || (typeof max === "number" && Number.isFinite(max) && field.default > max))
      problems.push(fail("FIELD", `${where}.default 不在 min–max 区间内。`, "让默认值落在 [min, max] 之间，或放宽区间。", `${where}.default`));
  }
  if (type === "select") {
    const options = Array.isArray(field.options) ? field.options : undefined;
    if (!options || !options.length || options.length > 32)
      problems.push(fail("FIELD", `${where}.options 必须是 1–32 项的数组。`, "select 类型要给出可选项列表。", `${where}.options`));
    else {
      const values = new Set<string>();
      options.forEach((option, optionIndex) => {
        const entry = objectOf(option);
        if (!entry || typeof entry.label !== "string" || !entry.label.trim() || entry.label.length > 80
          || typeof entry.value !== "string" || entry.value.length > 200)
          problems.push(fail("FIELD", `${where}.options[${optionIndex}] 需要 { label, value } 两个字符串字段。`, "label 给用户看，value 给代码用。", `${where}.options[${optionIndex}]`));
        else if (values.has(entry.value))
          problems.push(fail("FIELD", `${where}.options[${optionIndex}].value 重复：${entry.value}。`, "同一个 select 里 value 必须唯一。", `${where}.options[${optionIndex}]`));
        else values.add(entry.value);
      });
      if (typeof field.default !== "string" || (values.size && !values.has(field.default)))
        problems.push(fail("FIELD", `${where}.default 必须是 options 里某个 value。`, "把默认值改成选项之一，例如 \"first\"。", `${where}.default`));
    }
  }
  return problems;
}

function checkAction(item: unknown, index: number, seen: Set<string>): ToolViolation[] {
  const where = `actions[${index}]`;
  const action = objectOf(item);
  if (!action) return [fail("FIELD", `${where} 必须是对象。`, "每项动作写成 { id, description, inputSchema }。", where)];
  const problems: ToolViolation[] = [];
  if (typeof action.id !== "string" || !toolIdPattern.test(action.id))
    problems.push(fail("FIELD", `${where}.id 必须是小写字母或数字开头，可含点与短横。`, "例如 \"format\"、\"export.csv\"。", `${where}.id`));
  else if (seen.has(action.id))
    problems.push(fail("FIELD", `${where}.id 与前面重复：${action.id}。`, "动作 id 必须唯一。", `${where}.id`));
  else seen.add(action.id);
  if (typeof action.description !== "string" || !action.description.trim() || action.description.length > 300)
    problems.push(fail("FIELD", `${where}.description 必填，且不超过 300 字。`, "一句话说明这个动作做什么，AI 靠它决定什么时候调用。", `${where}.description`));
  if (!objectOf(action.inputSchema))
    problems.push(fail("FIELD", `${where}.inputSchema 必须是 JSON Schema 对象。`, "最小可写 { \"type\": \"object\", \"properties\": {} }。", `${where}.inputSchema`));
  return problems;
}

export type ToolValidation =
  | { readonly ok: true; readonly tool: ToolPackage }
  | { readonly ok: false; readonly violations: readonly ToolViolation[] };

/**
 * 校验一份清单值。返回结构化的字段级问题，而不是布尔。
 *
 * 与 `readToolPackage` 的区别只在报告方式：这里把"哪里错了、怎么改"一起给出，
 * 供安装前提示与会话回灌共用。
 */
export function validateToolPackage(value: unknown): ToolValidation {
  const tool = objectOf(value);
  if (!tool) return { ok: false, violations: [fail("FIELD", "工具包必须是一个 JSON 对象。", "把整份清单包在 { } 里。")] };
  const problems: ToolViolation[] = [];

  if (tool.schemaVersion !== 1)
    problems.push(fail("FIELD", `schemaVersion 必须是数字 1，现在是 ${JSON.stringify(tool.schemaVersion)}。`, "写 \"schemaVersion\": 1（数字，不是字符串）。", "schemaVersion"));
  if (typeof tool.id !== "string" || !toolIdPattern.test(tool.id))
    problems.push(fail("FIELD", "id 必填：小写字母或数字开头，可含点与短横，最长 64。", "例如 \"json-formatter\"、\"team.report\"。", "id"));
  if (typeof tool.name !== "string" || !tool.name.trim() || tool.name.trim().length > 60)
    problems.push(fail("FIELD", "name 必填，不超过 60 字。", "写用户看到的工具名，例如「JSON 格式化」。", "name"));
  if (typeof tool.version !== "string" || !/^\d+\.\d+\.\d+$/.test(tool.version) || tool.version.length > 30)
    problems.push(fail("FIELD", "version 必须是 1.0.0 这样的三段数字。", "改动后递增，例如 \"1.0.1\"。", "version"));
  if (typeof tool.html !== "string" || !tool.html.trim())
    problems.push(fail("FIELD", "html 必填：没有任何内容。", "把完整的单页 HTML（含内联 <style> 与 <script>）放进 html 字段。", "html"));

  const settingsSchema = tool.settingsSchema;
  if (settingsSchema !== undefined) {
    if (!Array.isArray(settingsSchema))
      problems.push(fail("FIELD", "settingsSchema 必须是数组。", "没有设置就省略该字段。", "settingsSchema"));
    else if (settingsSchema.length > 32)
      problems.push(fail("FIELD", `settingsSchema 最多 32 项，现在是 ${settingsSchema.length} 项。`, "合并或删掉多余设置项。", "settingsSchema"));
    else {
      const seen = new Set<string>();
      settingsSchema.forEach((item, index) => problems.push(...checkSetting(item, index, seen)));
    }
  }

  const sourceFiles = tool.sourceFiles;
  if (sourceFiles !== undefined && !readSourceFiles(sourceFiles))
    problems.push(fail("FIELD", "sourceFiles 必须是 路径 → UTF-8 文本 的对象（最多 512 个文件、合计 4 MB、路径安全）。", "路径不要以点或空格结尾，也不要出现 manifest.json / index.html；二进制文件与 node_modules 请直接放进工具目录，不要写进清单。", "sourceFiles"));

  const preload = tool.preload;
  if (preload !== undefined) {
    if (typeof preload !== "string" || !preload.trim())
      problems.push(fail("FIELD", "preload 必须是相对路径字符串，例如 \"preload.js\"。", "不需要 Node 能力就删掉这个字段。", "preload"));
    else if (!safeSourcePath(preload) || preload.toLowerCase() === "index.html" || preload.toLowerCase() === "manifest.json")
      problems.push(fail("FIELD", `preload 不是合法的工具内相对路径：${JSON.stringify(preload)}。`, "只能写工具目录内的 .js 文件，例如 \"preload.js\" 或 \"bridge/main.js\"。", "preload"));
  }

  if (tool.icon !== undefined && readToolIcon(tool.icon) === undefined) {
    const count = typeof tool.icon === "string" ? [...tool.icon.trim()].length : 0;
    problems.push(fail("FIELD", `icon 只能是 1–2 个字符（一个 emoji 或一到两个字），现在是 ${count} 个。`, "写一个 emoji 或一个汉字，例如 \"字\"；不需要就删掉这个字段。", "icon"));
  }

  // 作者与来源是可选的自由文本：只挡住"写了但是空的/超长的"，不限制格式，
  // 免得把 R5（不要内置密钥）之外又造一堆装不上的理由。
  for (const field of ["author", "source"] as const) {
    const value = tool[field];
    if (value !== undefined && (typeof value !== "string" || !value.trim() || value.length > 200))
      problems.push(fail("FIELD", `${field} 需要 1–200 字的字符串，现在是 ${JSON.stringify(value).slice(0, 20)}。`, "可省略；author 写作者或团队，source 写来源链接。", field));
  }

  const actions = tool.actions;
  let checkedActions: ToolAction[] | undefined;
  if (actions !== undefined) {
    if (!Array.isArray(actions))
      problems.push(fail("FIELD", "actions 必须是数组。", "没有动作就省略该字段（但工具至少要有一个动作，见手册 R3）。", "actions"));
    else if (actions.length > 32)
      problems.push(fail("FIELD", `actions 最多 32 个，现在是 ${actions.length} 个。`, "合并同类动作。", "actions"));
    else {
      const seen = new Set<string>();
      actions.forEach((item, index) => problems.push(...checkAction(item, index, seen)));
      if (!problems.some((problem) => problem.where?.startsWith("actions[")))
        checkedActions = actions;
    }
  }

  const permissions = tool.permissions;
  if (permissions !== undefined) {
    const record = objectOf(permissions);
    if (!record) problems.push(fail("FIELD", "permissions 必须是对象。", "例如 { \"network\": true } 或 { \"network\": { \"hosts\": [\"*.corp.example.com\"] } }。", "permissions"));
    else if (record.network !== undefined) {
      const network = record.network;
      const asObject = objectOf(network);
      if (typeof network !== "boolean" && !asObject)
        problems.push(fail("FIELD", "permissions.network 只能是 true / false，或 { hosts, insecure } 对象。", "不限域名写 true；限定域名写 { \"hosts\": [\"*.corp.example.com\"] }；不要联网写 false。", "permissions.network"));
      else if (asObject) {
        if (asObject.hosts !== undefined) {
          if (!Array.isArray(asObject.hosts) || asObject.hosts.length > 16)
            problems.push(fail("FIELD", "permissions.network.hosts 必须是 0–16 项数组。", "每个域名写成 \"api.example.com\" 或 \"*.example.com\"；不限域名就删掉 hosts。", "permissions.network.hosts"));
          else asObject.hosts.forEach((host, index) => {
            if (typeof host !== "string" || !hostPattern.test(host))
              problems.push(fail("FIELD", `permissions.network.hosts[${index}] 不是合法域名：${JSON.stringify(host)}。`, "只写域名，可带 *. 前缀与端口；不要写协议、路径或 CIDR 网段。", `permissions.network.hosts[${index}]`));
          });
        }
        if (asObject.insecure !== undefined && typeof asObject.insecure !== "boolean")
          problems.push(fail("FIELD", "permissions.network.insecure 只能是 true 或 false。", "需要访问自签证书的内网接口才写 true。", "permissions.network.insecure"));
      }
    }
  }

  const requires = tool.requires;
  if (requires !== undefined) {
    const record = objectOf(requires);
    if (!record) problems.push(fail("FIELD", "requires 必须是对象。", "例如 { \"contract\": 1, \"capabilities\": [\"files\"] }；不需要就删掉这个字段。", "requires"));
    else {
      if (record.contract !== undefined && (!Number.isInteger(record.contract) || (record.contract as number) < 1 || (record.contract as number) > 999))
        problems.push(fail("FIELD", "requires.contract 必须是 1–999 的整数。", "写宿主契约代际，例如 1；不确定就删掉这一项。", "requires.contract"));
      if (record.capabilities !== undefined) {
        if (!Array.isArray(record.capabilities) || record.capabilities.length > 32)
          problems.push(fail("FIELD", "requires.capabilities 必须是 0–32 项数组。", "每项是一个能力名，例如 \"files\"、\"clipboard\"。", "requires.capabilities"));
        else record.capabilities.forEach((item, index) => {
          if (typeof item !== "string" || !/^[a-z][a-zA-Z.]{0,31}$/.test(item))
            problems.push(fail("FIELD", `requires.capabilities[${index}] 必须是合法能力名：${JSON.stringify(item)}。`, "例如 \"files\"、\"sharedStore\"；能力名见开发指导手册的「能力表」。", `requires.capabilities[${index}]`));
        });
      }
    }
  }

  if (tool.needsSelection !== undefined && typeof tool.needsSelection !== "boolean")
    problems.push(fail("FIELD", "needsSelection 只能是 true 或 false。", "需要在唤起时拿到可用文本才写 true；否则删掉这个字段。", "needsSelection"));

  const background = tool.background;
  if (background !== undefined) {
    const record = objectOf(background);
    if (!record) problems.push(fail("FIELD", "background 必须是对象。", "例如 { \"reason\": \"剪切板历史\", \"schedule\": false }。", "background"));
    else {
      if (record.reason !== undefined && (typeof record.reason !== "string" || !record.reason.trim() || record.reason.length > 200))
        problems.push(fail("FIELD", "background.reason 需要 1–200 字，写给人看。", "例如「记录剪切板历史」——安装时会展示给用户。", "background.reason"));
      if (record.schedule !== undefined && typeof record.schedule !== "boolean")
        problems.push(fail("FIELD", "background.schedule 只能是 true 或 false。", "需要定时唤醒才写 true。", "background.schedule"));
    }
  }

  if (problems.length) return { ok: false, violations: problems };

  return {
    ok: true,
    tool: {
      schemaVersion: 1,
      id: tool.id as string,
      name: (tool.name as string).trim(),
      version: tool.version as string,
      html: tool.html as string,
      ...(readToolIcon(tool.icon) === undefined ? {} : { icon: readToolIcon(tool.icon)! }),
      ...(checkedActions === undefined ? {} : { actions: checkedActions }),
      ...(tool.settingsSchema === undefined ? {} : { settingsSchema: readSettingsSchema(tool.settingsSchema) }),
      ...(normalizePermissions(tool.permissions) === undefined ? {} : { permissions: normalizePermissions(tool.permissions)! }),
      ...(typeof tool.author === "string" && tool.author.trim() ? { author: tool.author.trim() } : {}),
      ...(typeof tool.source === "string" && tool.source.trim() ? { source: tool.source.trim() } : {}),
      ...(tool.requires === undefined ? {} : { requires: normalizeRequires(tool.requires) }),
      ...(tool.needsSelection === true ? { needsSelection: true as const } : {}),
      ...(normalizeBackground(tool.background) === undefined ? {} : { background: normalizeBackground(tool.background)! }),
      ...(typeof preload === "string" && preload.trim() ? { preload: preload.trim() } : {}),
      ...(tool.sourceFiles === undefined ? {} : { sourceFiles: readSourceFiles(tool.sourceFiles) }),
    } satisfies ToolPackage,
  };
}

/** 校验一段 JSON 文本（含体积与语法）。 */
export function validateToolPackageText(text: string): ToolValidation {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > toolPackageLimit)
    return { ok: false, violations: [fail("FIELD", `工具包 ${Math.ceil(bytes / 1024)} KB，超过 ${Math.round(toolPackageLimit / 1024 / 1024)} MB 上限。`, "把图片、wasm、node_modules 这类重货放进工具目录（随 ZIP 一起分发），不要塞进清单的 html 或 sourceFiles。", "html")] };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, violations: [fail("FIELD", `工具包必须是有效的 JSON：${detail}`, "检查是否少了逗号、引号没闭合，或粘进了说明文字。")] };
  }
  return validateToolPackage(value);
}

/** 校验并返回工具包；失败抛 `ToolPackageError`（带着完整问题列表）。 */
export function parseToolPackage(text: string): ToolPackage {
  const result = validateToolPackageText(text);
  if (!result.ok) throw new ToolPackageError(result.violations);
  return result.tool;
}

/** 宽容版：任一处不合法就返回 undefined（运行时/旧数据读取用，不产生提示）。 */
export function readToolPackage(value: unknown): ToolPackage | undefined {
  const result = validateToolPackage(value);
  return result.ok ? result.tool : undefined;
}
