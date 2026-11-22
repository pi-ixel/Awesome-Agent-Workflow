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
  /** 这一版生效的运行副本目录。 */
  readonly dir?: string;
}

export interface InstallOptions {
  /** 允许覆盖已装的同一 id；默认 false（撞 id 当场报错）。 */
  readonly replace?: boolean;
  /**
   * 这一版生效的运行副本目录（调用方已经写好的版本目录）。
   *
   * 省略表示沿用记录里原来的 `dir`——那里没有新目录可切，就不该动它。
   * 这里不做任何校验：校验属于写盘那一步的责任，重复一遍只会给出两套口径。
   */
  readonly runDir?: string;
  /**
   * 开发来源目录。省略 = 保留原来的；`null` = 显式清掉（例如从 ZIP 更新，
   * 原先那个项目目录已经不再对应这一版了）。
   */
  readonly sourceDir?: string | null;
}

export interface ToolsService {
  readonly state: ReadonlySnapshot<readonly PersonalTool[]>;
  /**
   * 写一条安装记录（提交步）。
   *
   * 它**不写磁盘上的工具文件**：文件由工坊的暂存流程写进版本目录再传进来
   * （`runDir`）。以前这一步同时负责解压落盘，于是"写盘失败"和"写配置失败"
   * 混成一条错误，生效目录被写坏也照样报成安装失败。
   *
   * 但它会等配置**落盘**再返回：`setItem` 只是把值放进队列，真正的写文件是
   * 另一次异步动作。写不进去就退回内存状态并抛错——否则界面报"已更新"、重启
   * 回到旧版，而新版目录已经没人指向（详见 `persist` 的注释）。
   */
  install(tool: ToolPackage, options?: InstallOptions): Promise<InstallOutcome>;
  /**
   * 退回上一版。
   *
   * 优先切回 `previousDir`（上一版的完整运行副本）；旧记录没有这个目录时，
   * 用 `previous.json` 里的清单重新物化一份——只有确认能凑齐运行文件才会
   * 动手，缺附件就明确拒绝，并保留当前版本。
   *
   * 返回 undefined 表示没有可回退的副本。回退本身也是一次安装，所以退回去
   * 之后还能再点一次退回来。
   */
  rollback(id: string): Promise<InstallOutcome | undefined>;
  /** 写回"生效的运行副本目录"，并把"目录丢失"的坏标记消掉。 */
  setRunDir(id: string, dir: string): void;
  /**
   * 只记/只清"开发来源目录"，不动版本、不动运行副本。
   *
   * 迁移旧记录、把某个项目登记成来源时用它：这些场景都不该触发一次覆盖
   * 安装（那会改更新时间，还会生成一份同版本的"上一版"备份）。
   */
  setSourceDir(id: string, dir: string | undefined): void;
  open(id: string): void;
  /** 撤掉安装记录。与 `install` 一样等落盘，写不进去就把条目放回去并抛错。 */
  remove(id: string): Promise<void>;
  saveSettings(id: string, values: ToolSettings): void;
}
