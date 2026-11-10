import React from "react";
import { createRoot } from "react-dom/client";
import { Context } from "cordis";
import type { DiagnosticsService } from "../plugins/diagnostics/service.ts";
import { loadWindow } from "../plugins/diagnostics/index.ts";
import { installDesktopFoundation } from "./foundation.ts";
import { LoggerContext } from "../shared/logging/react.ts";
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
void Promise.all([ready, loadWindow()])
  .then(([, DiagnosticsWindow]) => {
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
            <LoggerContext.Provider value={diagnostics.createLogger}>
              <DiagnosticsWindow key={++generation} reader={diagnostics.reader} />
            </LoggerContext.Provider>
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
