import { desktopManagedStorage } from "../../host/service.ts";

export const MIB = 1024 ** 2;

export const conversationStorageGroup = {
  id: "conversation",
  label: "会话输入与附件",
  defaultMiB: 500,
  categories: [
    "project.queue",
    "project.draft",
    "project.annotations",
    "project.prompt-history",
    "project.image-drafts",
    "project.message-images",
  ],
} as const;

export const storageGroups = [
  {
    id: "configuration",
    label: "应用设置与会话管理",
    defaultMiB: 100,
    categories: [
      "configuration.native",
      "workbench.appearance",
      "project.settings",
      "agents.settings",
      "project.session-metadata",
    ],
  },
  {
    id: "snapshots",
    label: "会话文本快照",
    defaultMiB: 100,
    categories: ["project.session-cache"],
  },
  conversationStorageGroup,
  {
    id: "update-settings",
    label: "更新设置",
    defaultMiB: 10,
    categories: ["updates.settings"],
  },
  {
    id: "update-cache",
    label: "更新缓存",
    defaultMiB: 1024,
    categories: ["updates.cache"],
  },
  {
    id: "logs",
    label: "诊断日志",
    defaultMiB: 100,
    categories: ["diagnostics.logs"],
  },
  {
    id: "legacy",
    label: "迁移遗留数据",
    defaultMiB: 5,
    categories: ["storage.legacy"],
  },
] as const;

export type StorageGroup = (typeof storageGroups)[number];
type Thresholds = Partial<Record<StorageGroup["id"], number>>;
const storageKey = "aaw-desktop/storage-thresholds.v1";

export function thresholdMiB(
  thresholds: Thresholds,
  group: StorageGroup,
): number {
  const value = thresholds[group.id];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : group.defaultMiB;
}

export async function readThresholds(): Promise<Thresholds> {
  if (desktopManagedStorage.available())
    return desktopManagedStorage.request("storage_thresholds_read");
  return JSON.parse(localStorage.getItem(storageKey) ?? "{}") as Thresholds;
}

export async function writeThresholds(thresholds: Thresholds): Promise<void> {
  if (desktopManagedStorage.available())
    await desktopManagedStorage.request("storage_thresholds_write", {
      thresholds,
    });
  else localStorage.setItem(storageKey, JSON.stringify(thresholds));
}
