/**
 * 会话回放脚本（测试夹具）：经 sessionStore 的真实公开 action
 * （setSessionMeta / beginTurn / handleEvent / endTurn）重放一段完整会话，
 * 事件载荷形状对照 chrys 的 session/update 通知（skill-eval 的 wire 样本
 * 同源）。供 store 与 UI 回归测试复用。
 */
import type { AcpSessionEvent } from "../../src/runtime/acpBase/protocol/session.ts";
import { useSessionStore } from "../../src/stores/sessionStore.ts";

/** 回放中注入的会话事件（与 chrys 实际下发同形状）。 */
const SAMPLE_EVENTS: readonly AcpSessionEvent[] = [
  {
    type: "agent_thought_chunk",
    sessionId: "s1",
    text: "401 通常是鉴权中间件或过期凭据；先定位登录接口与测试夹具。",
  },
  {
    type: "agent_message_chunk",
    sessionId: "s1",
    text: "我先定位登录接口的定义与相关测试。",
  },
  {
    type: "tool_call",
    sessionId: "s1",
    toolCallId: "tool-1",
    title: 'search "login"',
    kind: "search",
    status: "in_progress",
    rawInput: { pattern: "login", path: "src/api" },
  },
  {
    type: "tool_call_update",
    sessionId: "s1",
    toolCallId: "tool-1",
    status: "completed",
    rawOutput: "src/api/login.ts、tests/login.test.ts 共 2 处命中",
  },
  {
    type: "tool_call",
    sessionId: "s1",
    toolCallId: "tool-2",
    title: "read src/api/login.ts",
    kind: "read",
    status: "in_progress",
    rawInput: { path: "src/api/login.ts" },
  },
  {
    type: "tool_call_update",
    sessionId: "s1",
    toolCallId: "tool-2",
    status: "completed",
    rawOutput: "接口从 Bearer token 解出 userId 后校验过期时间……",
  },
  {
    type: "agent_message_chunk",
    sessionId: "s1",
    text: [
      "定位到了：`login.ts` 的 token 校验只看签名不看过期时间，而测试夹具里的",
      "token 已经过期。建议这样验证：",
      "",
      "```bash",
      "curl -s -X POST localhost:3000/api/login \\",
      '  -H "Content-Type: application/json" \\',
      '  -d \'{"name":"demo","token":"expired"}\' -w "%{http_code}"',
      "```",
      "",
      "接下来我会更新测试夹具里的过期 token，并补一条过期路径的断言。",
    ].join("\n"),
  },
  {
    type: "tool_call",
    sessionId: "s1",
    toolCallId: "tool-3",
    title: "load skill",
    kind: "other",
    status: "in_progress",
    rawInput: { skill_name: "test-writer", scope: "project" },
  },
  {
    type: "tool_call_update",
    sessionId: "s1",
    toolCallId: "tool-3",
    status: "completed",
    rawOutput: "技能 test-writer 已加载",
  },
  {
    type: "agent_message_chunk",
    sessionId: "s1",
    text: "已按 `test-writer` 技能的约定补好断言，过期 token 的用例现在返回 401。",
  },
];

/**
 * 回放一轮完整会话：元信息回填 → 用户消息落笔（轮次开始）→ 事件流折叠 →
 * 轮次收尾。全部走 store 的真实归约通路，产生的状态与真实运行一致。
 */
export function replaySampleConversation(): void {
  const store = useSessionStore.getState();
  store.setSessionMeta({
    modelLabel: "glm-4.7-coding",
    approvalMode: { id: "manual", name: "Manual" },
  });
  store.beginTurn(
    "帮我看下登录接口为什么返回 401，必要时改掉测试里的过期 token。",
  );
  for (const event of SAMPLE_EVENTS) {
    store.handleEvent(event);
  }
  store.endTurn({ stopReason: "end_turn" });
}
