import { expect, it } from "vitest";
import { redactContext, redactText } from "../../src/shared/logging/logPrivacy.ts";



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
