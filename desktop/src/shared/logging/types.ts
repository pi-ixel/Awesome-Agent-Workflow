export type LogLevel = "debug" | "info" | "warn" | "error";

/** 结构化日志记录，context 只放可序列化的数据。 */
export interface LogEntry {
  /** 单调递增序号，诊断页据此稳定排序与去重。 */
  readonly seq: number;
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly channel: string;
  readonly message: string;
  readonly context: Readonly<Record<string, unknown>>;
}
