import { useEffect, useState, type ReactNode } from "react";
import { BrandLoading } from "../../../shared/ui/BrandLoading.tsx";
import { WindowControls } from "./WindowControls.tsx";
import { useWorkbenchEntries } from "./bindings/react.ts";
import "./StartupGate.css";

const STARTUP_ANIMATION_MS = 1_200;

function StartupScreen() {
  return (
    <section className="startup-screen" aria-label="正在准备工作区">
      <div className="startup-titlebar" data-tauri-drag-region="">
        <WindowControls />
      </div>
      <BrandLoading caption="正在准备你的工作区" />
    </section>
  );
}

export function StartupGate({ children }: { readonly children: ReactNode }) {
  const source = useWorkbenchEntries("startup")[0];
  const [initialSource] = useState(() =>
    source?.shouldPlay() &&
    !window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
      ? source
      : undefined,
  );
  const [playing, setPlaying] = useState(initialSource !== undefined);
  if (playing && source !== initialSource) setPlaying(false);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(
      () => setPlaying(false),
      STARTUP_ANIMATION_MS,
    );
    return () => window.clearTimeout(timer);
  }, [playing]);

  if (playing && source === initialSource) return <StartupScreen />;
  return (
    <div
      className={`flex min-h-0 flex-1 flex-col overflow-hidden${initialSource ? " startup-workspace-enter" : ""}`}
    >
      {children}
    </div>
  );
}
