import type { PendingPermission } from "../types.ts";
import { useSessionCommands } from "../../conversation/ui/useSessionCommands.ts";
/**
 * 审批弹窗：模态展示一条挂起的 `session/request_permission`。
 *
 * 展示工具名（`_meta.chrys.tool_name`）、标题、rawInput 摘要（store 已
 * 定型为 inputSummary）与可选的重审原因；选项按钮按 kind 排序渲染——
 * 允许（主操作）→ 本会话总是允许 → 拒绝（危险操作）→ 未知（中性）。
 * chrys 当前只下发 allow_once / reject_once，allow_always 为协议预留，
 * 出现即自动多一枚按钮。
 *
 * 安全默认：默认焦点落在**拒绝一侧**（无拒绝项时落在排序末位）——权限
 * 请求可能在用户于别处打字途中弹出，缺省焦点绝不能是「允许」，否则
 * 用户下一次 Enter 就等于批准。未知 kind（协议演进/私有方言）以中性
 * 样式呈现 agent 的原始 name，绝不渲染成「允许」。
 *
 * 组件消费 Store 的成品数据，通过 acp Service 向所属 SessionRuntime 提交决策。
 * 请求校验、日志和 Promise 回传暂由会话持有的 approvalStore 执行。
 */
import type { PermissionOptionKind } from "../../../acpRuntime/types.ts";
import { PERMISSION_KIND_LABELS } from "../approvalStore.ts";
import { DangerButton, btnPrimary, btnSecondary } from "../../../../shared/ui/controls.tsx";
import { EditDiffView } from "../../conversation/ui/EditDiffView.tsx";
import { ModalShell } from "../../../../shared/ui/ModalShell.tsx";

/** 按钮渲染顺序：允许在前，拒绝居后，未知（守卫回落）最后。 */
const KIND_ORDER: Readonly<Record<PermissionOptionKind, number>> = {
  allow_once: 0,
  allow_always: 1,
  reject_once: 2,
  reject_always: 3,
  unknown: 4,
};

export function ApprovalModal({ item }: { readonly item: PendingPermission }) {
  const { decidePermission, cancelPermission } = useSessionCommands();

  // 工具预览（M5）：edit/write 类渲染 diff 或新内容预览，execute 类渲染
  // 完整命令——批准前一眼看到"要改成什么样 / 要跑什么"；形状不认识回落摘要
  const editPayload = isEditLikeTool(item) ? (item.edit ?? null) : null;
  const commandText = isExecuteLikeTool(item)
    ? extractCommand(item.rawInput)
    : null;
  const title = item.title.trim() || item.toolCallId;
  const repeatsCommand =
    commandText !== null &&
    title.replace(/\s+/g, " ").includes(commandText.trim().replace(/\s+/g, " "));

  const sortedOptions = [...item.options].sort(
    (left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind],
  );

  // 默认焦点 = 第一个拒绝项；无拒绝项时退到排序末位（最不可能被误认
  // 为「确认」的位置），把 Enter 的缺省动作钉在安全一侧
  const firstRejectIndex = sortedOptions.findIndex(
    (option) =>
      option.kind === "reject_once" || option.kind === "reject_always",
  );
  const defaultFocusIndex =
    firstRejectIndex >= 0 ? firstRejectIndex : sortedOptions.length - 1;

  return (
    <ModalShell
      label="权限审批"
      dismissOnBackdrop={false}
      onDismiss={() => cancelPermission(item.id)}
    >
      <div className="flex flex-col gap-4 p-5">
        <header className="space-y-1.5">
          <h2 className="text-ui-lg font-semibold text-ink">权限审批</h2>
          {!repeatsCommand && (
            <p className="wrap-anywhere text-sm leading-relaxed text-ink">
              {title}
            </p>
          )}
        </header>
        <div className="space-y-3">
          {item.reason && (
            <p className="wrap-anywhere text-sm font-medium leading-relaxed text-ink">
              原因：{item.reason}
            </p>
          )}
          <div className="space-y-1.5">
            <h3 className="text-sm font-medium text-ink">
              {editPayload !== null ? "改动预览" : commandText !== null ? "将执行的命令" : "工具输入"}
            </h3>
            {editPayload !== null ? (
              <EditDiffView defaultExpanded={true} payload={editPayload} />
            ) : (
              <pre className="rounded-lg border border-line bg-base px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere text-ink">
                {commandText ?? (item.inputSummary || "（无输入参数）")}
              </pre>
            )}
          </div>
        </div>
        <div className="flex min-w-0 items-center gap-2 text-xs text-ink-mute">
          {(item.toolName ?? item.toolKind) && (
            <code className="max-w-1/3 truncate">{item.toolName ?? item.toolKind}</code>
          )}
          <span
            className="min-w-0 truncate"
            data-hint={`来源会话 ${item.sessionId}`}
          >
            来源会话 <code>{item.sessionId}</code>
          </span>
        </div>
        <footer className="flex flex-wrap justify-end gap-2">
          {sortedOptions.map((option, index) => {
            const OptionButton = option.kind === "reject_once" || option.kind === "reject_always" ? DangerButton : "button";
            return (
              <OptionButton
                key={option.optionId}
                disabled={item.stale}
                type="button"
                autoFocus={index === defaultFocusIndex}
                onClick={() => {
                  if (!item.stale) decidePermission(item.id, option.optionId);
                }}
                className={optionButtonClass(option.kind)}
              >
                {option.kind === "unknown"
                  ? `未知（${option.name}）`
                  : PERMISSION_KIND_LABELS[option.kind]}
              </OptionButton>
            );
          })}
        </footer>
      </div>
    </ModalShell>
  );
}

/** edit/write 类工具判定（名字优先，meta kind 兜底）。 */
function isEditLikeTool(item: {
  readonly toolName: string | null;
  readonly toolKind: string | null;
}): boolean {
  return (
    (item.toolName?.includes("edit_file") ?? false) ||
    (item.toolName?.includes("write_file") ?? false) ||
    item.toolKind === "edit" ||
    item.toolKind === "write"
  );
}

/** execute/shell 类工具判定（chrys 的 shell 工具 kind 是 "shell"，
 *  ACP 工具卡映射后是 "execute"，两个口径都认）。 */
function isExecuteLikeTool(item: {
  readonly toolName: string | null;
  readonly toolKind: string | null;
}): boolean {
  if (item.toolKind === "execute" || item.toolKind === "shell") {
    return true;
  }
  return /powershell|pwsh|bash|run_command|shell/i.test(item.toolName ?? "");
}

/** 宽容提取命令文本（rawInput.command / rawInput.cmd）。 */
function extractCommand(rawInput: unknown): string | null {
  if (typeof rawInput !== "object" || rawInput === null) {
    return null;
  }
  const record = rawInput as Readonly<Record<string, unknown>>;
  for (const key of ["command", "cmd"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

/**
 * 选项按钮样式：允许=primary；总是允许=secondary；拒绝=danger；
 * 未知=secondary（中性描边，不抢主按钮视觉，也不伪装成危险操作）。
 */
function optionButtonClass(kind: PermissionOptionKind): string {
  const size = "px-3 py-1.5 text-sm";
  switch (kind) {
    case "allow_once":
      return `${btnPrimary} ${size}`;
    case "allow_always":
    case "unknown":
      return `${btnSecondary} ${size}`;
    default:
      return size;
  }
}
