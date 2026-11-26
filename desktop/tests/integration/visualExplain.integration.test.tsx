import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { installDesktopWorkbench } from "../../src/bootstrap/installDesktopWorkbench.ts";
import { MarkdownView } from "../../src/shared/ui/MarkdownView.tsx";
import { MarkdownCodeRenderers } from "../../src/shared/ui/markdown/codeRenderers.ts";
import { createTestDesktopRuntime } from "../helpers/desktopRuntime.ts";

it("生产装配登记 ```visual 渲染器，会话 Markdown 渲染出讲解图", async () => {
  const runtime = createTestDesktopRuntime(
    { attachPreloading: () => () => {}, close: () => Promise.resolve() },
    undefined,
    (context) => installDesktopWorkbench(context),
  );
  try {
    const { workbench } = await runtime.ready;
    const renderers = workbench.getSnapshot().markdownCodeRenderers;
    expect(renderers.map(({ id, languages }) => ({ id, languages }))).toEqual([
      { id: "visual", languages: ["visual"] },
    ]);
    const { container } = render(
      <MarkdownCodeRenderers.Provider value={renderers}>
        <MarkdownView
          text={'说明\n\n```visual\n<v-box title="存储"></v-box>\n```'}
          canUseCodeRenderers
        />
      </MarkdownCodeRenderers.Provider>,
    );
    const host = container.querySelector(
      'figure[data-visual] [data-visual-mode="inline"]',
    );
    expect(host?.shadowRoot?.querySelector("v-box .v-title")).toHaveTextContent(
      "存储",
    );
  } finally {
    await runtime.shutdown();
  }
});
