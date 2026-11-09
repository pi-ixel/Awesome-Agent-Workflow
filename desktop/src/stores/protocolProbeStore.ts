/**
 * 协议探查 store（src/stores）：诊断页「协议自检」的数据与状态机。
 *
 * 一次探查 = 对某个 agent 真实 spawn 一条 ACP 连接走完安全链路
 * （initialize → session/new → session/list → close；深度探查再加一轮
 * 极小 prompt），runner（src/ui/agentProbe.ts）负责执行，本 store 只持有
 * 进度与最近一次结果——不落盘、不累计历史（诊断语义：看最近一次）。
 */
import { create } from "zustand";
import type {
  SessionModeState,
  SessionModelState,
} from "../runtime/acpBase/protocol/types.ts";

/** 探查期事件计数（观测侧数据）。 */
export interface ProbeEventTally {
  /** 翻译后的 AcpSessionEvent 按 type 计数。 */
  readonly eventTypeCounts: Readonly<Record<string, number>>;
  /** tool_call 事件按 kind 计数（read/edit/execute/…）。 */
  readonly toolKindCounts: Readonly<Record<string, number>>;
  /** 未被翻译的原始通知按 method 计数（含 session/update:* 命名空间风格）。 */
  readonly rawMethodCounts: Readonly<Record<string, number>>;
}

export const emptyProbeEventTally = (): ProbeEventTally => ({
  eventTypeCounts: {},
  toolKindCounts: {},
  rawMethodCounts: {},
});

/** session/list 的实测结果。 */
export interface ProbeListOutcome {
  readonly status: "ok" | "failed" | "undeclared" | "unsupported";
  readonly count: number | null;
  readonly reason?: string;
}

/** 深度探查的一轮 prompt 结果。 */
export interface ProbePromptOutcome {
  readonly status: "ok" | "failed";
  readonly stopReason: string | null;
  readonly reason?: string;
}

/** 一次探查的完整画像（声明侧 + 观测侧）。 */
export interface AgentProbeResult {
  readonly agentId: string;
  readonly agentLabel: string;
  readonly depth: "safe" | "deep";
  readonly startedAt: string;
  readonly elapsedMs: number;
  /** 整体成败：false 时看 failedStep / failureReason。 */
  readonly ok: boolean;
  readonly failedStep: string | null;
  readonly failureReason: string | null;
  // —— 声明侧（initialize / session/new 结果）——
  readonly protocolVersion: number | null;
  readonly agentName: string | null;
  readonly agentVersion: string | null;
  readonly capabilities: Readonly<Record<string, unknown>> | null;
  /** null = 该 agent 的 session/new 未下发模型清单。 */
  readonly models: SessionModelState | null;
  /** null = 该 agent 的 session/new 未下发模式清单。 */
  readonly modes: SessionModeState | null;
  readonly list: ProbeListOutcome | null;
  readonly closeAck: boolean | null;
  // —— 观测侧 ——
  readonly events: ProbeEventTally;
  readonly permissionRequests: number;
  readonly questionRequests: number;
  /**
   * 深度探查的对话轮结论（安全探查为空数组）：轮 1 轻量回复（验证消息
   * 流与 stopReason），轮 2 多步任务（列目录 + 跑命令——真实触发思考、
   * 工具、计划与审批）。两轮之后仍未出现的对话类能力才是真缺失。
   */
  readonly prompts: readonly ProbePromptOutcome[];
}

interface ProtocolProbeState {
  /** idle 未探查 / probing 进行中 / done 已出结果（含失败）。 */
  readonly phase: "idle" | "probing" | "done";
  /** 进行中的当前步骤（中文短语，进度展示用）。 */
  readonly step: string | null;
  /** 正在探查的 agent id（探查中禁用对应行/按钮；非进行中为 null）。 */
  readonly probingAgentId: string | null;
  readonly result: AgentProbeResult | null;
  /** 每个 agent 最近一次自检结论（内存态，按 agentId 记忆——列表行摘要）。 */
  readonly resultsByAgent: Readonly<Record<string, AgentProbeResult>>;
  begin: (agentId: string) => void;
  setStep: (step: string) => void;
  finish: (result: AgentProbeResult) => void;
  reset: () => void;
}

export const useProtocolProbeStore = create<ProtocolProbeState>()((set) => ({
  phase: "idle",
  step: null,
  probingAgentId: null,
  result: null,
  resultsByAgent: {},
  begin: (agentId) => {
    set({
      phase: "probing",
      step: "启动进程",
      probingAgentId: agentId,
      result: null,
    });
  },
  setStep: (step) => {
    set({ step });
  },
  finish: (result) => {
    set((state) => ({
      phase: "done",
      step: null,
      probingAgentId: null,
      result,
      resultsByAgent: { ...state.resultsByAgent, [result.agentId]: result },
    }));
  },
  reset: () => {
    set({
      phase: "idle",
      step: null,
      probingAgentId: null,
      result: null,
      resultsByAgent: {},
    });
  },
}));
