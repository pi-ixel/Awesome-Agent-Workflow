import { createRoot } from "react-dom/client";
import { ToolPreview } from "../../src/plugins/tools/ui/ToolPreview.tsx";
import { sampleTool } from "../fixtures/sampleTool.ts";
import "../../src/shared/styles/index.css";

createRoot(document.getElementById("root")!).render(
  <div className="h-screen">
    <ToolPreview
      embedded
      tool={{
        ...sampleTool,
        name: "页面工具预览",
        html: "<main>资源加载验证</main>",
      }}
    />
  </div>,
);
