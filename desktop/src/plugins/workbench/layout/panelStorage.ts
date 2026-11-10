import type { HostStorage } from "../../host/types.ts";
import { isAbsolutePath, pathKey } from "../../../shared/panelPaths.ts";
import { asRecord } from "../../../shared/valueGuards.ts";
import type { PanelLayoutCompatibility } from "../types.ts";
import type { PanelTab, ProjectPanel } from "./types.ts";

type LegacyTab = PanelLayoutCompatibility["tabs"][number];
const storageKey = "aaw-desktop/right-panel/zcode-v1";

function restoreToolViews(
  data: Readonly<Record<string, unknown>>,
  compatibility: readonly PanelLayoutCompatibility[],
): ProjectPanel["toolViews"] {
  const stored = asRecord(data.toolViews) ?? {};
  const views = Object.fromEntries(
    Object.entries(stored).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  for (const { toolView } of compatibility) {
    if (!toolView || Object.hasOwn(views, toolView.id)) continue;
    const restored = toolView.read(data);
    if (restored !== undefined) views[toolView.id] = restored;
  }
  return Object.keys(views).length ? views : undefined;
}
/** Validate the original v1 records before passing opaque data to the owner. */
function restoreTab(value: unknown, compatibility: ReadonlyMap<string, LegacyTab>): PanelTab | null {
  const tab = asRecord(value);
  if (!tab) return null;
  const { id, kind, openedAt, ...fields } = tab;
  if (
    typeof id !== "string" ||
    !id ||
    typeof kind !== "string" ||
    !kind ||
    kind === "new-tab" ||
    (openedAt !== undefined &&
      (typeof openedAt !== "number" || !Number.isFinite(openedAt)))
  )
    return null;
  const legacy = compatibility.get(kind);
  if (legacy && ("singleton" in legacy ? id !== kind : !legacy.validate(fields)))
    return null;
  const data = legacy ? fields : asRecord(fields.data);
  return {
    id,
    kind,
    ...(typeof openedAt === "number" ? { openedAt } : {}),
    ...(data && Object.keys(data).length ? { data } : {}),
  };
}

export function restorePanels(
  raw: string | null,
  compatibility: readonly PanelLayoutCompatibility[] = [],
): Record<string, ProjectPanel> {
  try {
    const value = asRecord(JSON.parse(raw ?? "null"));
    const savedProjects = asRecord(value?.projects);
    if (value?.version !== 1 || !savedProjects) return {};
    const tabCompatibility = new Map(compatibility.flatMap(({ tabs }) =>
      tabs.map((tab) => [tab.kind, tab] as const),
    ));
    const projects: Record<string, ProjectPanel> = {};
    for (const [path, saved] of Object.entries(savedProjects).slice(-50)) {
      const data = asRecord(saved);
      if (!isAbsolutePath(path) || !data || !Array.isArray(data.tabs))
        continue;
      const tabs = (data.tabs as unknown[])
        .map((tab) => restoreTab(tab, tabCompatibility))
        .filter((tab) => tab !== null)
        .slice(0, 100);
      const active = typeof data.active === "string" ? data.active : "";
      const legacyActive = tabCompatibility.get(active);
      // 旧数据迁移：active 指向单例工具而 tabs 缺对应单例时自动补建（无缝升级）。
      const migrated: PanelTab[] =
        legacyActive && "singleton" in legacyActive &&
        !tabs.some((tab) => tab.id === active)
          ? [...tabs, { id: active, kind: active }]
          : tabs;
      // active 越界回落到首个 tab；无 tab 时回落到起始页（""）。
      const resolvedActive = migrated.some((tab) => tab.id === active)
        ? active
        : (migrated[0]?.id ?? "");
      projects[pathKey(path)] = {
        open: data.open === true,
        active: resolvedActive,
        sizeRatio:
          typeof data.sizeRatio === "number" && Number.isFinite(data.sizeRatio)
            ? Math.min(0.9, Math.max(0.1, data.sizeRatio))
            : undefined,
        tabs: migrated,
        toolViews: restoreToolViews(data, compatibility),
      };
    }
    return projects;
  } catch {
    return {};
  }
}
export function loadPanels(
  storage: HostStorage,
  compatibility: readonly PanelLayoutCompatibility[],
): Record<string, ProjectPanel> {
  try {
    const current = storage.getItem(storageKey);
    if (current !== null) return restorePanels(current, compatibility);
    // 首次迁移只重置布局偏好；保留文件标签、工具选择及业务引用。
    const previous = restorePanels(
      storage.getItem("aaw-desktop/right-panel/v1"),
      compatibility,
    );
    return Object.fromEntries(
      Object.entries(previous).map(([key, panel]) => [
        key,
        {
          ...panel,
          open: false,
          sizeRatio: undefined,
        },
      ]),
    );
  } catch {
    return {};
  }
}
export function persistPanels(
  storage: HostStorage,
  projects: Record<string, ProjectPanel>,
  compatibility: readonly PanelLayoutCompatibility[],
): void {
  try {
    const flatKinds = new Set(compatibility.flatMap(({ tabs }) => tabs.map(({ kind }) => kind)));
    // 会话级状态不落盘（对齐 ZCode taskSidePaneMemory 内存语义）：
    // recentlyClosed / fullView / new-tab 占位剥离后写盘，旧读取方兼容。
    const serialized = Object.fromEntries(
      Object.entries(projects).map(([key, panel]) => [
        key,
        {
          ...panel,
          recentlyClosed: undefined,
          fullView: undefined,
          tabs: panel.tabs
            .filter((tab) => tab.kind !== "new-tab")
            .map(({ data, id, kind, openedAt }) =>
              flatKinds.has(kind)
                ? { ...data, id, kind, openedAt }
                : { id, kind, openedAt, data },
            ),
        },
      ]),
    );
    storage.setItem(
      storageKey,
      JSON.stringify({ version: 1, projects: serialized }),
    );
  } catch {
    /* 存储配额不阻断当前使用。 */
  }
}
