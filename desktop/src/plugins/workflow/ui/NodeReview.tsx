/**
 * 工作流详情里点开节点：审查「这个工作流打算怎么跑」。
 * 内容都来自定义（生成工作流时写好的 why / delivers / explain，以及 does、去向、prompt、knowledge），只读。
 *
 * 顺序按审查时关心的程度：做什么 → 交出什么 → 结果怎么走（含要不要你确认）→ 依据 → 从哪来。
 * 「为什么」是标题下的一句话。
 */
import type { NodeOutcome } from "./nodeDetail.ts";
import type { WorkflowCatalogNode } from "../types.ts";
import { IconButton } from "../../../shared/ui/IconButton.tsx";
import { NavigationRow } from "../../../shared/ui/NavigationRow.tsx";
import { Disclosure } from "../../../shared/ui/Disclosure.tsx";
import { MarkdownView } from "../../../shared/ui/MarkdownView.tsx";
import { BotIcon, FileIcon, HandIcon, TerminalIcon, XIcon } from "../../../shared/ui/icons.tsx";
import { iconButton } from "./buttons.ts";

export function NodeReview({ node, place, outcomes, sources, onOpenKnowledge, onClose }: {
  node: WorkflowCatalogNode;
  /** 标题上方的位置说明，如「02 任务」。 */
  place?: string;
  outcomes: readonly NodeOutcome[];
  /** 从哪来（entryConditions 的结果）。 */
  sources: readonly string[];
  /** 点规范文件：打开它的详情。不给时只列名字。 */
  onOpenKnowledge?: (file: string) => void;
  onClose: () => void;
}) {
  const waits = outcomes.filter((outcome) => outcome.confirm);
  return <aside className="workflow-inspector workflow-review" aria-label="节点说明">
    <header className="workflow-review-head">
      <span className={`workflow-review-icon kind-${node.kind}`} aria-hidden="true">{node.kind === "python" ? <TerminalIcon className="ui-icon-16" /> : <BotIcon className="ui-icon-16" />}</span>
      <div className="workflow-review-title">
        {place && <small>{place}</small>}
        <h3>{node.label}</h3>
      </div>
      <IconButton iconSize="compact" type="button" className={`${iconButton} workflow-inspector-close`} onClick={onClose} aria-label="关闭节点说明"><XIcon className="ui-icon-14" /></IconButton>
      {node.purpose && <p className="workflow-review-why">{node.purpose}</p>}
    </header>

    <div className="workflow-review-body">
      {waits.length > 0 && <div className="workflow-review-wait" role="note">
        <HandIcon className="ui-icon-16" aria-hidden="true" />
        <span>{waits.map((outcome) => outcome.target === "完成" ? "流程完成前会停下等你确认" : `${outcome.target ? `开始${outcome.target}` : "继续"}前会停下等你确认`).join("；")}</span>
      </div>}

      <section aria-label="做什么">
        <h4>{node.steps.length > 0 ? "做什么" : "节点提示词"}</h4>
        {node.steps.length > 0 ? (
          <>
            <ol className="workflow-review-steps">
              {node.steps.map((step, index) => (
                <li key={index}>
                  <span>{index + 1}</span>
                  {step}
                </li>
              ))}
            </ol>
            {node.prompt && (
              <Disclosure summary="完整要求" className="workflow-review-prompt">
                <div className="mt-1.5 text-ui-sm text-ink">
                  <MarkdownView text={node.prompt} />
                </div>
              </Disclosure>
            )}
          </>
        ) : node.prompt ? (
          <div className="text-ui-sm text-ink">
            <MarkdownView text={node.prompt} />
          </div>
        ) : (
          <p className="workflow-muted">定义里没有写说明。</p>
        )}
      </section>

      {node.delivers && <section aria-label="交出什么">
        <h4>交出什么</h4>
        <p className="workflow-review-delivers"><FileIcon className="ui-icon-14" aria-hidden="true" /><span>{node.delivers}</span></p>
      </section>}

      {outcomes.length > 0 && <section aria-label="结果怎么走">
        <h4>结果怎么走</h4>
        <ul className="workflow-review-outcomes">{outcomes.map((outcome, index) => <li key={index} className={outcome.stops ? "is-stop" : undefined}>
          {outcome.when
            ? <><span className="when">如果{outcome.when}</span><span className="then">{outcome.result}</span></>
            : <span className="when">完成后{outcome.result}</span>}
        </li>)}</ul>
      </section>}

      {(node.knowledge?.length ?? 0) > 0 && <section aria-label="关联知识">
        <h4>关联知识</h4>
        <ul className="workflow-review-files">{node.knowledge!.map((file) => <li key={file}>
          {onOpenKnowledge
            ? <NavigationRow layout="compound" onClick={() => onOpenKnowledge(file)} data-hint="查看这份知识文档"><FileIcon className="ui-icon-12" aria-hidden="true" />{file}</NavigationRow>
            : <span><FileIcon className="ui-icon-12" aria-hidden="true" />{file}</span>}
        </li>)}</ul>
      </section>}

      {sources.length > 0 && <p className="workflow-review-from">从哪来：{sources.join("；")}</p>}
    </div>
  </aside>;
}
