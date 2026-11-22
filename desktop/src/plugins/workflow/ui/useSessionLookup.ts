/**
 * 界面里按会话 id 查会话实时状态（ADR 040）。订阅服务给的会话活动，会话一变，
 * 用到它的界面在同一次渲染里跟着变——和会话视图读的是同一份。
 */
import { useMemo } from "react";
import { useRegisteredSnapshot } from "../../../shared/state/useRegisteredSnapshot.ts";
import { sessionStatusOf } from "../status/nodeActivity.ts";
import type { SessionLookup } from "../status/snapshot.ts";
import type { WorkflowService } from "../types.ts";

export function useSessionLookup(service: Pick<WorkflowService, "sessionActivity">): SessionLookup | undefined {
  const state = useRegisteredSnapshot(service.sessionActivity, (value) => value);
  return useMemo(
    () => (state === undefined ? undefined : (sessionId: string | null | undefined) => sessionStatusOf(state, sessionId)),
    [state],
  );
}
