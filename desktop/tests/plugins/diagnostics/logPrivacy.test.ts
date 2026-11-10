import { expect, it, vi } from "vitest";
import { LogSink } from "../../../src/plugins/diagnostics/capture/logSink.ts";

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
