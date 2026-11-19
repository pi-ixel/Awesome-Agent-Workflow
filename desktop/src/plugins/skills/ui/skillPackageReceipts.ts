import type { HostStorage } from "../../host/types.ts";
import type { SkillPackage } from "../types.ts";
export const packageReceiptsKey = "aaw-desktop/skill-packages.v1";

export function receipts(storage: HostStorage): SkillPackage[] {
  const raw: unknown = JSON.parse(storage.getItem(packageReceiptsKey) ?? "[]");
  if (!Array.isArray(raw)) throw new Error("插件恢复记录无法读取");
  return raw.filter(
    (p: unknown): p is SkillPackage =>
      typeof p === "object" &&
      p !== null &&
      "id" in p &&
      typeof p.id === "string" &&
      "path" in p &&
      typeof p.path === "string",
  );
}
