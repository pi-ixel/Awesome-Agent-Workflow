/**
 * 进度条步骤相位（旧 CLI status 模型的纯函数；project 插件的会话状态
 * 摘要仍经 service.ts 转出复用，批次二随旧模型一并清尾——ADR 024 §5）。
 */

/** 进度条使用的步骤相位。 */
export type AawStepPhase =
  "completed" | "current" | "pending" | "failed" | "blocked" | "superseded";

/** `status --sr` 输出里的单个 step 投影（types.ts 同名类型的本地副本）。 */
interface StepView {
  readonly finished: boolean;
  readonly executionStatus: string | null;
}

/** 为进度条标记当前步骤，优先展示失败、受阻和作废状态。 */
export function deriveStepPhases(
  steps: readonly StepView[],
): AawStepPhase[] {
  let currentAssigned = false;
  return steps.map((step) => {
    // 坏终态优先：失败 / 受阻 / 作废要能被看见，不能落回「待办」
    if (step.executionStatus === "failed") {
      return "failed";
    }
    if (step.executionStatus === "blocked") {
      return "blocked";
    }
    if (step.executionStatus === "superseded") {
      return "superseded";
    }
    if (step.finished) {
      return "completed";
    }
    const isCurrent =
      !currentAssigned &&
      (step.executionStatus === "running" || step.executionStatus === "ready");
    if (isCurrent) {
      currentAssigned = true;
      return "current";
    }
    return "pending";
  });
}
