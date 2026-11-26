import { pathKey } from "../../../shared/panelPaths.ts";
import type { HostStorage } from "../../host/types.ts";
import { sessionAgentId } from "./sessionDeletion.ts";

export interface StoredArchive {
  readonly title: string;
  readonly updatedAt: string | null;
}

interface SessionRecord {
  readonly agentId: string;
  readonly project: string;
  readonly sessionId: string;
  readonly title: string | null;
  readonly metadata: {
    readonly archive: StoredArchive | null;
    readonly unread: boolean;
    readonly cwd: string | null;
  };
}

export interface SessionRecords {
  readonly records: readonly SessionRecord[];
  readonly conflicts: readonly [string, string, string][];
}

type SessionChange =
  | { kind: "archive"; value: StoredArchive | null }
  | { kind: "unread"; value: boolean }
  | { kind: "cwd" | "title"; value: string | null };

export function createSessionMetadata(
  storage: HostStorage,
  initial: SessionRecords,
) {
  const owner = (project: string, agent: string, sessionId: string) => ({
    agentId: sessionAgentId(agent) ?? agent,
    project: pathKey(project),
    sessionId,
  });
  const key = ({ agentId, project, sessionId }: ReturnType<typeof owner>) =>
    JSON.stringify([agentId, project, sessionId]);
  const records = new Map(
    initial.records.map((record) => [key(record), record]),
  );
  const pending = new Map<string, Promise<void>>();
  const get = (project: string, agent: string, sessionId: string) =>
    records.get(key(owner(project, agent, sessionId)));

  function write(
    project: string,
    agent: string,
    sessionId: string,
    change?: SessionChange,
  ): Promise<void> {
    const identity = owner(project, agent, sessionId);
    const recordKey = key(identity);
    const previous = pending.get(recordKey);
    const task = (previous?.catch(() => {}) ?? Promise.resolve())
      .then(async () => {
        const current = records.get(recordKey);
        if (!change && current) return;
        await storage.managed!.request<void>("session_metadata_update", {
          owner: identity,
          change,
        });
        const record = current ?? {
          ...identity,
          title: null,
          metadata: { archive: null, unread: false, cwd: null },
        };
        records.set(
          recordKey,
          change?.kind === "title"
            ? { ...record, title: change.value }
            : change
              ? {
                  ...record,
                  metadata: { ...record.metadata, [change.kind]: change.value },
                }
              : record,
        );
      })
      .finally(() => {
        if (pending.get(recordKey) === task) pending.delete(recordKey);
      });
    pending.set(recordKey, task);
    return task;
  }

  return {
    get,
    write,
    forget: (project: string, agent: string, sessionId: string) =>
      records.delete(key(owner(project, agent, sessionId))),
  };
}

export type SessionMetadata = ReturnType<typeof createSessionMetadata>;
