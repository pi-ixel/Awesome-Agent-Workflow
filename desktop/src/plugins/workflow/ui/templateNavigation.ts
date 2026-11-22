/**
 * 左侧「工作流」功能区的导航状态（ADR 038）：侧栏选分类、中间显示库或详情。
 *
 * 侧栏与中间的功能区是两个独立挂载的视图，共用这一份状态；其他地方（运行页
 * 的「查看工作流」）也经它把功能区定位到某个工作流。
 */
import { createStore, type StoreApi } from "zustand/vanilla";

export type LibraryTab = "presets" | "mine";

export type TemplateRoute =
  | { readonly kind: "library" }
  | { readonly kind: "workflow"; readonly id: string }
  | { readonly kind: "draft"; readonly draftId: string };

/** 让 AI 新建 / 修改：弹窗里先说要求。 */
export type ComposeTarget =
  | { readonly kind: "new" }
  | { readonly kind: "edit"; readonly id: string; readonly name: string; readonly preset: boolean };

export interface TemplateNavigationState {
  readonly tab: LibraryTab;
  readonly route: TemplateRoute;
  /** 正在填写的 AI 要求（侧栏「用 AI 新建」也会打开它）。 */
  readonly compose: ComposeTarget | null;
}

export type TemplateNavigation = StoreApi<TemplateNavigationState>;

export function createTemplateNavigation(): TemplateNavigation {
  return createStore<TemplateNavigationState>(() => ({ tab: "presets", route: { kind: "library" }, compose: null }));
}
