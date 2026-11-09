import { createStore } from "zustand";
import type { AgentProbeResult, AgentProbeSnapshot } from "../../contracts/agentProbe.ts";

interface ProtocolProbeState extends AgentProbeSnapshot {
  begin: (agentId: string) => void;
  setStep: (step: string) => void;
  finish: (result: AgentProbeResult) => void;
  reset: () => void;
}

export const createProtocolProbeStore = () =>
  createStore<ProtocolProbeState>()((set) => ({
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
