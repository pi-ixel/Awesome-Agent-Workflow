import { createRoot } from "react-dom/client";
import { ToolPreview } from "../../src/plugins/tools/ui/ToolPreview.tsx";
import { sampleTool } from "../fixtures/sampleTool.ts";
import "../../src/shared/styles/index.css";

const mode = new URLSearchParams(location.search).get("network");
const network =
  mode === "offline"
    ? false
    : mode === "hosts"
      ? { hosts: ["*.allowed.tool.test"] }
      : mode === "open"
        ? true
        : undefined;

createRoot(document.getElementById("root")!).render(
  <div className="h-screen">
    <ToolPreview
      embedded
      tool={{
        ...sampleTool,
        name: "工具联网限制",
        permissions: network === undefined ? undefined : { network },
        html: "<main>网络策略验证</main>",
      }}
    />
  </div>,
);
