import React from "react";
import { createRoot } from "react-dom/client";
import { DiagnosticsWindow } from "./ui/DiagnosticsWindow.tsx";
import "./index.css";

// Read only the persisted theme; importing the main settings store would load business modules.
try {
  const saved: unknown = JSON.parse(
    localStorage.getItem("aaw-desktop.settings.v1") ?? "null",
  );
  document.documentElement.classList.toggle(
    "theme-warm",
    !!saved &&
      typeof saved === "object" &&
      "theme" in saved &&
      saved.theme === "warm",
  );
} catch {
  /* Main-window snapshots will supply the current theme. */
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DiagnosticsWindow />
  </React.StrictMode>,
);
