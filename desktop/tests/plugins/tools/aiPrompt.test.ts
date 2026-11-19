import { expect, it } from "vitest";
import { developerPrompt, extractToolPackage } from "../../../src/plugins/tools/ui/aiPrompt.ts";
import { parseToolPackage } from "../../../src/plugins/tools/runtime/package.ts";

const tool = {
  schemaVersion: 1,
  id: "word-count",
  name: "字数统计",
  version: "1.0.0",
  html: "<p>{不是 JSON 的花括号}</p>",
};

it("pulls the JSON object out of an AI reply that also contains prose and a code fence", () => {
  const reply = `好的，下面是一个字数统计工具：

\`\`\`json
${JSON.stringify(tool)}
\`\`\`

用法：安装后在输入框里粘贴文本即可。`;
  const result = extractToolPackage(reply);
  expect("json" in result).toBe(true);
  if (!("json" in result)) return;
  expect(JSON.parse(result.json)).toMatchObject({ id: "word-count" });
  // 提取出来的文本必须能直接进解析器——否则"粘贴即可安装"这个承诺是空的。
  expect(parseToolPackage(result.json).id).toBe("word-count");
});

it("accepts bare JSON, and does not mistake braces inside the html for the object boundary", () => {
  const result = extractToolPackage(JSON.stringify(tool));
  expect("json" in result).toBe(true);
  if (!("json" in result)) return;
  expect(parseToolPackage(result.json).html).toBe(tool.html);
});

it("explains what went wrong instead of failing silently", () => {
  const empty = extractToolPackage("");
  expect("error" in empty).toBe(true);
  if ("error" in empty) expect(empty.error).toContain("输入为空");
  const prose = extractToolPackage("抱歉，我无法完成这个请求。");
  expect("error" in prose).toBe(true);
  if ("error" in prose) expect(prose.error).toContain("没找到 JSON");
  const broken = extractToolPackage('{"id": "x",}');
  expect("error" in broken && broken.error).toContain("不是有效 JSON");
  const notObject = extractToolPackage("```json\n[1, 2, 3]\n```");
  expect("error" in notObject && notObject.error).toContain("必须是一个");
});

it("ships a prompt whose embedded example is itself a valid package", () => {
  const prompt = developerPrompt();
  for (const field of ["schemaVersion", "id", "name", "version", "html", "actions", "settingsSchema", "window.aawActions", "window.aawSettings"])
    expect(prompt).toContain(field);
  const fenced = /```json\s*\n([\s\S]*?)```/.exec(prompt)?.[1]?.trim();
  expect(fenced).toBeTruthy();
  // 提示词里的示例必须是合法清单：AI 会照抄它。
  const example = parseToolPackage(fenced!);
  expect(example.id).toBe("word-count");
  expect(example.actions?.[0]?.id).toBe("count");
});
