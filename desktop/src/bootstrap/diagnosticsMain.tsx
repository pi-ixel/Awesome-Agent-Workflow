import React from "react";
import { createRoot } from "react-dom/client";
import { Context } from "cordis";
import type { DiagnosticsService } from "../contracts/diagnostics.ts";
import { DiagnosticsWindow } from "../plugins/diagnostics/ui/DiagnosticsWindow.tsx";
import { installDesktopFoundation } from "./foundation.ts";
import "../shared/styles/index.css";

const context = new Context();
const root = createRoot(document.getElementById("root")!);
const ready = installDesktopFoundation(context);
let closed = false;
let unsubscribe: (() => void) | undefined;

function close() {
  if (closed) return;
  closed = true;
  unsubscribe?.();
  window.removeEventListener("pagehide", close);
  root.unmount();
  void ready
    .catch(() => {})
    .then(() => context.fiber.dispose())
    .catch((error: unknown) => console.error("诊断窗口释放失败", error));
}

window.addEventListener("pagehide", close, { once: true });
import.meta.hot?.dispose(close);
void ready
  .then(() => {
    if (closed) return;
    let mounted: DiagnosticsService | undefined;
    let generation = 0;
    const render = () => {
      const diagnostics = context.diagnostics;
      if (diagnostics === mounted) return;
      mounted = diagnostics;
      if (diagnostics)
        document.documentElement.classList.toggle(
          "theme-warm",
          diagnostics.startupTheme() === "warm",
        );
      root.render(
        diagnostics ? (
          <React.StrictMode>
            <DiagnosticsWindow key={++generation} reader={diagnostics.reader} />
          </React.StrictMode>
        ) : null,
      );
    };
    unsubscribe = context.on("internal/service", (name) => {
      if (name === "diagnostics") render();
    });
    render();
  })
  .catch((error: unknown) => {
    close();
    console.error("诊断窗口启动失败", error);
  });
