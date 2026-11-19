import type { ReadonlySnapshot } from "../../shared/state/readonlySnapshot.ts";
import type { PersonalTool, ToolPackage, ToolSettings } from "./types.ts";

import type {} from "cordis";

declare module "cordis" {
  interface Context {
    tools: ToolsService;
  }
}

/** 一次安装/覆盖安装的结果，用来给用户说清"装了什么、换掉了什么"。 */
export interface InstallOutcome {
  readonly version: string;
  /** 覆盖安装前那一版的版本号；首次安装为 undefined。 */
  readonly previousVersion?: string;
  /** 之前是否已经装过（true = 更新，false = 新装）。 */
  readonly updated: boolean;
  /** 版本号是否真的变了。false 表示内容覆盖但版本号没动。 */
  readonly versionChanged: boolean;
  /** 这次安装带上了来源目录（从项目目录装 / 或本来就是）。 */
  readonly dir?: string;
}

export interface ToolsService {
  readonly state: ReadonlySnapshot<readonly PersonalTool[]>;
  /**
   * `sourceDir` 是这次安装的来源项目目录（从 ZIP 导入时没有）。
   *
   * 记它有两个用处：界面能回答"这个工具是哪个目录装的"，以及当目录里的
   * 内容再被改过时提示"项目已改动，这一版还没装"。
   */
  install(tool: ToolPackage, replace?: boolean, sourceDir?: string): InstallOutcome;
  /**
   * 退回上一版（覆盖安装前落盘的那一份）。
   *
   * 返回 undefined 表示没有可回退的副本——只有"装过至少两次"的工具才有。
   * 回退本身也是一次安装，所以退回去之后还能再点一次退回来。
   */
  rollback(id: string): Promise<InstallOutcome | undefined>;
  /**
   * 只补记"来源目录"，不动版本与设置。
   *
   * 老工具是从配置里迁到项目目录的：迁移那一刻才知道目录在哪，而重装一次
   * 会改掉更新时间、还会白白生成一份同版本的"上一版"备份，所以单独开一个
   * 窄接口给它用。
   */
  setSource(id: string, dir: string): void;
  open(id: string): void;
  remove(id: string): void;
  saveSettings(id: string, values: ToolSettings): void;
}
