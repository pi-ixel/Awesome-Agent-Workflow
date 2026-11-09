import { ICODE_METHOD } from "./types.ts";
import type {
  ChrysQuestion,
  ChrysRequestInputResult,
  ChrysUsageUpdateParams,
} from "./types.ts";
import { extractEditPayload } from "./editPayload.ts";
import { createSubagentLifecycle } from "./subagentLifecycle.ts";
import type { SubagentToolEvidence } from "../../core/subagentTool.ts";
import { subagentTool } from "./subagentTool.ts";
import { normalizeChrysRuntime } from "./chrysRuntime.ts";
/**
 * chrys 方言挂接（src/agents）：chrys 私有扩展的解析点。
 *
 * chrys 在标准 ACP 之外的私有消息（Python SDK ext_method / ext_notification
 * 自动加 `_` 前缀，权威定义见 D:/dev/workspace-ai/chrys/src/chrys/app/acp/）：
 *
 * - 通知：`_chrys/runtime_update`、`_chrys/usage_update`、`_chrys/error`、
 *   `_chrys/warning`，以及其余 `_chrys/` 前缀通知（原样透传为
 *   `chrys_extension` 事件）；
 * - 反向请求：`_chrys/request_input`（结构化提问）。
 *
 * 这些解析经 `AgentAdapter.createDialect` 注入 `AcpSession`（协议层的
 * `AcpDialect` 挂接点），协议层因此不硬编码任何 chrys 方法名——接入
 * 第二种带私有扩展的 agent 时，在它自己的适配项里提供各自的方言即可。
 * 未注入方言时，协议层把未知消息兜底透传（数据不丢、UI 不崩）。
 */
import { createLogger } from "../../core/logger.ts";
import type { ServerRequestHandler } from "../../runtime/acpBase/protocol/JsonRpcConnection.ts";
import {
  asBoolean,
  asNumber,
  asRecord,
  asString,
} from "../../runtime/acpBase/protocol/parse.ts";
import type { AcpDialect, AcpSessionEvent } from "../../runtime/acpBase/protocol/session.ts";

const logger = createLogger("acp");

import type { QuestionResponder } from "../types.ts";
export type { QuestionResponder } from "../types.ts";

/** chrys 方言的运行时回调（由组装层提供：UI 挂起 → 用户作答 → 回传）。 */
export interface ChrysDialectOptions {
  /** 结构化提问回调；缺省自动返回 cancelled（安全默认，绝不伪造答案）。 */
  readonly onQuestion?: QuestionResponder;
}

/** 创建 chrys 方言挂接（registry.ts 的 chrys 适配项经 createDialect 暴露）。 */
export function createChrysDialect(
  options: ChrysDialectOptions = {},
): AcpDialect {
  const toolEvidence = new Map<string, SubagentToolEvidence>();
  const lifecycle = createSubagentLifecycle();
  return {
    enhanceEvent: (event) => {
      if (event.type !== "tool_call" && event.type !== "tool_call_update")
        return event;
      const key = JSON.stringify([event.sessionId, event.toolCallId]);
      const previous = toolEvidence.get(key);
      const evidence = {
        ...previous,
        ...Object.fromEntries(
          Object.entries(event).filter(([, value]) => value !== undefined),
        ),
        _meta: {
          ...previous?._meta,
          ...event._meta,
          chrys: {
            ...asRecord(previous?._meta?.chrys),
            ...asRecord(event._meta?.chrys),
          },
        },
        title: event.title ?? previous?.title ?? event.toolCallId,
        toolKind: event.kind ?? previous?.toolKind,
      };
      toolEvidence.set(key, evidence);
      if (toolEvidence.size > 2048)
        toolEvidence.delete(toolEvidence.keys().next().value!);
      const subagent = lifecycle.merge(
        event.sessionId,
        event.toolCallId,
        subagentTool(evidence),
      );
      const edit =
        evidence.toolKind === "edit"
          ? extractEditPayload(evidence.rawInput)
          : null;
      return {
        ...event,
        ...(subagent ? { subagent } : {}),
        ...(edit ? { edit } : {}),
      };
    },
    normalizePermissionOutcome: (outcome, params) => {
      if (outcome.outcome !== "cancelled" || !Array.isArray(params.options))
        return outcome;
      const reject = params.options
        .map((item: unknown) => asRecord(item))
        .find(
          (item) =>
            item?.kind === "reject_once" || item?.kind === "reject_always",
        );
      const id = reject && asString(reject.optionId);
      return id ? { outcome: "selected", optionId: id } : outcome;
    },
    translateNotification: (method, params) =>
      lifecycle.translate(method, params) ??
      translateChrysNotification(method, params),
    serverRequestHandlers: new Map<string, ServerRequestHandler>([
      [
        ICODE_METHOD.chrysRequestInput,
        (_method, params) => handleRequestInput(params, options.onQuestion),
      ],
    ]),
  };
}

// ------------------------------------------------------------- 私有通知

function translateChrysNotification(
  method: string,
  params: Readonly<Record<string, unknown>>,
): AcpSessionEvent | null {
  if (method === ICODE_METHOD.chrysRuntimeUpdate) {
    const runtime = asRecord(params["runtime"]);
    if (runtime === null) {
      return null;
    }
    return {
      type: "agent_runtime",
      sessionId: asString(params["sessionId"]) ?? "",
      runtime: normalizeChrysRuntime(runtime),
    };
  }
  if (method === ICODE_METHOD.chrysUsageUpdate) {
    if (!("sessionId" in params)) {
      return null;
    }
    return {
      type: "agent_usage",
      sessionId: asString(params["sessionId"]) ?? "",
      usage: {
        ...pickChrysUsage(params),
        contextUsed: asNumber(params["totalTokens"]) ?? undefined,
        contextBasis: "estimated",
        sourceLabel: "ICode 最近调用估算",
        scope:
          typeof params.usageSourceId === "string" &&
          params.usageSourceId !== params.sessionId
            ? "subagent"
            : "session",
      },
    };
  }
  if (method === ICODE_METHOD.chrysError) {
    return {
      type: "agent_error",
      origin: "ICode",
      sessionId: asString(params["sessionId"]),
      code: asString(params["code"]),
      message: asString(params["message"]) ?? "",
      recoverable: asBoolean(params["recoverable"]),
    };
  }
  if (method === ICODE_METHOD.chrysWarning) {
    return {
      type: "agent_warning",
      origin: "ICode",
      sessionId: asString(params["sessionId"]),
      code: asString(params["code"]),
      message: asString(params["message"]) ?? "",
    };
  }
  if (method.startsWith("_chrys/")) {
    // 其余 chrys 扩展通知（session_restored / sub_agent_* 等）原样透传
    return { type: "agent_extension", method, params };
  }
  // 非 chrys 消息：交回协议层（标准翻译 → unknown_notification 兜底）
  return null;
}

/**
 * 逐字段收窄 `_chrys/usage_update` 参数（对照 server.py UsageUpdate 发送点）。
 * 已知字段外的多余键丢弃。
 */
function pickChrysUsage(
  record: Readonly<Record<string, unknown>>,
): ChrysUsageUpdateParams {
  const out: {
    sessionId: string;
    agentProfile?: string;
    usageSourceId?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    pct?: number;
    maxContextTokens?: number;
    totalSessionTokens?: number;
    totalSessionInputTokens?: number;
    totalSessionOutputTokens?: number;
    cacheHitTokens?: number;
    totalSessionCacheHitTokens?: number;
    localTokens?: number;
    calibrationRatio?: number;
    systemOverheadTokens?: number;
  } = { sessionId: asString(record["sessionId"]) ?? "" };
  for (const key of ["agentProfile", "usageSourceId"] as const) {
    const value = asString(record[key]);
    if (value !== null) {
      out[key] = value;
    }
  }
  for (const key of [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "pct",
    "maxContextTokens",
    "totalSessionTokens",
    "totalSessionInputTokens",
    "totalSessionOutputTokens",
    "cacheHitTokens",
    "totalSessionCacheHitTokens",
    "localTokens",
    "calibrationRatio",
    "systemOverheadTokens",
  ] as const) {
    const value = asNumber(record[key]);
    if (value !== null) {
      out[key] = value;
    }
  }
  return out;
}

// ----------------------------------------------------------- 私有反向请求

/** 处理 `_chrys/request_input`：解析问题 → 回调作答；无回调按取消回传。 */
async function handleRequestInput(
  params: Readonly<Record<string, unknown>>,
  responder: QuestionResponder | undefined,
): Promise<ChrysRequestInputResult> {
  const sessionId = asString(params["sessionId"]) ?? "";
  const requestId = asString(params["requestId"]) ?? "";
  const questions = parseQuestions(params["questions"]);
  const callerName = asString(params["callerName"]);
  if (responder === undefined) {
    logger.warn("结构化提问无回调，自动取消（安全默认）", {
      sessionId,
      requestId,
    });
    return { cancelled: true };
  }
  const answer = await responder(sessionId, requestId, questions, callerName);
  return answer ?? { cancelled: true };
}

/** 宽容收窄 `_chrys/request_input` 的 questions 数组（server.py ask_user）。 */
function parseQuestions(raw: unknown): ChrysQuestion[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const questions: ChrysQuestion[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    if (record === null) {
      continue;
    }
    const question = asString(record["question"]);
    if (question === null) {
      continue;
    }
    const options: { label: string; description: string }[] = [];
    const rawOptions = record["options"];
    if (Array.isArray(rawOptions)) {
      for (const option of rawOptions) {
        const optionRecord = asRecord(option);
        const label =
          optionRecord === null ? null : asString(optionRecord["label"]);
        if (label === null) {
          continue;
        }
        options.push({
          label,
          description:
            optionRecord === null
              ? ""
              : (asString(optionRecord["description"]) ?? ""),
        });
      }
    }
    questions.push({
      question,
      header: asString(record["header"]) ?? "",
      options,
      multiSelect: asBoolean(record["multiSelect"]) ?? false,
    });
  }
  return questions;
}
