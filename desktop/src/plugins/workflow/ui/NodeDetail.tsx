/**
 * 检视器正文：按节点处境给内容，原始结果只做折叠兜底。
 * - 未执行：这个节点会做什么（定义里的步骤）、什么时候执行；
 * - 运行中：要做的步骤 + Agent 最近的消息节选（细节去会话里看）；
 * - 有结果：结论 → 问题 → 产出文件（可打开）→ 其余字段；
 * - 异常处理入口（候选结果、核验）由面板经 children 放进来。
 */
import type { ReactNode } from "react";
import type { ResultView } from "./nodeDetail.ts";

const LIVE_EXCERPT = 360;

export function NodeDetail({ steps, conditions, executed, running, live, view, raw, sessionMissing, onOpenFile, children }: {
  steps: readonly string[];
  /** 未执行时才显示「什么时候执行」。 */
  conditions: readonly string[];
  executed: boolean;
  running: boolean;
  live?: string;
  view: ResultView | null;
  raw: unknown;
  sessionMissing: boolean;
  onOpenFile?: (path: string) => void;
  children?: ReactNode;
}) {
  const text = live?.trim() ?? "";
  const excerpt = text.length > LIVE_EXCERPT ? `…${text.slice(-LIVE_EXCERPT)}` : text;
  return <div className="workflow-detail">
    {view?.conclusion && <section className="workflow-detail-conclusion">
      <span className={`workflow-verdict tone-${view.conclusion.tone}`}>{view.conclusion.text}</span>
    </section>}
    {view && view.issues.length > 0 && <section aria-label="问题">
      <h4>问题</h4>
      <ul className="workflow-detail-list">{view.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>
    </section>}
    {view && view.files.length > 0 && <section aria-label="产出文件">
      <h4>产出文件</h4>
      <ul className="workflow-detail-files">{view.files.map((file, index) => <li key={`${file.path}-${index}`}>
        <span>{file.label}</span>
        {onOpenFile
          ? <button type="button" title={`打开 ${file.path}`} onClick={() => onOpenFile(file.path)}>{file.path}</button>
          : <code>{file.path}</code>}
      </li>)}</ul>
    </section>}
    {view && view.facts.length > 0 && <dl className="workflow-detail-facts">
      {view.facts.map((fact, index) => <div key={index}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}
    </dl>}
    {view?.texts.map((text, index) => <section key={index}>
      {text.label && <h4>{text.label}</h4>}
      <p className="workflow-detail-text">{text.text}</p>
    </section>)}
    {view?.lists.map((list, index) => <section key={index}>
      <h4>{list.label}</h4>
      <ul className="workflow-detail-list">{list.items.map((item, at) => <li key={at}>{item}</li>)}</ul>
    </section>)}

    {(!executed || running) && <section aria-label="节点步骤">
      <h4>{executed ? "这一步要做" : "这个节点会做"}</h4>
      {steps.length > 0
        ? <ol className="workflow-detail-steps">{steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
        : <p className="workflow-muted">流程定义里没有写步骤。</p>}
    </section>}
    {!executed && <section aria-label="执行条件">
      <h4>什么时候执行</h4>
      {conditions.length > 0
        ? <ul className="workflow-detail-list">{conditions.map((condition) => <li key={condition}>{condition}</li>)}</ul>
        : <p className="workflow-muted">没有找到指向这个节点的路线。</p>}
    </section>}
    {running && excerpt && <section aria-label="Agent 最近的消息">
      <h4>Agent 最近的消息（节选）</h4>
      <p className="workflow-detail-live">{excerpt}</p>
    </section>}

    {children}

    {sessionMissing && <p className="workflow-muted">这一轮没有关联会话。</p>}
    {raw !== undefined && raw !== null && <details className="workflow-detail-raw">
      <summary>原始结果</summary>
      <button type="button" className="workflow-link" onClick={() => void navigator.clipboard?.writeText(typeof raw === "string" ? raw : JSON.stringify(raw, null, 2))}>复制 JSON</button>
      <pre>{typeof raw === "string" ? raw : JSON.stringify(raw, null, 2)}</pre>
    </details>}
  </div>;
}
