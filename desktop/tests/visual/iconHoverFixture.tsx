import { createRoot } from "react-dom/client";
import { useRef, useState } from "react";
import {
  IconButton,
  IconHoverProvider,
  type IconBarPlacement,
} from "../../src/shared/ui/IconButton.tsx";
import {
  FolderGlyph,
  RefreshIcon,
  SettingsIcon,
} from "../../src/shared/ui/icons.tsx";
import "../../src/shared/styles/index.css";

const buttonClass =
  "grid place-items-center rounded-lg text-ink-mute hover:bg-hover hover:text-ink disabled:opacity-40";
export function Fixture() {
  const [clicks, setClicks] = useState(0);
  const [placement, setPlacement] = useState<IconBarPlacement>("left");
  const target = useRef<HTMLButtonElement>(null);
  return (
    <main className="grid gap-5 bg-base p-8 text-ink">
      {(["left", "right", "top", "bottom"] as const).map((side) => (
        <IconHoverProvider key={side} placement={side}>
          <div className="flex items-center gap-5" aria-label={`${side} 栏`}>
            <span className="w-16">{side}</span>
            <IconButton
              ref={side === "left" ? target : undefined}
              aria-label={`${side} 操作`}
              className={buttonClass}
              onClick={() => setClicks((old) => old + 1)}
            >
              <FolderGlyph isExpanded={false} className="ui-icon-18" />
            </IconButton>
            <span data-testid={`${side}-neighbor`}>相邻内容</span>
          </div>
        </IconHoverProvider>
      ))}
      <div className="flex items-center gap-5">
        <IconButton aria-label="禁用操作" disabled className={buttonClass}>
          <SettingsIcon className="ui-icon-18" />
        </IconButton>
        <IconButton
          aria-label="语义禁用操作"
          aria-disabled="true"
          className={buttonClass}
        >
          <SettingsIcon className="ui-icon-18" />
        </IconButton>
        <IconButton aria-label="旋转图标" className={buttonClass}>
          <RefreshIcon className="ui-icon-18 animate-spin" />
        </IconButton>
      </div>
      <IconHoverProvider placement={placement}>
        <div className="flex items-center gap-5">
          <IconButton aria-label="动态栏操作" className={buttonClass}>
            <SettingsIcon className="ui-icon-18" />
          </IconButton>
          <IconButton
            aria-label="覆盖栏方向"
            placement="top"
            className={buttonClass}
          >
            <SettingsIcon className="ui-icon-18" />
          </IconButton>
          <button
            type="button"
            aria-label="切换栏位置"
            onClick={() =>
              setPlacement((side) => (side === "left" ? "right" : "left"))
            }
          >
            切换栏位置
          </button>
          <button type="button" onClick={() => target.current?.focus()}>
            聚焦左栏
          </button>
        </div>
      </IconHoverProvider>
      <output aria-label="点击次数">{clicks}</output>
      <div className="flex items-center gap-3">
        {(["compact", "standard", "dialog", "rail", "large", "floating"] as const).map((size) => (
          <IconButton key={size} iconSize={size} aria-label={`尺寸 ${size}`}>
            <SettingsIcon />
          </IconButton>
        ))}
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
