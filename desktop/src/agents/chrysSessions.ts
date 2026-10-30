/**
 * chrys 历史会话的只读读取（src/agents 层）。
 *
 * 优先读取 `<sessions>/.cache/session_catalog.json`；索引不可用、或落后
 * 于目录（chrys 异常退出 / 被强杀未刷新索引）时，扫描直接子目录的
 * `session.json`，只保留 meta 中的列表字段。
 * 全程不启动 agent；连接后的 ACP `session/list` 仍是权威快照。
 *
 * 它是**缓存，不是权威**，因此本模块的纪律：
 * - 索引版本不匹配 / 形状不合 / 读不到 → 回落扫描；单文件失败不影响其他会话；
 * - 返回空**不等于**「该项目没有会话」，只等于「这次没读到」——调用方
 *   不得据此覆盖已连接项目的权威列表（侧栏统一使用 ACP session/list）；
 * - 缓存文件有大小上限保护（超限不解析），避免会话上千的机器拖慢启动；
 * - 只读 chat，兼容 schema_version=1 且没有 kind 的旧版会话元数据；
 * - 路径匹配只做字符串规范化（斜杠 / 大小写 / 尾斜杠），不要求目录存在
 *   ——树里本来就可能挂着已被删除的项目目录。
 */
import { createLogger } from "../core/logger.ts";
import type { HostRuntime } from "../core/host.ts";
import { joinPath } from "../core/host.ts";

const logger = createLogger("agent");

/** 会话索引缓存的相对位置（相对 chrys 会话目录）。 */
const CATALOG_RELATIVE_PATH = ".cache/session_catalog.json";

/** 缓存文件的解析上限：超过此长度不解析（防会话极多时拖慢启动）。 */
const CATALOG_MAX_BYTES = 2 * 1024 * 1024;

/** 受支持的缓存派生版本（chrys `CATALOG_DERIVATION_VERSION`）。 */
const SUPPORTED_CATALOG_VERSION = 1;

/** 一条已知会话（历史会话列表的渲染单元；与 store 的类型解耦）。 */
export interface KnownSession {
  readonly id: string;
  readonly title: string;
  /** 最近更新时间（ISO 8601）；缺失为 null。 */
  readonly updatedAt: string | null;
  /** 该会话绑定的项目目录（chrys 记录的原始字符串）。 */
  readonly cwd: string;
}

/**
 * 路径归一化：统一分隔符为 `/`、去掉尾斜杠、折叠大小写。
 * 只用于「catalog 里的 primary_cwd」与「项目列表里的路径」比对——两者
 * 来自不同来源（chrys 写入的原始串 vs 目录对话框返回值），分隔符与大小
 * 写都可能不一致；不要求路径真实存在（项目可能已被删）。
 */
export function normalizeSessionPath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function asRecord(raw: unknown): Readonly<Record<string, unknown>> | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Readonly<Record<string, unknown>>)
    : null;
}

function asNonEmptyString(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim().length > 0 ? raw : null;
}

/** 展示标题：自定标题 > 生成的短标题 > 首条消息原文（chrys display_title 顺序）。 */
function pickTitle(meta: Readonly<Record<string, unknown>>): string {
  return (
    asNonEmptyString(meta["custom_title"]) ??
    asNonEmptyString(meta["generated_title"]) ??
    asNonEmptyString(meta["title"]) ??
    "会话"
  );
}

/**
 * 解析会话索引缓存 → 已知会话列表（按 cwd 归一化后分组）。
 *
 * 形状（chrys session_catalog.py）：
 * `{ version: 1, sessions: { "<shortId>": { signature, meta } } }`
 *
 * 失败一律返回空 Map（调用方据此只做「补充」，不做「清空」）。
 */
export function parseSessionCatalog(
  raw: unknown,
): ReadonlyMap<string, readonly KnownSession[]> {
  return tryParseSessionCatalog(raw) ?? new Map();
}

/** null 表示索引不可用；有效的空索引不需要扫描磁盘。 */
function tryParseSessionCatalog(
  raw: unknown,
): ReadonlyMap<string, readonly KnownSession[]> | null {
  const record = asRecord(raw);
  if (record === null || record["version"] !== SUPPORTED_CATALOG_VERSION) {
    return null;
  }
  const sessions = asRecord(record["sessions"]);
  if (sessions === null) {
    return null;
  }
  const known: KnownSession[] = [];
  for (const entry of Object.values(sessions)) {
    const wrapper = asRecord(entry);
    const meta = wrapper === null ? null : asRecord(wrapper["meta"]);
    const session = parseSessionMeta(meta);
    if (session !== null) {
      known.push(session);
    }
  }
  return groupSessions(known);
}

function parseSessionMeta(raw: unknown): KnownSession | null {
  const meta = asRecord(raw);
  if (meta === null) return null;
  const isLegacyChat =
    meta["kind"] === undefined && meta["schema_version"] === 1;
  if (meta["kind"] !== "chat" && !isLegacyChat) return null;
  const id = asNonEmptyString(meta["session_id"]);
  const cwd = asNonEmptyString(meta["primary_cwd"]);
  if (id === null || cwd === null) return null;
  return {
    id,
    cwd,
    title: pickTitle(meta),
    updatedAt: asNonEmptyString(meta["updated_at"]),
  };
}

/** 按更新时间排序并去重，避免备份目录使同一会话出现两次。 */
function groupSessions(sessions: readonly KnownSession[]) {
  const grouped = new Map<string, KnownSession[]>();
  const seen = new Set<string>();
  for (const session of [...sessions].sort(
    (a, b) => rankOf(b.updatedAt) - rankOf(a.updatedAt),
  )) {
    const key = normalizeSessionPath(session.cwd);
    const identity = JSON.stringify([key, session.id]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const list = grouped.get(key) ?? [];
    list.push(session);
    grouped.set(key, list);
  }
  return grouped;
}

/** 有界并发，只扫描直接子目录；不遍历缓存、锁目录或对话附件。 */
async function scanSessionMetadata(
  host: HostRuntime,
  sessionsDir: string,
  names: readonly string[],
) {
  const sessions: (KnownSession | null)[] = Array.from(
    { length: names.length },
    () => null,
  );
  let next = 0;
  let skipped = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, names.length) }, async () => {
      while (next < names.length) {
        const index = next++;
        const name = names[index];
        if (name === undefined) continue;
        try {
          const text = await host.readTextFile(
            joinPath(sessionsDir, name, "session.json"),
          );
          const record = asRecord(JSON.parse(text) as unknown);
          sessions[index] = parseSessionMeta(record?.["meta"]);
        } catch {
          // 写入中的 JSON、已删除的目录或单文件权限问题不阻断整批扫描。
          skipped += 1;
        }
      }
    }),
  );
  logger.info("已扫描本地会话元数据", { directories: names.length, skipped });
  return groupSessions(sessions.filter((session) => session !== null));
}

/** 排序时间戳：缺失或非法时间视为最旧。 */
function rankOf(updatedAt: string | null): number {
  if (updatedAt === null) {
    return Number.NEGATIVE_INFINITY;
  }
  const time = Date.parse(updatedAt);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

/** 索引里收录的会话总数（跨项目求和）。 */
function countCatalogSessions(
  catalog: ReadonlyMap<string, readonly KnownSession[]>,
): number {
  let total = 0;
  for (const list of catalog.values()) {
    total += list.length;
  }
  return total;
}

/**
 * 优先索引，索引不可用或**落后于目录**时扫描；两者均不可读时返回空，
 * 不清除已有列表。
 *
 * 过期守卫：索引是 chrys 收尾时才刷新的缓存，异常退出 / 被强杀会留下
 * 旧索引（新会话全都不在里面，列表凭空缺一大截）。目录里可枚举的会话数
 * 多于索引收录数，就认定索引滞后，回落扫描拿磁盘实况。
 */
export async function readSessionCatalog(
  host: HostRuntime,
): Promise<ReadonlyMap<string, readonly KnownSession[]>> {
  try {
    const sessionsDir = await host.chrysSessionsDir();
    if (typeof sessionsDir !== "string" || sessionsDir.trim() === "") {
      return new Map();
    }
    // 目录名单只取一次：既是扫描的输入，也是索引的过期比对基准
    const names = (
      await host.listDirNames(sessionsDir)
    ).filter((name) => !name.startsWith(".") && !/[\\/]/.test(name));
    const catalogPath = joinPath(sessionsDir, CATALOG_RELATIVE_PATH);
    try {
      if (await host.pathExists(catalogPath)) {
        const text = await host.readTextFile(catalogPath);
        if (text.length <= CATALOG_MAX_BYTES) {
          const catalog = tryParseSessionCatalog(JSON.parse(text) as unknown);
          if (catalog !== null) {
            if (countCatalogSessions(catalog) >= names.length) {
              return catalog;
            }
            logger.info("会话索引落后于目录，回落扫描元数据", {
              indexed: countCatalogSessions(catalog),
              onDisk: names.length,
            });
          }
        }
      }
    } catch (error) {
      logger.info("会话索引不可读，回落扫描元数据", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    return await scanSessionMetadata(host, sessionsDir, names);
  } catch (error) {
    // 缓存不可读不是错误状态：树退回「没有历史可显示」的既有观感
    logger.info("本地历史会话不可读，本次不补充", {
      reason: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }
}
