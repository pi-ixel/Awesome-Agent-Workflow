import type { HostStorage } from "../../host/types.ts";
import type { SkillPackage, SkillPackageManager } from "../types.ts";
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
export async function uninstallSkillPackage(
  manager: SkillPackageManager,
  storage: HostStorage,
  pkg: SkillPackage,
) {
  // 保存原生标识以便卸载后从回收站重装。
  storage.setItem(
    packageReceiptsKey,
    JSON.stringify([...receipts(storage).filter((r) => r.id !== pkg.id), pkg]),
  );
  await manager.uninstall(pkg);
}
