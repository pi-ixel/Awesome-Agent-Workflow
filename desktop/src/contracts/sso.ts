/** 一次 SSO 网关请求的传输结果（wire 形状，sso_login.rs SsoFetchResult）。 */
export interface SsoFetchWire {
  readonly status: number;
  readonly body: string;
}

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

/** 单次 SSO 登录轮询的传输结果（wire 形状，sso_login.rs SsoLoginPollResult）。 */
export interface SsoLoginPollWire {
  /** 登录窗口已被用户关闭（= 放弃）→ 编排层按静默取消处理。 */
  readonly windowClosed: boolean;
  /** 已带 cookie 调过网关时的响应原文；null = cookie 未落地，继续轮询。 */
  readonly fetched: SsoFetchWire | null;
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
