/**
 * 全局异常守卫与渲染进程死亡取证(白屏诊断设施)。
 *
 * 背景:logger 环形缓冲随渲染进程一起死亡,白屏后什么都不剩。这里把
 * 「JS 异常」与「渲染进程异常终止」两类事故分别落到 localStorage
 * (跨整页重载与应用重启存活),下次启动读回进日志环:
 *
 * - window error / unhandledrejection → logger + 持久化最后一条;
 * - 心跳:30s 写一次 localStorage;下次启动发现心跳断档超过 90s 且
 *   没有干净退出标记 → 判定上次运行被异常终止(渲染进程被系统回收,
 *   即「锁屏回来白屏」的形态)。干净退出 / 整页刷新都会留 clean-exit
 *   标记,启动读取后即清除,不误报。
 */
import { createLogger } from "./logger.ts";

const logger = createLogger("crash");

const LAST_CRASH_KEY = "aaw-desktop.last-crash";
const HEARTBEAT_KEY = "aaw-desktop.heartbeat";
const CLEAN_EXIT_KEY = "aaw-desktop.clean-exit";
const HEARTBEAT_INTERVAL_MS = 30_000;
/** 心跳断档超过该值才算异常终止(正常重启通常 < 90s)。 */
const HEARTBEAT_STALE_MS = 90_000;

export interface CrashRecord {
  readonly type: "error" | "unhandledrejection" | "renderer-lost";
  readonly message: string;
  readonly stack: string | null;
  readonly at: string;
}

function persistCrash(record: CrashRecord): void {
  try {
    window.localStorage.setItem(LAST_CRASH_KEY, JSON.stringify(record));
  } catch {
    // 存储不可用(隐私模式 / 配额)不阻断主流程
  }
}

/** 上一次异常记录(启动时读回进日志;诊断页未来可展示)。 */
export function readLastCrash(): CrashRecord | null {
  try {
    const raw = window.localStorage.getItem(LAST_CRASH_KEY);
    return raw === null ? null : (JSON.parse(raw) as CrashRecord);
  } catch {
    return null;
  }
}

export function clearLastCrash(): void {
  try {
    window.localStorage.removeItem(LAST_CRASH_KEY);
  } catch {
    // 忽略
  }
}

/** 心跳断档检测:渲染进程被系统回收时心跳戛然而止且无 clean-exit。 */
function detectAbnormalTermination(): void {
  try {
    const cleanExit = window.localStorage.getItem(CLEAN_EXIT_KEY);
    window.localStorage.removeItem(CLEAN_EXIT_KEY);
    const raw = window.localStorage.getItem(HEARTBEAT_KEY);
    if (cleanExit !== null || raw === null) {
      return;
    }
    const lastBeat = Number(raw);
    if (!Number.isFinite(lastBeat)) {
      return;
    }
    const gapMs = Date.now() - lastBeat;
    if (gapMs <= HEARTBEAT_STALE_MS) {
      return;
    }
    const record: CrashRecord = {
      type: "renderer-lost",
      message: `心跳断档 ${Math.round(gapMs / 1000)}s 后进程消失(疑似渲染进程被系统回收)`,
      stack: null,
      at: new Date().toISOString(),
    };
    logger.warn("检测到上次运行异常终止", { gapMs, at: record.at });
    persistCrash(record);
  } catch {
    // 忽略
  }
}

/** 在 main.tsx 渲染前调用一次:挂全局监听 + 启动心跳。 */
export function installGlobalErrorGuard(): void {
  detectAbnormalTermination();
  const lastCrash = readLastCrash();
  if (lastCrash !== null) {
    logger.warn("存在上次异常记录", { ...lastCrash });
  }

  window.addEventListener("error", (event) => {
    const record: CrashRecord = {
      type: "error",
      message: event.message || "未知脚本错误",
      stack: event.error instanceof Error ? (event.error.stack ?? null) : null,
      at: new Date().toISOString(),
    };
    logger.error("全局未捕获异常", {
      message: record.message,
      filename: event.filename || null,
      line: event.lineno || null,
    });
    persistCrash(record);
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason: unknown = event.reason;
    const record: CrashRecord = {
      type: "unhandledrejection",
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? (reason.stack ?? null) : null,
      at: new Date().toISOString(),
    };
    logger.error("全局未处理的 Promise 拒绝", { message: record.message });
    persistCrash(record);
  });

  const beat = (): void => {
    try {
      window.localStorage.setItem(HEARTBEAT_KEY, String(Date.now()));
    } catch {
      // 忽略
    }
  };
  beat();
  window.setInterval(beat, HEARTBEAT_INTERVAL_MS);
  window.addEventListener("beforeunload", () => {
    try {
      window.localStorage.setItem(CLEAN_EXIT_KEY, String(Date.now()));
    } catch {
      // 忽略
    }
  });
}
