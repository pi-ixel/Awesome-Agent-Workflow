/**
 * realRuntime 装配测试的脚本化 AcpSession 替身。
 *
 * 单独成模块的原因：vi.mock 工厂不能引用测试文件里后置声明的顶层变量，
 * 工厂与用例双方都 import 本模块，即可共享同一段脚本状态。
 *
 * 脚本能力（经 fakeSessionControl 预置）：
 * - listed：session/list 返回的历史会话（可含 updatedAt 决定恢复目标）；
 * - loadShouldFail：session/load 抛错（模拟会话过期 / 能力缺失）；
 * - replayOnLoad：loadSession 成功时向事件监听器回放的事件流；
 * - newSessionId：session/new 落笔的会话 id；
 * - lastInstance：最近一次构造的实例（断言 close 等交互用）。
 */
import type {
  AcpSessionEvent,
  PermissionResponder,
} from "../../src/acp/session.ts";
import type { SessionInfo } from "../../src/acp/types.ts";

/** 用例与替身共享的脚本状态（beforeEach 里重置）。 */
export const fakeSessionControl: {
  instances: FakeAcpSession[];
  listed: SessionInfo[];
  loadShouldFail: boolean;
  replayOnLoad: AcpSessionEvent[];
  newSessionId: string;
  listShouldFail: boolean;
  closeCount: number;
  loadCalls: string[];
  lastInstance: FakeAcpSession | null;
  /** 构造时注入的权限审批回调（P0-4 分派策略的断言入口）。 */
  lastPermissionResponder: PermissionResponder | null;
} = {
  instances: [],
  listed: [],
  loadShouldFail: false,
  replayOnLoad: [],
  newSessionId: "new-session-id",
  listShouldFail: false,
  closeCount: 0,
  loadCalls: [],
  lastInstance: null,
  lastPermissionResponder: null,
};

/** 模拟 loadSession 成功时向监听器回放历史事件的公开发射器。 */
export class FakeAcpSession {
  sessionId: string | null = null;
  permissionResponder: PermissionResponder | null = null;
  private readonly listeners = new Set<(event: AcpSessionEvent) => void>();

  constructor(
    /** AcpSession 构造首参是 transport（替身不消费，仅占位对齐签名）。 */
    _transport: unknown,
    options: { onPermissionRequest?: PermissionResponder } = {},
  ) {
    fakeSessionControl.instances.push(this);
    fakeSessionControl.lastInstance = this;
    this.permissionResponder = options.onPermissionRequest ?? null;
    fakeSessionControl.lastPermissionResponder =
      options.onPermissionRequest ?? null;
  }

  initialize(): Promise<{
    protocolVersion: number;
    agentInfo: { name: string };
    agentCapabilities: Record<string, never>;
  }> {
    return Promise.resolve({
      protocolVersion: 1,
      agentInfo: { name: "chrys" },
      agentCapabilities: {},
    });
  }

  listSessions(): Promise<{ sessions: SessionInfo[]; nextCursor?: string }> {
    if (fakeSessionControl.listShouldFail) {
      return Promise.reject(new Error("session/list 不可用"));
    }
    return Promise.resolve({ sessions: fakeSessionControl.listed });
  }

  loadSession(sessionId: string): Promise<{
    modes: null;
    models: null;
  }> {
    fakeSessionControl.loadCalls.push(sessionId);
    if (fakeSessionControl.loadShouldFail) {
      return Promise.reject(new Error("会话已过期，无法恢复"));
    }
    this.sessionId = sessionId;
    for (const event of fakeSessionControl.replayOnLoad) {
      this.emit(event);
    }
    return Promise.resolve({ modes: null, models: null });
  }

  newSession(): Promise<{
    sessionId: string;
    modes: null;
    models: null;
  }> {
    this.sessionId = fakeSessionControl.newSessionId;
    return Promise.resolve({
      sessionId: this.sessionId,
      modes: null,
      models: null,
    });
  }

  onEvent(listener: (event: AcpSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  prompt(): Promise<{ stopReason: "end_turn" }> {
    return Promise.resolve({ stopReason: "end_turn" });
  }

  cancel(): void {}

  close(): Promise<{
    sessionClose: "skipped";
    exit: { code: number | null; signal: number | null };
  }> {
    fakeSessionControl.closeCount += 1;
    return Promise.resolve({
      sessionClose: "skipped",
      exit: { code: 0, signal: null },
    });
  }

  /** 向事件监听器广播（模拟 agent 通知流）。 */
  emit(event: AcpSessionEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }
}

/** 重置脚本状态（用例 beforeEach 调用）。 */
export function resetFakeSessionControl(): void {
  fakeSessionControl.instances = [];
  fakeSessionControl.listed = [];
  fakeSessionControl.loadShouldFail = false;
  fakeSessionControl.replayOnLoad = [];
  fakeSessionControl.newSessionId = "new-session-id";
  fakeSessionControl.listShouldFail = false;
  fakeSessionControl.closeCount = 0;
  fakeSessionControl.loadCalls = [];
  fakeSessionControl.lastInstance = null;
  fakeSessionControl.lastPermissionResponder = null;
}
