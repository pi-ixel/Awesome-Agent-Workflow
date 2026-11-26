import type { Context } from "cordis";
import type {} from "../service.ts";
import { createLogger } from "../../../shared/logging/logger.ts";
import type { MarkdownCodeRendererProps } from "../../../shared/ui/markdown/codeRenderers.ts";
import { VisualBlock } from "../render/VisualBlock.tsx";

export const name = "visual-workbench";
export const inject = ["workbench", "visual"];

export function apply(ctx: Context): void {
  const logger = createLogger("visual");
  const openExternal = (url: string) => {
    ctx.workbench.openExternal(url).catch((error: unknown) => {
      logger.warn("讲解图链接打开失败", {
        url,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    });
  };
  function VisualBlockView(props: MarkdownCodeRendererProps) {
    return <VisualBlock {...props} openExternal={openExternal} />;
  }
  ctx.effect(
    () =>
      ctx.workbench.register("markdownCodeRenderers", {
        id: "visual",
        languages: ctx.visual.languages,
        View: VisualBlockView,
      }),
    "visual:markdown",
  );
}
