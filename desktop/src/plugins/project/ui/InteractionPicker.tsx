import { ArrowUpIcon } from "../../../shared/ui/icons.tsx";
import { SettingsPreviewPicker } from "./SettingsPreviewPicker.tsx";
import "./InteractionPicker.css";

const choices = [
  { value: "queue", label: "排队" },
  { value: "steer", label: "引导" },
] as const;

export function InteractionPicker({
  value,
  onChange,
}: {
  readonly value: "queue" | "steer";
  readonly onChange: (value: "queue" | "steer") => void;
}) {
  return (
    <SettingsPreviewPicker
      label="交互行为"
      value={value}
      choices={choices}
      onChange={onChange}
      renderPreview={(mode) => <InteractionPreview mode={mode} />}
    />
  );
}

function InteractionPreview({ mode }: { readonly mode: "queue" | "steer" }) {
  const steer = mode === "steer";
  const bubble =
    "ml-auto w-fit max-w-full rounded-xl rounded-tr-xs border border-line bg-surface px-2 py-1.5 text-ink";
  return (
    <div
      data-interaction-preview={mode}
      className="flex min-w-0 flex-col justify-between gap-2 p-2 text-ui-caption"
    >
      <div className="min-w-0 grow space-y-2">
        <p className={bubble}>帮我检查项目</p>
        <div className="grid text-ink-mute">
          <span className="interaction-preview-running col-start-1 row-start-1">
            正在检查文件…
          </span>
          <span className="interaction-preview-completed col-start-1 row-start-1">
            {steer ? "当前轮已停止" : "检查完成"}
          </span>
        </div>
        <div className="interaction-preview-reply space-y-1">
          <p className={bubble}>先看登录模块</p>
          <p className="text-ink">开始检查登录模块…</p>
        </div>
      </div>
      <div
        data-interaction-composer=""
        className="min-w-0 rounded-lg border border-line bg-surface p-2"
      >
        <div className="grid min-h-10">
          <span className="interaction-preview-placeholder col-start-1 row-start-1 text-ink-mute">
            {steer ? "输入补充内容" : "输入消息"}
          </span>
          <span className="interaction-preview-draft col-start-1 row-start-1 text-ink">
            先看登录模块
          </span>
          <span className="interaction-preview-pending col-start-1 row-start-1 text-ink-mute">
            {steer ? "输入补充内容" : "已排队 · 先看登录模块"}
          </span>
        </div>
        <div className="flex items-center justify-end gap-1 text-right text-ink-mute">
          <span>{steer ? "发送" : "加入队列"}</span>
          <span className="grid size-5 shrink-0 place-items-center rounded-md bg-brand text-foreground-inverse">
            <ArrowUpIcon className="size-3" />
          </span>
        </div>
      </div>
    </div>
  );
}
