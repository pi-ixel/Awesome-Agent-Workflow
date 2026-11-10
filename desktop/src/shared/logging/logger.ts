import { redactContext, redactText } from "./logPrivacy.ts";
import type { LogEntry, LogLevel } from "./types.ts";

type LogContext = Readonly<Record<string, unknown>>;

interface LogTarget {
  log(level: LogLevel, channel: string, message: string, context?: LogContext): LogEntry | undefined;
}

export type LoggerFactory = (channel: string, context?: LogContext) => Logger;

export function createLogEntry(
  seq: number,
  level: LogLevel,
  channel: string,
  message: string,
  context?: LogContext,
): LogEntry {
  return {
    seq,
    timestamp: new Date().toISOString(),
    level,
    channel,
    message: redactText(message),
    context: (redactContext(context ?? {}) ?? {}) as LogContext,
  };
}

/** 带通道名与绑定上下文的日志器；由 createLogger 创建，不直接 new。 */
export class Logger {
  constructor(
    private readonly sink: LogTarget,
    private readonly channel: string,
    private readonly boundContext: Readonly<Record<string, unknown>> = {},
  ) {}

  /** 派生一个追加绑定上下文的子 logger（如 requestId 固定的会话）。 */
  child(context: Readonly<Record<string, unknown>>): Logger {
    return new Logger(this.sink, this.channel, {
      ...this.boundContext,
      ...context,
    });
  }

  debug(message: string, context?: Readonly<Record<string, unknown>>): LogEntry | undefined {
    return this.write("debug", message, context);
  }

  info(message: string, context?: Readonly<Record<string, unknown>>): LogEntry | undefined {
    return this.write("info", message, context);
  }

  warn(message: string, context?: Readonly<Record<string, unknown>>): LogEntry | undefined {
    return this.write("warn", message, context);
  }

  error(message: string, context?: Readonly<Record<string, unknown>>): LogEntry | undefined {
    return this.write("error", message, context);
  }

  private write(
    level: LogLevel,
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ): LogEntry | undefined {
    return this.sink.log(level, this.channel, message, {
      ...this.boundContext,
      ...context,
    });
  }
}

/**
 * console 镜像：桌面 app 的 devtools 里直接可读。
 *
 * vitest（import.meta.env.MODE === "test"）下不镜像：测试断言走环形缓冲，
 * 预期内的 warn/error（失败路径用例）不再污染测试 stderr；
 * 环形缓冲与诊断页行为不受影响。
 */
export function mirrorToConsole(entry: LogEntry): void {
  const { env } = import.meta as ImportMeta & { env?: { MODE?: string } };
  if (env?.MODE === "test") {
    return;
  }
  const time = entry.timestamp.slice(11, 23);
  const contextText =
    Object.keys(entry.context).length > 0
      ? ` ${JSON.stringify(entry.context)}`
      : "";
  const line = `[${time}] [${entry.channel}] ${entry.message}${contextText}`;
  switch (entry.level) {
    case "debug":
      console.debug(line);
      break;
    case "info":
      console.info(line);
      break;
    case "warn":
      console.warn(line);
      break;
    case "error":
      console.error(line);
      break;
  }
}

const consoleTarget: LogTarget = {
  log(level, channel, message, context) {
    const entry = createLogEntry(0, level, channel, message, context);
    mirrorToConsole(entry);
    return entry;
  },
};

/** Standalone callers can log to the console without a capture buffer. */
export const createLogger: LoggerFactory = (channel, context) =>
  new Logger(consoleTarget, channel, context);
