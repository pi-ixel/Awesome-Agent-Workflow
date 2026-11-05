import { pathKey } from "./panelPaths.ts";
import { parseSessionPinKey, sessionPinKey } from "./sessionPin.ts";
export interface LegacyAgentData {
  readonly key: string;
  readonly kind: "标题" | "草稿" | "输入历史" | "消息快照" | "归档" | "置顶";
  readonly label: string;
  readonly value: string;
}
const prefix = "aaw-desktop/";
const archivesKey = prefix + "archived-sessions.v1";
const metadataKey = prefix + "archived-session-metadata.v1";
const workspaceKey = prefix + "workspace/v1";
const claimKey = (key: string) =>
  prefix + "legacy-owner/" + encodeURIComponent(key);

/** Legacy records contain no trustworthy agent owner. Never guess ownership. */
export function listLegacyAgentData(
  storage: Storage = localStorage,
): LegacyAgentData[] {
  const result: LegacyAgentData[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)!;
    if (storage.getItem(claimKey(key)) !== null) continue;
    const value = storage.getItem(key);
    if (value === null) continue;
    for (const [name, kind] of [
      ["session-title/", "标题"],
      ["draft/", "草稿"],
      ["prompt-history/", "输入历史"],
      ["session-log/", "消息快照"],
    ] as const) {
      if (!key.startsWith(prefix + name)) continue;
      const suffix = key.slice((prefix + name).length);
      if (suffix.startsWith("v2/")) continue;
      try {
        const label = decodeURIComponent(suffix);
        // Scoped message logs encode [agentKey, project#session].
        if (name === "session-log/" && label.startsWith("[")) continue;
        result.push({ key, kind, label, value });
      } catch {
        /* malformed keys remain untouched */
      }
    }
  }
  try {
    const keys: unknown = JSON.parse(storage.getItem(archivesKey) ?? "[]");
    if (Array.isArray(keys))
      for (const key of keys) {
        if (
          typeof key !== "string" ||
          key.split("\0").length !== 2 ||
          storage.getItem(claimKey("archive:" + key)) !== null
        )
          continue;
        result.push({
          key: "archive:" + key,
          kind: "归档",
          label: key.replace("\0", " / "),
          value: key,
        });
      }
  } catch {
    /* invalid archive data is not migrated */
  }
  try {
    const workspace = JSON.parse(
      storage.getItem(workspaceKey) ?? "{}",
    ) as Record<string, unknown>;
    if (workspace.version === 1 && Array.isArray(workspace.pinnedSessions)) {
      for (const key of workspace.pinnedSessions) {
        if (typeof key !== "string") continue;
        const pin = parseSessionPinKey(key);
        if (
          !pin ||
          pin.agentKey !== undefined ||
          storage.getItem(claimKey("pin:" + key)) !== null
        )
          continue;
        result.push({
          key: "pin:" + key,
          kind: "置顶",
          label: pin.path + " / " + pin.sessionId,
          value: key,
        });
      }
    }
  } catch {
    /* malformed workspace records remain untouched */
  }
  return result;
}

/** Explicit per-record attribution. Preserve originals and never overwrite scoped data. */
export function migrateLegacyAgentData(
  record: LegacyAgentData,
  agentKey: string,
  storage: Storage = localStorage,
  targetSessionId?: string,
): void {
  if (!agentKey) throw new Error("请先选择 Agent");
  if (storage.getItem(claimKey(record.key)) !== null)
    throw new Error("该记录已归属其他迁移操作");
  if (record.kind === "置顶") {
    const workspace = JSON.parse(
      storage.getItem(workspaceKey) ?? "{}",
    ) as Record<string, unknown>;
    const pin = parseSessionPinKey(record.value);
    if (
      !pin ||
      pin.agentKey !== undefined ||
      workspace.version !== 1 ||
      !Array.isArray(workspace.pinnedSessions) ||
      !workspace.pinnedSessions.includes(record.value)
    )
      throw new Error("旧记录已变化，请刷新");
    const pins: unknown[] = workspace.pinnedSessions;
    const target = sessionPinKey(pin.path, pin.sessionId, agentKey);
    if (pins.includes(target)) throw new Error("目标已有置顶记录，未覆盖");
    storage.setItem(
      workspaceKey,
      JSON.stringify({
        ...workspace,
        pinnedSessions: [target, ...pins],
      }),
    );
  } else if (record.kind === "归档") {
    const target = record.value + "\0" + encodeURIComponent(agentKey);
    const keys = JSON.parse(storage.getItem(archivesKey) ?? "[]") as string[];
    if (!keys.includes(record.value)) throw new Error("旧记录已变化，请刷新");
    if (keys.includes(target)) throw new Error("目标已有归档记录，未覆盖");
    const metadata = JSON.parse(storage.getItem(metadataKey) ?? "{}") as Record<
      string,
      unknown
    >;
    if (metadata[record.value] && !metadata[target]) {
      storage.setItem(
        metadataKey,
        JSON.stringify({ ...metadata, [target]: metadata[record.value] }),
      );
    }
    storage.setItem(archivesKey, JSON.stringify([...keys, target]));
  } else {
    if (storage.getItem(record.key) !== record.value)
      throw new Error("旧记录已变化，请刷新");
    let target: string;
    if (record.kind === "标题") {
      target =
        prefix +
        "session-title.v2/" +
        encodeURIComponent(
          JSON.stringify([
            agentKey,
            record.key.slice((prefix + "session-title/").length),
          ]),
        );
    } else if (record.kind === "消息快照") {
      if (!record.label.includes("#") && !targetSessionId?.trim())
        throw new Error("该旧快照缺少会话标识，请填写目标会话 ID");
      target =
        prefix +
        "session-log/" +
        encodeURIComponent(
          JSON.stringify([
            agentKey,
            record.label.includes("#")
              ? record.label
              : pathKey(record.label) + "#" + targetSessionId!.trim(),
          ]),
        );
    } else {
      const name = record.kind === "草稿" ? "draft/" : "prompt-history/";
      const suffix = record.key.slice((prefix + name).length);
      const split = suffix.indexOf("/");
      if (split < 0) throw new Error("旧记录缺少会话标识，无法自动迁移");
      const session =
        record.kind === "草稿"
          ? encodeURIComponent(suffix.slice(split + 1))
          : suffix.slice(split + 1);
      target =
        prefix +
        name +
        "v2/" +
        encodeURIComponent(agentKey) +
        "/" +
        suffix.slice(0, split) +
        "/" +
        session;
    }
    if (storage.getItem(target) !== null)
      throw new Error("目标已有数据，未覆盖");
    storage.setItem(target, record.value);
  }
  storage.setItem(claimKey(record.key), agentKey);
}
