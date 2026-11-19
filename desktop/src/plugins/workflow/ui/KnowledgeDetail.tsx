/**
 * 节点依据的规范文件（工作流包 knowledge/ 下）：和技能详情同一种文档呈现（正文 / 原文），只看内容。
 */
import { ModalShell } from "../../../shared/ui/ModalShell.tsx";
import { IconButton } from "../../../shared/ui/IconButton.tsx";
import { DocumentPreview, stripFrontMatter } from "../../../shared/ui/DocumentPreview.tsx";
import { WorkflowIcon, XIcon } from "../../../shared/ui/icons.tsx";

export function KnowledgeDetail({ workflowName, file, text, onClose }: {
  workflowName: string;
  /** 文件名（定义里 knowledge 写的名字）。 */
  file: string;
  text: string;
  onClose: () => void;
}) {
  // 标题用文档自己的一级标题，没有就用文件名。
  const title = /^#\s+(.+)$/m.exec(stripFrontMatter(text))?.[1]?.trim() || file;
  return (
    <ModalShell size="preview" label="规范详情" onDismiss={onClose}>
      <header className="flex shrink-0 items-center justify-between border-b border-line px-5 py-2.5">
        <h2 className="flex min-w-0 items-center gap-2 text-xs text-ink-mute">
          <WorkflowIcon className="ui-icon-16" />
          <span className="truncate">{workflowName}</span>
          <span aria-hidden="true">/</span>
          <span className="shrink-0">规范详情</span>
        </h2>
        <IconButton aria-label="关闭规范详情" onClick={onClose}>
          <XIcon className="ui-icon-16" />
        </IconButton>
      </header>
      <div className="shrink-0 px-5 py-4 sm:px-7 sm:py-5">
        <h3 data-hint={title} className="truncate text-ui-settings-title-lg font-semibold tracking-tight">{title}</h3>
      </div>
      <div className="flex min-h-0 flex-1 flex-col border-t border-line">
        <DocumentPreview name={file} text={text} emptyText="这份规范是空的" />
      </div>
    </ModalShell>
  );
}
