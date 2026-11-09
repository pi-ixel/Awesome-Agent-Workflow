/**
 * aaw CLI 状态数据源（src/aaw）：`AawStatusLoader` 契约的 CLI 实现。
 *
 * aawStatusStore（src/stores）定义的 loader 注入接口搬家到本层：它是
 * aaw CLI 的进程调用契约（命令形态、--peek 只读语义），归 aaw 集成层
 * 所有；store 只依赖该接口（stores → aaw 方向），避免在 store 层另起
 * 一套进程调用，与 aawCli.ts 的出站封装漂移。
 *
 * 命令形态与 aawCli.ts 共用同一封装（runAawJsonQuery）：
 * - listSrs：  `uv run <aaw.py> status --json`
 * - readStatus：`uv run <aaw.py> status --sr <SR> --json`
 * - readNext： `uv run <aaw.py> next --sr <SR> --peek --json`
 * - readPlan： `uv run <aaw.py> plan --sr <SR> --json`（定义拓扑全貌，
 *   只读、不依赖工作流状态；status 只含已物化步骤，完整流程图靠它）
 *
 * 契约：readNext 必须实现 `--peek` 只读语义（不认领 step、不上报遥测、
 * 不推进 task-dev），见 docs/cli-machine-protocol.md §8.3 与
 * skills/aaw-workflow/scripts/cli/main.py 的 next 命令。
 */
import { runAawJsonQuery, type AawStatusOptions } from "./aawCli.ts";

/** aaw 状态数据源注入接口（aawStatusStore 的 loader 槽）。 */
export interface AawStatusLoader {
  /** `aaw status --json`：SR 编号列表。 */
  listSrs(): Promise<unknown>;
  /** `aaw status --sr <SR> --json`：单 SR 的工作流状态。 */
  readStatus(sr: string): Promise<unknown>;
  /** `aaw next --sr <SR> --peek --json`：就绪工作单（只读）。 */
  readNext(sr: string): Promise<unknown>;
  /** `aaw plan --sr <SR> --json`：工作流模板完整链路（只读）。 */
  readPlan(sr: string): Promise<unknown>;
}

/** 用 aaw 层的标准进程封装（ProcessRunner）构造 CLI 数据源。 */
export function createCliAawStatusLoader(
  options: AawStatusOptions,
): AawStatusLoader {
  return {
    listSrs: () => runAawJsonQuery(options, ["status", "--json"]),
    readStatus: (sr) =>
      runAawJsonQuery(options, ["status", "--sr", sr, "--json"]),
    readNext: (sr) =>
      runAawJsonQuery(options, ["next", "--sr", sr, "--peek", "--json"]),
    readPlan: (sr) => runAawJsonQuery(options, ["plan", "--sr", sr, "--json"]),
  };
}
