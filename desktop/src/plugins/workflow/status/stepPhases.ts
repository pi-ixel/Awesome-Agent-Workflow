import type { AawStepPhase, AawStepView } from "./models.ts";

/** 为进度条标记当前步骤，优先展示失败、受阻和作废状态。 */
export function deriveStepPhases(
  steps: readonly AawStepView[],
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
