/** Keep non-text ACP blocks intact, including unknown future block types. */
export function nonTextContent(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(nonTextContent);
  if (!value || typeof value !== "object") return [];
  const block = value as Record<string, unknown>;
  if (block.type === "text") return [];
  if (typeof block.type === "string") return [value];
  if (block.content !== undefined) return nonTextContent(block.content);
  return typeof block.text === "string" ? [] : [value];
}

export function supportsImagePrompt(capabilities: unknown): boolean {
  if (!capabilities || typeof capabilities !== "object") return false;
  const prompt = (capabilities as Record<string, unknown>).promptCapabilities;
  return (
    !!prompt &&
    typeof prompt === "object" &&
    (prompt as Record<string, unknown>).image === true
  );
}

/**
 * 宽容抽取 chunk 文本。chrys 的 content 形状包括：
 * `{type:"text", text}`（标准）、裸字符串、`{ text }`、
 * `[{ content: { text } }]`（嵌套，见 skill-eval 测试夹具）。
 * 对齐 Python wire.py 的 chunk_text 递归。
 */
export function parseChunkText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (content === null || content === undefined) {
    return "";
  }
  if (Array.isArray(content)) {
    let out = "";
    for (const item of content) {
      out += parseChunkText(item);
    }
    return out;
  }
  if (typeof content === "object") {
    const record = content as Readonly<Record<string, unknown>>;
    const text = record["text"];
    if (typeof text === "string") {
      return text;
    }
    return parseChunkText(record["content"]);
  }
  return "";
}
