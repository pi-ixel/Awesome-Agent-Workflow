import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { MarkdownView } from "../../../src/shared/ui/MarkdownView.tsx";
import { FileMarkdownPreview } from "../../../src/plugins/documents/ui/FileMarkdownPreview.tsx";
import {
  MarkdownCodeRenderers,
  type MarkdownCodeRenderer,
  type MarkdownCodeRendererProps,
} from "../../../src/shared/ui/markdown/codeRenderers.ts";
import { VisualBlock } from "../../../src/plugins/visual/render/VisualBlock.tsx";
import { planVisual } from "../../../src/plugins/visual/render/plan.ts";
import {
  buildVisualFrameDocument,
  isVisualFrameMessage,
} from "../../../src/plugins/visual/render/frameDocument.ts";

const theme = {
  vars: { "--v-ink": "#111" },
  fontFamily: "sans-serif",
  textSize: "14px",
  colorScheme: "light",
};

it("不含脚本的讲解图走内联路径，并丢弃会改动宿主的元素", () => {
  const plan = planVisual(
    '<v-box title="A"><iframe src="https://x.test"></iframe><base href="/"><style>.a{}</style><a href="https://x.test">x</a></v-box>',
  );
  expect(plan.mode).toBe("inline");
  if (plan.mode !== "inline") return;
  const content = plan.template.content;
  expect(content.querySelector("iframe")).toBeNull();
  expect(content.querySelector("base")).toBeNull();
  expect(content.querySelector("style")).not.toBeNull();
  expect(content.querySelector("a")).not.toBeNull();
});

it.each([
  ['<div id="a"></div><script>a.textContent = 1</script>'],
  ['<button onclick="go()">go</button>'],
  ['<a href="javascript:alert(1)">x</a>'],
  ['<form><input name="q"></form>'],
  ['<svg><circle onmouseover="x()" r="4"/></svg>'],
  ["<template><script>1</script></template>"],
])("含脚本能力的讲解图走沙箱路径：%s", (code) => {
  expect(planVisual(code).mode).toBe("frame");
});

it("沙箱文档带 CSP、主题、桥接与套件脚本，且套件在正文之后执行", () => {
  const html = buildVisualFrameDocument(
    '<v-box title="T"></v-box><script>1</script>',
    theme,
  );
  expect(html).toContain("default-src 'none'");
  expect(html).toContain("--v-ink:#111;");
  expect(html).toContain("color-scheme:light;");
  expect(html.indexOf('<v-box title="T">')).toBeLessThan(
    html.lastIndexOf("customElements"),
  );
  expect(html.indexOf("ResizeObserver")).toBeLessThan(
    html.indexOf('<v-box title="T">'),
  );
  expect(html).not.toMatch(
    /<\/script>[^]*<\/script>[^]*<\/script>[^]*<\/script>/,
  );
});

it("只接受带标记且形状正确的 iframe 消息", () => {
  expect(
    isVisualFrameMessage({ __aawVisual: 1, type: "height", height: 120 }),
  ).toBe(true);
  expect(
    isVisualFrameMessage({
      __aawVisual: 1,
      type: "open",
      url: "https://a.test",
    }),
  ).toBe(true);
  expect(isVisualFrameMessage({ type: "height", height: 120 })).toBe(false);
  expect(
    isVisualFrameMessage({ __aawVisual: 1, type: "height", height: "1" }),
  ).toBe(false);
  expect(isVisualFrameMessage({ __aawVisual: 1, type: "navigate" })).toBe(
    false,
  );
});

it("Markdown 把注册语言的围栏交给渲染器，流式未闭合时标记为未完成", () => {
  const seen: MarkdownCodeRendererProps[] = [];
  const renderer: MarkdownCodeRenderer = {
    id: "test",
    languages: ["visual"],
    View: (props) => {
      seen.push(props);
      return (
        <div data-testid="custom">{props.isComplete ? "done" : "pending"}</div>
      );
    },
  };
  const { rerender } = render(
    <MarkdownCodeRenderers.Provider value={[renderer]}>
      <MarkdownView
        text={"前文\n\n```visual\n<v-box"}
        streaming
        canUseCodeRenderers
      />
    </MarkdownCodeRenderers.Provider>,
  );
  expect(screen.getByTestId("custom")).toHaveTextContent("pending");
  rerender(
    <MarkdownCodeRenderers.Provider value={[renderer]}>
      <MarkdownView
        text={
          "前文\n\n```visual\n<v-box></v-box>\n```\n\n```ts\nconst a = 1;\n```"
        }
        canUseCodeRenderers
      />
    </MarkdownCodeRenderers.Provider>,
  );
  expect(screen.getByTestId("custom")).toHaveTextContent("done");
  expect(seen.at(-1)?.code).toBe("<v-box></v-box>");
  expect(seen.at(-1)?.language).toBe("visual");
  expect(screen.getByText("ts")).toBeInTheDocument();
});

it("未注册渲染器的窗口照常显示代码块", () => {
  render(<MarkdownView text={"```visual\n<v-box></v-box>\n```"} />);
  expect(screen.getByText("visual")).toBeInTheDocument();
});

it("非 Agent 回答的 Markdown（仓库文件、更新说明）不使用渲染器", () => {
  const renderer: MarkdownCodeRenderer = {
    id: "test",
    languages: ["visual"],
    View: () => <div data-testid="custom" />,
  };
  render(
    <MarkdownCodeRenderers.Provider value={[renderer]}>
      <MarkdownView text={"```visual\n<v-box></v-box>\n```"} />
    </MarkdownCodeRenderers.Provider>,
  );
  expect(screen.queryByTestId("custom")).not.toBeInTheDocument();
  expect(screen.getByText("visual")).toBeInTheDocument();
});

it("消息流式期间带脚本的讲解图只占位，结束后才建 iframe；内联图照常显示", () => {
  const script = '<div id="a"></div><script>a.textContent = 1</script>';
  const { container, rerender } = render(
    <VisualBlock
      code={script}
      language="visual"
      isComplete
      isStreaming
      openExternal={() => {}}
    />,
  );
  expect(container.querySelector("iframe")).toBeNull();
  expect(
    screen.getByRole("status", { name: "讲解图生成中" }),
  ).toBeInTheDocument();
  rerender(
    <VisualBlock
      code={script}
      language="visual"
      isComplete
      isStreaming={false}
      openExternal={() => {}}
    />,
  );
  expect(container.querySelector("iframe")).not.toBeNull();
  rerender(
    <VisualBlock
      code="<v-note>结论</v-note>"
      language="visual"
      isComplete
      isStreaming
      openExternal={() => {}}
    />,
  );
  expect(container.querySelector('[data-visual-mode="inline"]')).not.toBeNull();
});

it("内联讲解图挂进 Shadow DOM，链接交给外部浏览器打开", () => {
  const openExternal = vi.fn();
  const { container } = render(
    <VisualBlock
      code={
        '<v-box title="客户端"><v-item icon="zip">ZIP</v-item><a href="https://example.test/doc">文档</a></v-box>'
      }
      language="visual"
      isComplete
      isStreaming={false}
      openExternal={openExternal}
    />,
  );
  const host = container.querySelector('[data-visual-mode="inline"]')!;
  const root = host.shadowRoot!;
  expect(root.querySelector(".v-root v-box .v-head")).toHaveTextContent(
    "客户端",
  );
  expect(root.querySelector("v-item .v-glyph svg")).not.toBeNull();
  fireEvent.click(root.querySelector("a")!);
  expect(openExternal).toHaveBeenCalledWith("https://example.test/doc");
});

it("内联图拦截一切链接激活：SVG 链接、图片热区、中键，主窗口不导航", () => {
  const openExternal = vi.fn();
  const { container } = render(
    <VisualBlock
      code={
        '<svg viewBox="0 0 100 20"><a href="https://svg.test/"><text>S</text></a></svg>' +
        '<map name="m"><area shape="rect" coords="0,0,9,9" href="https://area.test/"></map>' +
        '<a href="https://mid.test/">M</a><a href="/relative">R</a>'
      }
      language="visual"
      isComplete
      isStreaming={false}
      openExternal={openExternal}
    />,
  );
  const root = container.querySelector(
    '[data-visual-mode="inline"]',
  )!.shadowRoot!;
  const activate = (target: Element, init?: MouseEventInit, type = "click") => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      ...init,
    });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  expect(activate(root.querySelector("svg text")!)).toBe(true);
  expect(activate(root.querySelector("area")!)).toBe(true);
  expect(
    activate(
      root.querySelector('a[href^="https://mid"]')!,
      { button: 1 },
      "auxclick",
    ),
  ).toBe(true);
  expect(activate(root.querySelector('a[href="/relative"]')!)).toBe(true);
  expect(openExternal.mock.calls).toEqual([
    ["https://svg.test/"],
    ["https://area.test/"],
    ["https://mid.test/"],
  ]);
});

it("用 SVG 动画改写链接地址的讲解图进沙箱", () => {
  expect(
    planVisual(
      '<svg><a><set attributeName="href" to="https://x.test"/><text>x</text></a></svg>',
    ).mode,
  ).toBe("frame");
  expect(
    planVisual(
      '<svg><circle r="4"><animate attributeName="r" values="4;6"/></circle></svg>',
    ).mode,
  ).toBe("inline");
});

it("沙箱消息：高度有上限，脚本自发的打开请求被限频且只放行 http(s)", () => {
  const openExternal = vi.fn();
  const { container } = render(
    <VisualBlock
      code={'<div id="a"></div><script>a.textContent = 1</script>'}
      language="visual"
      isComplete
      isStreaming={false}
      openExternal={openExternal}
    />,
  );
  const frame = container.querySelector("iframe")!;
  const send = (data: Record<string, unknown>) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { __aawVisual: 1, ...data },
          source: frame.contentWindow,
        }),
      );
    });
  send({ type: "height", height: 99_999 });
  expect(
    container.querySelector<HTMLElement>('[data-visual-mode="frame"]')!.style
      .height,
  ).toBe("2400px");
  send({ type: "open", url: "file:///C:/x" });
  send({ type: "open", url: "https://a.test/" });
  send({ type: "open", url: "https://b.test/" });
  expect(openExternal.mock.calls).toEqual([["https://a.test/"]]);
});

it("含脚本的讲解图进沙箱 iframe，只授予脚本权限", () => {
  const { container } = render(
    <VisualBlock
      code={'<input type="range" id="r"><script>r.oninput = () => {}</script>'}
      language="visual"
      isComplete
      isStreaming={false}
      openExternal={() => {}}
    />,
  );
  const frame = container.querySelector("iframe")!;
  expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  expect(frame.getAttribute("srcdoc")).toContain('<input type="range" id="r">');
});

it("没有任何元素的源码（自创文本记法）按原样显示，不挤成一段", () => {
  const code = "flow LR A[客户端] --> B[DNS]\nB --> C[负载均衡]";
  expect(planVisual(code).mode).toBe("text");
  expect(
    planVisual("flow LR A[客户端<br/>浏览器] --> B[<b>DNS</b>]").mode,
  ).toBe("text");
  expect(planVisual("<p>一段说明</p>").mode).toBe("inline");
  expect(planVisual("<span>标签</span><v-tag>x</v-tag>").mode).toBe("inline");
  const { container } = render(
    <VisualBlock
      code={code}
      language="visual"
      isComplete
      isStreaming={false}
      openExternal={() => {}}
    />,
  );
  const pre = container.querySelector('pre[data-visual-mode="text"]');
  expect(pre?.textContent).toBe(code);
  expect(
    screen.queryByRole("button", { name: "查看源码" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "复制源码" })).toBeInTheDocument();
});

it("流式期显示占位，可切换查看源码", () => {
  const { rerender } = render(
    <VisualBlock
      code="<v-box"
      language="visual"
      isComplete={false}
      isStreaming
      openExternal={() => {}}
    />,
  );
  expect(
    screen.getByRole("status", { name: "讲解图生成中" }),
  ).toBeInTheDocument();
  rerender(
    <VisualBlock
      code="<v-note>结论</v-note>"
      language="visual"
      isComplete
      isStreaming={false}
      openExternal={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
  expect(screen.getByText("<v-note>结论</v-note>")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "显示讲解图" }));
  expect(screen.queryByText("<v-note>结论</v-note>")).not.toBeInTheDocument();
});

it("文件预览里 Agent 写进 .md 的讲解图同样渲染", () => {
  const renderer: MarkdownCodeRenderer = {
    id: "test",
    languages: ["visual"],
    View: () => <div data-testid="custom" />,
  };
  render(
    <MarkdownCodeRenderers.Provider value={[renderer]}>
      <FileMarkdownPreview text={"# 设计\n\n```visual\n<v-box></v-box>\n```"} />
    </MarkdownCodeRenderers.Provider>,
  );
  expect(screen.getByTestId("custom")).toBeInTheDocument();
});
