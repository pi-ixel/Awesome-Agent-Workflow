import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

export async function verifyPromptLatency({
  evaluate,
  invoke,
  waitFor,
  workspace,
}) {
  await evaluate(invoke("browser_set_agent_control", { enabled: true }));
  const newSession = 'button[aria-label="新建会话"]';
  await waitFor("工作台初始化", () =>
    evaluate(`Boolean(document.querySelector('${newSession}'))`),
  );
  await evaluate(`document.querySelector('${newSession}').click()`);
  await waitFor("选择隔离项目", () =>
    evaluate(`(() => {
    const row = [...document.querySelectorAll('[aria-label="选择项目开始新会话"] button')]
      .find(b => b.innerText.includes(${JSON.stringify(basename(workspace))}));
    row?.click(); return Boolean(row);
  })()`),
  );
  const input = 'textarea[aria-label="消息输入框"]';
  const button = 'button[aria-label="发送"]:not(:disabled)';
  const receipts = async () => {
    try {
      const data = await readFile(
        join(workspace, "..", "prompt-receipts.jsonl"),
        "utf8",
      );
      return data
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  };
  // 首条消息可触发 session/new。后续测量同一已连接会话，并经过真实浏览器轮次收尾。
  let sessionId;
  for (const [index, entry] of ["预热", "按钮", "Enter"].entries()) {
    const text = "发送延迟测试 " + entry;
    await waitFor("可用的消息输入框", () =>
      evaluate(
        `Boolean(document.querySelector('${input}') && !window.__aawSessionStore.getState().isAgentRunning)`,
      ),
    );
    await evaluate(`(() => {
      const input = document.querySelector('${input}');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await waitFor("启用发送按钮", () =>
      evaluate(`Boolean(document.querySelector('${button}'))`),
    );
    const submittedAt = await evaluate(`(() => {
      const input = document.querySelector('${input}');
      const button = document.querySelector('${button}');
      const at = Date.now();
      ${entry === "Enter" ? 'input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));' : "button.click();"}
      return at;
    })()`);
    try {
      await waitFor(
        "Agent stdin 回执",
        async () => (await receipts()).length > index,
      );
    } catch (error) {
      const state = await evaluate(`(() => {
        const s = window.__aawSessionStore.getState();
        return { id: s.activeSessionId, error: s.lastError, running: s.isAgentRunning,
          messages: s.items.slice(-3), text: document.body.innerText.slice(-700) };
      })()`);
      throw new Error(JSON.stringify(state), { cause: error });
    }
    const rows = await receipts();
    assert.equal(rows.length, index + 1);
    const receipt = rows[index];
    assert.ok(
      receipt.prompt.some(
        (block) => block.type === "text" && block.text === text,
      ),
    );
    assert.equal(receipt.browser, true, "ACP 会话必须已收到内置浏览器 MCP");
    sessionId ??= receipt.sessionId;
    assert.equal(receipt.sessionId, sessionId);
    assert.equal(
      await evaluate(invoke("browser_mcp_status", { sessionId })),
      "active",
    );
    const ms = receipt.receivedAt - submittedAt;
    console.log(`${entry}：输入框到 Agent stdin ${ms} ms`);
    if (index) assert.ok(ms >= 0 && ms <= 500, `${entry}发送耗时 ${ms} ms`);
    await waitFor("回合结束", () =>
      evaluate("!window.__aawSessionStore.getState().isAgentRunning"),
    );
  }
}
