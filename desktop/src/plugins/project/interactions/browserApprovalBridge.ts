/**
 * 浏览器受限操作审批桥。
 *
 * 原生浏览器 MCP 对提交、脚本、上传和控制单独发出审批事件。本模块把事件
 * 翻译成项目统一权限请求：自动放行模式直接批准，人工模式进入会话审批
 * store 与统一审批弹窗；拒绝、取消、会话挂起一律回传拒绝。原生侧的页面
 * 代次与动作摘要校验保持不变。
 */
import type { BrowserApproval } from "../../../contracts/browser/types.ts";
import type { PermissionOption } from "../../acpRuntime/types.ts";
import type { ApprovalMode } from "../types.ts";
import type { ApprovalStoreState } from "./approvalStore.ts";
import { resolveAutoPermission } from "./permissionPolicy.ts";
import { createLogger, type Logger } from "../../../shared/logging/logger.ts";

const ALLOW_OPTION_ID = "allow";
const REJECT_OPTION_ID = "reject";

const BROWSER_PERMISSION_OPTIONS: readonly PermissionOption[] = [
  { optionId: ALLOW_OPTION_ID, name: "允许一次", kind: "allow_once" },
  { optionId: REJECT_OPTION_ID, name: "拒绝", kind: "reject_once" },
];

export interface BrowserApprovalPermission {
  readonly toolCall: Readonly<Record<string, unknown>>;
  readonly options: readonly PermissionOption[];
}

/** 审批动作标题：动作类型一眼可辨，未知动作回落中性文案。 */
function approvalTitle(action: string): string {
  if (action === "control") return "允许 Agent 控制此浏览器页面？";
  if (action === "submit") return "允许 Agent 提交浏览器表单？";
  if (action.startsWith("upload:")) return "允许 Agent 上传指定文件？";
  if (action.startsWith("script:")) return "允许 Agent 在浏览器中执行脚本？";
  return "允许 Agent 执行受限浏览器操作？";
}

export function browserApprovalPermission(
  approval: BrowserApproval,
): BrowserApprovalPermission {
  return {
    toolCall: {
      toolCallId: `browser:${approval.approvalId}`,
      title: approvalTitle(approval.action),
      kind: "other",
      rawInput: { action: approval.action, tabId: approval.tabId },
    },
    options: BROWSER_PERMISSION_OPTIONS,
  };
}

export interface BrowserApprovalBridgeOptions {
  readonly browser: {
    approvalSnapshot(sessionId: string): Promise<readonly BrowserApproval[]>;
    decideApproval(
      approvalId: string,
      approved: boolean,
    ): Promise<BrowserApproval>;
    onApproval(
      receive: (approval: BrowserApproval) => void,
    ): Promise<() => void>;
  };
  readonly sessionId: string;
  readonly approvalStore: Pick<ApprovalStoreState, "offerPermission">;
  readonly getApprovalMode: () => ApprovalMode;
  readonly logger?: Logger;
}

/**
 * 订阅一个会话的浏览器审批事件并加载已有待审批。返回释放函数；释放后
 * 到达的事件不再挂起或决策。
 */
export function attachBrowserApprovals({
  browser,
  sessionId,
  approvalStore,
  getApprovalMode,
  logger = createLogger("approval"),
}: BrowserApprovalBridgeOptions): () => void {
  let active = true;
  let release: () => void = () => {};
  const handled = new Set<string>();

  const decide = async (
    approvalId: string,
    approved: boolean,
    source: string,
  ): Promise<void> => {
    try {
      await browser.decideApproval(approvalId, approved);
      logger.info("浏览器审批已回传原生", { approvalId, approved, source });
    } catch (error) {
      logger.warn("浏览器审批回传原生失败", {
        approvalId,
        approved,
        source,
        reason: String(error),
      });
    }
  };

  const handle = (approval: BrowserApproval): void => {
    if (!active) return;
    if (approval.sessionId !== sessionId) return;
    if (approval.status !== "pending") return;
    if (handled.has(approval.approvalId)) return;
    handled.add(approval.approvalId);

    const { toolCall, options } = browserApprovalPermission(approval);
    const auto = resolveAutoPermission(getApprovalMode(), options);
    if (auto !== null) {
      const approved =
        auto.outcome === "selected" && auto.optionId === ALLOW_OPTION_ID;
      logger.info("浏览器审批按全局审批默认模式自动决策", {
        approvalId: approval.approvalId,
        action: approval.action,
        approved,
      });
      void decide(approval.approvalId, approved, "自动放行");
      return;
    }

    void approvalStore
      .offerPermission({ sessionId, toolCall, options })
      .then((outcome) => {
        const approved =
          outcome.outcome === "selected" &&
          outcome.optionId === ALLOW_OPTION_ID;
        logger.info("浏览器审批已人工决策", {
          approvalId: approval.approvalId,
          action: approval.action,
          approved,
        });
        return decide(approval.approvalId, approved, "人工审批");
      })
      .catch((error: unknown) => {
        logger.warn("浏览器审批挂起失败，按拒绝回传", {
          approvalId: approval.approvalId,
          reason: String(error),
        });
        return decide(approval.approvalId, false, "挂起失败");
      });
  };

  void browser
    .approvalSnapshot(sessionId)
    .then((items) => {
      if (active) items.forEach(handle);
    })
    .catch((error: unknown) => {
      logger.warn("浏览器待审批快照读取失败", {
        sessionId,
        reason: String(error),
      });
    });

  void browser
    .onApproval(handle)
    .then((stop) => {
      if (active) release = stop;
      else stop();
    })
    .catch((error: unknown) => {
      logger.warn("浏览器审批事件订阅失败", {
        sessionId,
        reason: String(error),
      });
    });

  return () => {
    if (!active) return;
    active = false;
    release();
  };
}
