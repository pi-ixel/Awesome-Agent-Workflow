import { useEffect, useRef, type ComponentProps } from "react";
import { MarkdownView } from "../session/MarkdownView.tsx";

/** Keep all text/anchors in the DOM, but let the browser skip offscreen layout.
 * This is deliberately file-preview-only: streaming chat keeps its own layout.
 */
export function FileMarkdownPreview(
  props: ComponentProps<typeof MarkdownView>,
) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const body = root.current?.querySelector("[data-markdown-theme] > div");
    if (!body || !CSS.supports?.("content-visibility", "auto")) return;
    // Small files gain little from containment. Headings stay laid out so the
    // outline can measure them without forcing every offscreen subtree open.
    const blocks = Array.from(body.children).filter(
      (node): node is HTMLElement =>
        node instanceof HTMLElement && !/^H[1-6]$/.test(node.tagName),
    );
    if (blocks.length < 80) return;
    // Read all heights before writing styles. Exact initial placeholders avoid
    // changing the initial scrollbar/outline positions to rough estimates.
    const heights = blocks.map((node) => node.getBoundingClientRect().height);
    blocks.forEach((node, i) => {
      node.style.containIntrinsicBlockSize = `auto ${heights[i]}px`;
      node.style.contentVisibility = "auto";
    });
    return () => {
      blocks.forEach((node) => {
        node.style.removeProperty("content-visibility");
        node.style.removeProperty("contain-intrinsic-block-size");
      });
    };
  }, [props.text]);
  return (
    <div ref={root} className="p-4">
      <MarkdownView {...props} />
    </div>
  );
}
