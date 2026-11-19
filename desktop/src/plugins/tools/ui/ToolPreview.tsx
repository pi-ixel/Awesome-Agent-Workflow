import { useEffect, useRef, useState } from "react";
import { btnGhost } from "../../../shared/ui/controls.tsx";
import type { ToolPackage } from "../types.ts";
import { toolFramePolicy } from "../runtime/policy.ts";
import { toolSettingsScript } from "../runtime/settings.ts";

/**
 * 预览里的第一段脚本：把工具的 console 与未捕获异常转到宿主。
 *
 * 没有它，工具里 `throw` 一下用户只能看到白屏——这是"改一版就要问一次 AI"的
 * 主要成因。它必须排在工具自身脚本之前，否则早期报错抓不到。
 */
const collector = `<script>(function(){
  var send = function (level, args) {
    try {
      parent.postMessage({ source: "aaw-tool-preview", level: level,
        text: Array.prototype.map.call(args, function (item) {
          if (typeof item === "string") return item;
          try { return JSON.stringify(item); } catch (error) { return String(item); }
        }).join(" ") }, "*");
    } catch (error) { /* 宿主已关闭时忽略 */ }
  };
  ["log", "info", "warn", "error"].forEach(function (level) {
    var original = console[level] ? console[level].bind(console) : function () {};
    console[level] = function () { send(level, arguments); original.apply(null, arguments); };
  });
  window.addEventListener("error", function (event) {
    send("error", [event.message + (event.lineno ? "（第 " + event.lineno + " 行）" : "")]);
  });
  window.addEventListener("unhandledrejection", function (event) {
    send("error", ["未处理的 Promise 拒绝：" + String(event.reason)]);
  });
})();</script>`;

export interface PreviewLog {
  readonly level: string;
  readonly text: string;
}

export function ToolPreview({ tool, onBack, onInstall, installLabel, onReload, revision = 0, embedded = false }: {
  tool: ToolPackage;
  /** 省略时不显示「← 返回」——右栏标签里没有"上一页"可回。 */
  onBack?: () => void;
  onInstall?: () => void;
  installLabel?: string;
  /** 从磁盘重新读一遍项目（右栏预览用）；省略时只重载 iframe。 */
  onReload?: () => void;
  /** 内容版本号：变了就换 iframe，避免改完还是旧画面。 */
  revision?: number;
  /** 嵌在右栏里：头部更紧凑，不加外框背景。 */
  embedded?: boolean;
}) {
  const [logs, setLogs] = useState<readonly PreviewLog[]>([]);
  const [showLogs, setShowLogs] = useState(!embedded);
  const [nonce, setNonce] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const errors = logs.filter((entry) => entry.level === "error").length;

  useEffect(() => {
    function receive(event: MessageEvent) {
      const data = event.data as { source?: unknown; level?: unknown; text?: unknown } | null;
      if (!data || data.source !== "aaw-tool-preview") return;
      setLogs((previous) => [...previous.slice(-199), {
        level: typeof data.level === "string" ? data.level : "log",
        text: typeof data.text === "string" ? data.text : String(data.text),
      }]);
    }
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);

  useEffect(() => {
    const element = list.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [logs]);

  return (
    <section aria-label={`${tool.name} 预览`} className={`aaw-tools flex h-full min-h-0 flex-col ${embedded ? "" : "bg-base"}`}>
      <header className={`preview-head${embedded ? " is-embedded" : ""}`}>
        {onBack && <button type="button" className={btnGhost} onClick={onBack}>← 返回</button>}
        <div className="preview-title">
          <h2>{tool.name}</h2>
          <span>v{tool.version} · 预览</span>
        </div>
        <div className="preview-actions">
          <button type="button" className={btnGhost} onClick={() => {
            setLogs([]);
            setNonce((value) => value + 1);
            onReload?.();
          }}>{onReload ? "重新读取" : "重新载入"}</button>
          <button type="button" className={btnGhost} aria-pressed={showLogs} onClick={() => setShowLogs((value) => !value)}>
            运行日志{errors ? ` · ${errors} 个错误` : logs.length ? ` · ${logs.length}` : ""}
          </button>
          {onInstall && <button type="button" className="preview-install" onClick={onInstall}>{installLabel ?? "安装"}</button>}
        </div>
      </header>
      <iframe
        key={`${tool.id}:${nonce}:${revision}`}
        data-hint={tool.name}
        aria-label={tool.name}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${toolFramePolicy}">${toolSettingsScript(tool)}${collector}${tool.html}`}
        className="preview-frame"
      />
      {showLogs && (
        <div className="preview-logs" role="log" aria-label="运行日志">
          <div className="preview-logs-head">
            <span>运行日志</span>
            <button type="button" onClick={() => setLogs([])}>清空</button>
          </div>
          <div className="preview-logs-body" ref={list}>
            {logs.length === 0
              ? <p className="preview-logs-empty">还没有输出。工具里的 console 与未捕获异常会显示在这里。</p>
              : logs.map((entry, index) => (
                <p key={index} className={`preview-log is-${entry.level}`}>
                  <span>{entry.level}</span>{entry.text}
                </p>
              ))}
          </div>
        </div>
      )}
    </section>
  );
}
