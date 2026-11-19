/**
 * 结果通道传输规则的双边契约（ADR 024 §9-3）：与引擎 session_host.rs 的
 * `result_channel_transport_rule_matches_the_shared_fixture` 读同一份
 * fixture——任何一侧改了规则，另一侧的测试就会失败。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ResultChannelOfferWire } from "../../../src/plugins/workflow/engine/protocol.ts";
import {
  agentSupportsHttpMcp,
  asResultChannelOffer,
  resultChannelServer,
} from "../../../src/plugins/workflow/sessionHost/resultChannel.ts";

const fixture = JSON.parse(
  readFileSync(
    join(process.cwd(), "workflow-engine-rs", "tests", "fixtures", "result_channel_offer.json"),
    "utf8",
  ),
) as {
  offer: ResultChannelOfferWire;
  cases: { agentSupportsHttp: boolean; expected: unknown }[];
};

describe("result channel transport rule", () => {
  it("与引擎共享 fixture 逐字一致", () => {
    expect(fixture.cases).toHaveLength(2);
    for (const item of fixture.cases) {
      expect(resultChannelServer(fixture.offer, item.agentSupportsHttp)).toEqual(item.expected);
    }
  });

  it("共享 fixture 的提供可被宿主解析", () => {
    expect(asResultChannelOffer(fixture.offer)).toEqual(fixture.offer);
  });

  it("只有 mcpCapabilities.http === true 才算声明 HTTP", () => {
    expect(agentSupportsHttpMcp({ agentCapabilities: { mcpCapabilities: { http: true } } })).toBe(true);
    expect(agentSupportsHttpMcp({ agentCapabilities: { mcpCapabilities: { http: false } } })).toBe(false);
    expect(agentSupportsHttpMcp({ agentCapabilities: { mcpCapabilities: { http: "yes" } } })).toBe(false);
    expect(agentSupportsHttpMcp({ agentCapabilities: {} })).toBe(false);
    expect(agentSupportsHttpMcp(null)).toBe(false);
  });
});
