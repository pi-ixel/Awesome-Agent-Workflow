const privateKey =
  /password|token|secret|authorization|cookie|api[_-]?key|private[_-]?key|prompt|content|payload|stdin|stdout|stderr|args|^text$|^line$/i;
export function redactText(value: string): string {
  return value
    .slice(0, 4096)
    .replace(
      /(bearer\s+|(?:password|token|secret|authorization|api[_-]?key)["']?\s*[=:]\s*["']?(?:bearer\s+)?)[^\s"',;}]+/gi,
      "$1[REDACTED]",
    )
    .replace(/https?:\/\/[^\s]+/g, (url) =>
      url.includes("@") ? "[REDACTED URL]" : url.split(/[?#]/)[0]!,
    );
}
export function redactAcpRaw(value: string): string {
  return value.replace(/(bearer\s+)[^\s"',;}\\]+/gi, "$1[REDACTED]");
}

/** Agent 的连接错误可能回显完整地址、请求头或命令参数。 */
export function mcpFailureMessage(error: unknown): string {
  const message = typeof error === "string" ? error : "";
  if (/401|403|unauthori[sz]ed|forbidden|authenticat/i.test(message))
    return "认证失败或服务拒绝了访问";
  if (/timed?\s*out|timeout|超时/i.test(message)) return "连接超时";
  if (/tls|certificate|ssl|证书/i.test(message))
    return "TLS 或服务证书校验失败";
  if (
    /connection refused|unreachable|dns|name resolution|network/i.test(message)
  )
    return "无法连接服务器，请检查地址和网络";
  if (/404|not found/i.test(message)) return "找不到 MCP 服务端点";
  if (/invalid|protocol|content.type/i.test(message))
    return "服务的 MCP 协议响应无效";
  return "MCP 服务连接或初始化失败";
}
export function redactContext(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[truncated]";
  if (typeof value === "string") return redactText(value);
  if (value instanceof Error)
    return {
      name: value.name,
      message: redactText(value.message),
      stack: redactText(value.stack ?? ""),
    };
  if (Array.isArray(value))
    return value.slice(0, 20).map((v) => redactContext(v, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 40)
        .map(([k, v]) => [
          k,
          privateKey.test(k) ? "[REDACTED]" : redactContext(v, depth + 1),
        ]),
    );
  return typeof value === "bigint" ? String(value) : value;
}
