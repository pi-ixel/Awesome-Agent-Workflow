import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/shared/styles/index.css";
import { MarkdownView } from "../../src/shared/ui/MarkdownView.tsx";
import { MarkdownAppearance } from "../../src/shared/ui/markdown/theme.ts";
import {
  MarkdownCodeRenderers,
  type MarkdownCodeRenderer,
} from "../../src/shared/ui/markdown/codeRenderers.ts";
import { VisualBlock } from "../../src/plugins/visual/render/VisualBlock.tsx";
import { visualSamples } from "./visualExplainSamples.ts";

declare global {
  interface Window {
    __visualOpened: string[];
    __visualMountedAt: number;
  }
}

const params = new URLSearchParams(location.search);
const only = params.get("only");
const perf = Number(params.get("perf") ?? 0);
const width = Number(params.get("width") ?? 760);
/** 基线：同样内容按普通代码块渲染。 */
const isPlain = params.has("plain");
window.__visualOpened = [];

const renderer: MarkdownCodeRenderer = {
  id: "visual",
  languages: ["visual"],
  View: (props) => (
    <VisualBlock
      {...props}
      openExternal={(url) => window.__visualOpened.push(url)}
    />
  ),
};

function messageFor(id: string, code: string, index: number): string {
  return `### ${index + 1}. ${id}\n\n这是讲解图前面的正文说明。\n\n\`\`\`visual\n${code}\n\`\`\`\n\n讲解图后面继续正文。`;
}

/** 渲染外部 Markdown（真实 Agent 回答），逗号分隔多个地址。 */
const markdownUrls = params.get("md")?.split(",") ?? [];
const fetched = await Promise.all(
  markdownUrls.map((url) => fetch(url).then((response) => response.text())),
);

const messages =
  fetched.length > 0
    ? fetched
    : perf > 0
      ? Array.from({ length: perf }, (_, index) => {
          const sample = visualSamples[index % visualSamples.length]!;
          // 每条内容不同，避免解析缓存把性能测成命中缓存
          return messageFor(
            sample.id,
            `${sample.code}\n<!-- ${index} -->`,
            index,
          );
        })
      : visualSamples
          .filter((sample) => only === null || sample.id === only)
          .map((sample, index) => messageFor(sample.id, sample.code, index));

function Fixture() {
  const [theme, setTheme] = useState<"dark" | "warm">(
    params.get("theme") === "dark" ? "dark" : "warm",
  );
  const toggle = () => {
    const next = theme === "dark" ? "warm" : "dark";
    setTheme(next);
    // 模拟应用的 View Transition：主题类晚于状态更新、异步切换
    window.setTimeout(
      () =>
        document.documentElement.classList.toggle(
          "theme-warm",
          next === "warm",
        ),
      150,
    );
  };
  return (
    <MarkdownAppearance value={{ theme, uiFontSize: 14 }}>
      <MarkdownCodeRenderers.Provider value={isPlain ? [] : [renderer]}>
        <div className="min-h-screen bg-base p-4 text-ink">
          <button
            type="button"
            onClick={toggle}
            className="mb-4 rounded border border-line px-2"
          >
            切换主题
          </button>
          <div
            data-testid="messages"
            style={{ width, maxWidth: "100%" }}
            className="text-ui-base"
          >
            {messages.map((text, index) => (
              <div key={index} data-message={index} className="mb-6">
                <MarkdownView text={text} canUseCodeRenderers />
              </div>
            ))}
          </div>
        </div>
      </MarkdownCodeRenderers.Provider>
    </MarkdownAppearance>
  );
}

if (params.get("theme") === "dark")
  document.documentElement.classList.remove("theme-warm");
const started = performance.now();
createRoot(document.getElementById("root")!).render(<Fixture />);
requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    window.__visualMountedAt = performance.now() - started;
  }),
);
