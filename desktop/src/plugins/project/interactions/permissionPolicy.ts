/**
 * 审批默认模式的应答策略（ui 层纯函数）：
 *
 * 设置里的「审批默认模式」（settingsStore 的 ApprovalMode）决定
 * realRuntime 对 `session/request_permission` 反向请求的默认应答——
 * - ask（手动）：交人工弹窗（返回 null，由调用方走 offerPermission）；
 * - auto-allow（自动放行）：按 allow_once → allow_always 的 kind 白名单
 *   顺序选第一个可放行选项，自动应答 selected。
 *   （「自动拒绝」选项已下线：误触后所有工具调用被拒，弊大于利。）
 *
 * 安全默认：kind 白名单匹配不到（比如 agent 只给了未知语义的选项）一律
 * 返回 null 回退人工弹窗——绝不静默取消，更不会把未知选项当成放行。
 *
 * 注意区分双概念：设置里这项是「客户端对审批请求的默认应答策略」；会话
 * 内审批徽标显示的 manual / auto / bypass 是 chrys 侧的会话模式，两者
 * 相互独立（设置页 hint 已说明）。
 */
import type {
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionOutcome,
} from "../../../contracts/acpProtocol.ts";
import type { ApprovalMode } from "../../../contracts/project.ts";

/** 各模式自动应答时依次尝试的选项 kind 白名单。 */
const AUTO_KINDS: Readonly<
  Record<Exclude<ApprovalMode, "ask">, readonly PermissionOptionKind[]>
> = {
  "auto-allow": ["allow_once", "allow_always"],
};

/**
 * 按审批默认模式计算自动应答；返回 null 表示交人工弹窗。
 * 选项匹配只在 kind 白名单内进行（同 kind 取先到者），白名单全落空时
 * 回退弹窗（安全默认）。
 */
export function resolveAutoPermission(
  mode: ApprovalMode,
  options: readonly PermissionOption[],
): RequestPermissionOutcome | null {
  if (mode === "ask") {
    return null;
  }
  for (const kind of AUTO_KINDS[mode]) {
    const hit = options.find((option) => option.kind === kind);
    if (hit !== undefined) {
      return { outcome: "selected", optionId: hit.optionId };
    }
  }
  return null;
}
