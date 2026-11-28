import type { Context } from "cordis";
import type { NativeSkillLibrary } from "../../../host/types.ts";
import type { WorkbenchService } from "../../../workbench/service.ts";
import { isRemoteProjectPath, pathKey } from "../../../../shared/panelPaths.ts";

export const name = "codeagent-skill-cleanup";
export const inject = ["agents", "host", "workbench"];

const feedback = new WeakMap<
  object,
  {
    notify?: WorkbenchService["showToast"];
    pending?: Parameters<WorkbenchService["showToast"]>[0];
  }
>();

/** 核心阶段先登记，避免项目预热在工作台安装前完成握手而漏掉首次清理。 */
export function installSkillCleanup(
  agents: Pick<Context["agents"], "registerInitialized">,
  library: NativeSkillLibrary | undefined,
): () => void {
  const state: {
    notify?: WorkbenchService["showToast"];
    pending?: Parameters<WorkbenchService["showToast"]>[0];
  } = {};
  feedback.set(agents, state);
  const release = registerSkillCleanup(agents, library, (input) => {
    if (state.notify) state.notify(input);
    else state.pending = input;
  });
  return () => {
    release();
    feedback.delete(agents);
  };
}

export function bindCleanupFeedback(
  agents: object,
  notify: WorkbenchService["showToast"],
): () => void {
  const state = feedback.get(agents);
  if (!state) return () => {};
  state.notify = notify;
  if (state.pending) {
    notify(state.pending);
    state.pending = undefined;
  }
  return () => {
    if (state.notify === notify) state.notify = undefined;
  };
}

export function registerSkillCleanup(
  agents: Pick<Context["agents"], "registerInitialized">,
  library: NativeSkillLibrary | undefined,
  notify: WorkbenchService["showToast"],
): () => void {
  let active = true;
  const release = agents.registerInitialized?.(
    async (adapter, launch, info) => {
      if (
        !active ||
        adapter.id !== "codeagent" ||
        !library?.cleanupCodeAgent ||
        (launch.cwd && isRemoteProjectPath(launch.cwd))
      )
        return;
      try {
        const results = await library.cleanupCodeAgent(
          pathKey(launch.command[0] ?? "codeagent"),
          info.agentInfo.version ?? null,
        );
        if (!active || !results.length) return;
        const failed = results.filter((r) => !r.ok);
        const succeeded = results.length - failed.length;
        notify({
          message: `CodeAgent 内置技能：已删除 ${succeeded} 项，失败 ${failed.length} 项${failed.length ? ` · ${failed[0]!.message}` : ""}`,
          variant: failed.length ? (succeeded ? "warn" : "danger") : "ok",
          dedupeKey: "codeagent-skill-cleanup",
        });
      } catch (error) {
        if (active)
          notify({
            message: `CodeAgent 内置技能清理失败，下次使用时重试 · ${String(error)}`,
            variant: "danger",
            dedupeKey: "codeagent-skill-cleanup",
          });
      }
    },
  );
  return () => {
    active = false;
    release?.();
  };
}

export function apply(ctx: Context): void {
  ctx.effect(() => bindCleanupFeedback(ctx.agents, ctx.workbench.showToast));
}
