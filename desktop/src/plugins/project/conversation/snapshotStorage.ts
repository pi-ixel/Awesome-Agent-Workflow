import { managedProjectStorage } from "../lifecycle/persistence.ts";
import type { StorageItem } from "../../diagnostics/service.ts";
import type { HostManagedStorage } from "../../host/types.ts";

export const sessionLogPrefix = "aaw-desktop/session-log/";

export function sessionLogKey(scope: string): string {
  return sessionLogPrefix + encodeURIComponent(scope);
}

export function sessionData(
  kind: "snapshot" | "queue" | "imageDraft" | "messageImage",
) {
  function request<T>(
    command: Parameters<HostManagedStorage["request"]>[0],
    args: Record<string, unknown>,
  ): Promise<T> {
    const storage = managedProjectStorage();
    if (!storage?.available())
      return Promise.reject(new Error("本机会话存储不可用"));
    return storage.request(command, { kind, ...args });
  }
  return {
    available: () => managedProjectStorage()?.available() ?? false,
    read(scope: string): Promise<string | null> {
      return request("session_data_read", { scope });
    },
    write(scope: string, value: string | null, migrate = false): Promise<void> {
      return request("session_data_write", { scope, value, migrate });
    },
    list(): Promise<StorageItem[]> {
      return request("session_data_list", {});
    },
    remove({
      key: scope,
      revision: expectedRevision,
    }: StorageItem): Promise<boolean> {
      return request("session_data_remove", { scope, expectedRevision });
    },
  };
}

export const nativeSnapshots = sessionData("snapshot");
export const nativePromptQueue = sessionData("queue");
export const nativeImageDrafts = sessionData("imageDraft");
export const nativeMessageImages = sessionData("messageImage");
