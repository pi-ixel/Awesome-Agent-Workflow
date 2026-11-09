import type { AcpSessionPort } from "../../contracts/acpSession.ts";
import type { SessionInfo } from "../../contracts/acpProtocol.ts";
import { pathKey } from "../../shared/panelPaths.ts";

/** ACP 分页查询。失效或不完整的结果交由调用方保留旧目录。 */
export async function readCatalogHistory(
  session: Pick<AcpSessionPort, "listSessions">,
  workspacePath: string,
  valid: () => boolean,
): Promise<readonly SessionInfo[] | null> {
  const entries = new Map<string, SessionInfo>();
  const deadline = Date.now() + 30_000;
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    if (!valid()) return null;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("获取会话列表超时，请重试");
    const page = await session.listSessions(workspacePath, {
      cursor,
      timeoutMs: remaining,
    });
    if (!valid()) return null;
    for (const item of page.sessions) {
      if (pathKey(item.cwd) === pathKey(workspacePath))
        entries.set(item.sessionId, item);
    }
    cursor = page.nextCursor ?? undefined;
    if (cursor && seen.has(cursor))
      throw new Error("Agent 返回了重复的分页游标");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return [...entries.values()];
}
