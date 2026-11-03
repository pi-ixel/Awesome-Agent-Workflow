import { expect, it, vi } from "vitest";
import { redactContext, redactText } from "../../src/core/logPrivacy.ts";
import { LogSink } from "../../src/core/logger.ts";

it("日志在进入内存和订阅前移除凭据、正文及 URL 查询", () => {
  const sink = new LogSink();
  const listener = vi.fn();
  sink.subscribeEntry(listener);
  sink.log("error", "acp", "Bearer secret-value", {
    password: "secret",
    nested: { prompt: "chat body", url: "https://example.com/a?token=private" },
    operationId: "op-1",
  });
  const encoded = JSON.stringify(sink.snapshot());
  for (const secret of ["secret-value", "chat body", "token=private"])
    expect(encoded).not.toContain(secret);
  expect(sink.snapshot()[0]?.context.operationId).toBe("op-1");
  expect(listener).toHaveBeenCalledWith(sink.snapshot()[0]);
});
it("循环和深层上下文不会阻断业务日志", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  expect(() => JSON.stringify(redactContext(circular))).not.toThrow();
});
it("错误字符串中的 JSON 密钥和 Authorization Bearer 被脱敏", () => {
  expect(
    redactText('Authorization: Bearer secret-value {"password":"json-secret"}'),
  ).not.toMatch(/secret-value|json-secret/);
});
