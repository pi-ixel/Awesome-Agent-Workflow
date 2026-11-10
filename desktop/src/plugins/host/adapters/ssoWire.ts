import type { SsoFetchWire, SsoLoginPollWire } from "./ssoTypes.ts";

/** 宽松守卫：宿主返回形状不合法时报错，绝不带病进入状态。 */
export function asSsoFetchWire(raw: unknown): SsoFetchWire {
  if (typeof raw === "object" && raw !== null) {
    const record = raw as Readonly<Record<string, unknown>>;
    if (
      typeof record["status"] === "number" &&
      typeof record["body"] === "string"
    ) {
      return { status: record["status"], body: record["body"] };
    }
  }
  throw new Error("SSO 认证命令返回形状不合法（缺少 status / body）");
}

/** 宽松守卫：fetched 为 null/缺省时归一为 null，形状不合法时报错。 */
export function asSsoLoginPollWire(raw: unknown): SsoLoginPollWire {
  if (typeof raw === "object" && raw !== null) {
    const record = raw as Readonly<Record<string, unknown>>;
    if (typeof record["windowClosed"] === "boolean") {
      const fetched = record["fetched"];
      return {
        windowClosed: record["windowClosed"],
        fetched:
          fetched === null || fetched === undefined
            ? null
            : asSsoFetchWire(fetched),
      };
    }
  }
  throw new Error(
    "SSO 登录轮询命令返回形状不合法（缺少 windowClosed / fetched）",
  );
}
