/**
 * 项目界面的扩展位（ADR 037）。
 *
 * 插件把自己的入口和状态挂到项目界面的固定位置：会话顶部横幅、空会话的快捷
 * 动作、输入框「/」菜单、会话状态浮层、项目总览区块、项目树行上的按钮。
 * 平台按位置渲染，不认识具体插件；文案由插件给。由可选服务 `projectExtension`
 * 提供，未装配时这些位置都不显示。
 */
import type { ComponentType } from "react";
import type { ReadonlySnapshot } from "../../../shared/state/readonlySnapshot.ts";

/** 项目里一项需要关注的后台工作（如一次工作流运行）。 */
export interface ProjectActivity {
  readonly id: string;
  readonly title: string;
  /** 状态词（如「运行中」「等你回复」）。 */
  readonly label: string;
  /** 需要用户处理（醒目显示）。 */
  readonly attention: boolean;
  /** 第二行：来源与进展（如「AAW dev · 实现与测试」）。 */
  readonly detail: string;
  /** 状态胶囊里的一行概括（如「登录页 · 运行中 · 实现与测试」）。 */
  readonly summary: string;
  /** 打开它的按钮的无障碍名称。 */
  readonly openLabel: string;
}

export interface ProjectActivities {
  /** 这些活动属于哪个项目。 */
  readonly workspacePath: string | null;
  readonly items: readonly ProjectActivity[];
}

/** 输入框「/」菜单里的一项。 */
export interface ProjectSlashEntry {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** 条目前的图标（同技能行的位置）；给了图标时不再在名称前加「/」。 */
  readonly Icon?: ComponentType<{ readonly className?: string }>;
  run(this: void): void;
}

/** 空会话里的快捷动作（如「启动工作流」「查看进行中的工作流」）。 */
export interface ProjectQuickAction {
  readonly label: string;
  run(this: void, project: string): void;
}

/** 项目树每一行上的按钮。 */
export interface ProjectTreeAction {
  readonly label: string;
  readonly hint: string;
  readonly Icon: ComponentType<{ readonly className?: string }>;
  run(this: void, project: string): void;
}

export interface ProjectExtension {
  /** 会话状态浮层里这组活动的标题。 */
  readonly activityTitle: string;
  readonly activities: ReadonlySnapshot<ProjectActivities>;
  openActivity(this: void, project: string, id: string): void;
  /** 「/」菜单里这组条目的标题。 */
  readonly slashGroup: string;
  readonly slashEntries: ReadonlySnapshot<readonly ProjectSlashEntry[]>;
  readonly quickAction: ReadonlySnapshot<ProjectQuickAction | null>;
  readonly treeAction: ProjectTreeAction;
  /** 项目总览里的区块（可不提供）。 */
  readonly Overview?: ComponentType<{ readonly project: string }>;
  /** 会话顶部的横幅（不是插件自己的会话时不渲染）。 */
  readonly SessionBanner: ComponentType<{ readonly project: string; readonly sessionId: string }>;
}

declare module "cordis" {
  interface Context {
    projectExtension: ProjectExtension;
  }
}
