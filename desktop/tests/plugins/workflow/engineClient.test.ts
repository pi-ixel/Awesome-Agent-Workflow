/**
 * WorkflowClient 的活动运行宿主真相重建（退出闸门消费面，ADR 024 §11）：
 * WebView 重载后新实例没有 run-starting 事件历史，activeRuns 恒为空——
 * rebuildActiveRunsFromHost 按宿主探测（workflow_service_running +
 * active-runs）补回运行中的 runId，isBusy 不再失忆。
 */
import { describe, expect, it } from "vitest";
import { WorkflowClient } from "../../../src/plugins/workflow/engine/client.ts";
import type { WorkflowPlatform } from "../../../src/plugins/workflow/engine/client.ts";
import type { WorkflowEnvelope, WorkflowEvent } from "../../../src/plugins/workflow/engine/protocol.ts";

/** 平台桩：aaw://workflow-service 的信封按 Tauri 事件语义分发给已注册
 * 的 listener；workflow_service_write 的请求立即以 response 信封回。 */
function makePlatform(options: {
  isTauri?: boolean;
  running?: boolean;
  activeRuns?: string[];
  activeRunsError?: boolean;
} = {}) {
  const invoked: string[] = [];
  const listeners = new Map<string, (payload: WorkflowEnvelope) => void>();
  let serial = 0;
  const deliver = (envelope: WorkflowEnvelope) =>
    listeners.get("aaw://workflow-service")?.(envelope);
  const platform: WorkflowPlatform = {
    isTauriEnv: () => options.isTauri ?? true,
    invoke: async <T>(command: string, args?: Record<string, unknown>) => {
      invoked.push(command);
      if (command === "workflow_service_running") {
        return (options.running ?? false) as T;
      }
      if (command === "workflow_service_start") {
        return { generation: 1, pid: 1 } as T;
      }
      if (command === "workflow_service_write") {
        const message = (args?.message ?? {}) as {
          id?: number;
          method?: string;
        };
        if (message.method === "active-runs") {
          deliver(
            options.activeRunsError === true
              ? {
                  generation: 1,
                  message: { type: "response", id: message.id, error: "boom" },
                }
              : {
                  generation: 1,
                  message: {
                    type: "response",
                    id: message.id,
                    result: options.activeRuns ?? [],
                  },
                },
          );
        }
        return undefined as T;
      }
      throw new Error(`unexpected command: ${command}`);
    },
    listen: async <T>(
      event: string,
      handler: (event: { payload: T }) => void,
    ) => {
      listeners.set(event, (payload) => handler({ payload: payload as T }));
      return () => {
        listeners.delete(event);
      };
    },
  };
  return {
    platform,
    invoked,
    nextSerial: () => ++serial,
    emit(event: WorkflowEvent) {
      deliver({ generation: 1, message: { type: "event", event } });
    },
  };
}

describe("WorkflowClient.rebuildActiveRunsFromHost", () => {
  it("重载场景：新实例探测宿主并补回运行中的 runId", async () => {
    const probe = makePlatform({ running: true, activeRuns: ["run-1", "run-2"] });
    const reloaded = new WorkflowClient(probe.platform);
    expect(reloaded.hasActiveRuns()).toBe(false);
    await reloaded.rebuildActiveRunsFromHost();
    expect(probe.invoked).toContain("workflow_service_running");
    expect(reloaded.hasActiveRuns()).toBe(true);
  });

  it("事件照常增删：run-settled 后活动集清空", async () => {
    const probe = makePlatform({ running: true, activeRuns: ["run-1"] });
    const reloaded = new WorkflowClient(probe.platform);
    await reloaded.rebuildActiveRunsFromHost();
    probe.emit({ type: "run-settled", runId: "run-1" });
    expect(reloaded.hasActiveRuns()).toBe(false);
  });

  it("服务未运行（workflow_service_running=false）→ 不发 active-runs 请求", async () => {
    const probe = makePlatform({ running: false });
    const client = new WorkflowClient(probe.platform);
    await client.rebuildActiveRunsFromHost();
    expect(probe.invoked).toEqual(["workflow_service_running"]);
    expect(client.hasActiveRuns()).toBe(false);
  });

  it("非 Tauri 环境（浏览器 / vitest）→ no-op，不触发任何 IPC", async () => {
    const probe = makePlatform({ isTauri: false, running: true });
    const client = new WorkflowClient(probe.platform);
    await client.rebuildActiveRunsFromHost();
    expect(probe.invoked).toEqual([]);
    expect(client.hasActiveRuns()).toBe(false);
  });

  it("active-runs 请求失败（服务不可用）→ 不伪造活动集", async () => {
    const probe = makePlatform({ running: true, activeRunsError: true });
    // 引擎侧以 error 信封回绝（服务不可用的代偿形态）：rebuild 的 catch
    // 吸收——探测失败不伪造活动集（绝不把未知态当忙碌/空闲证据）。
    const client = new WorkflowClient(probe.platform);
    await client.rebuildActiveRunsFromHost();
    expect(probe.invoked).toContain("workflow_service_running");
    expect(client.hasActiveRuns()).toBe(false);
  });
});
