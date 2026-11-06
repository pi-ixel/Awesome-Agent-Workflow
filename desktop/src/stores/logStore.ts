/**
 * 诊断数据 store：把 core 层环形缓冲桥接为 React 可订阅状态。
 *
 * 数据流是单向的：ring 缓冲（core/logger）是唯一真相源，本 store 只做
 * 镜像；业务侧的写入口是 core/logger 的 `appLogSink`，
 * ring 的订阅回执会驱动这里的镜像刷新。
 */
import { create } from "zustand";
import { appLogSink, type LogEntry, type LogLevel } from "../core/logger";

interface LogStoreState {
  /** 业务日志快照（自 appLogSink 镜像）。 */
  entries: readonly LogEntry[];
  /** 当前全局日志级别。 */
  level: LogLevel;
  /** 调整全局日志级别。 */
  setLevel: (level: LogLevel) => void;
  /** 清空业务日志环形缓冲。 */
  clear: () => void;
}

export const useLogStore = create<LogStoreState>((set) => ({
  entries: appLogSink.snapshot(),
  level: appLogSink.level,
  setLevel: (level) => {
    appLogSink.setLevel(level);
    set({ level });
  },
  clear: () => {
    appLogSink.clear();
    set({ entries: [] });
  },
}));

// ring -> store 镜像订阅：模块加载即建立，与组件生命周期解耦。
// 每次通知传入全量快照，容量（日志 2000）下拷贝成本可忽略；
// 若未来频率显著上升，再改为增量推送。
appLogSink.subscribe((snapshot) => useLogStore.setState({ entries: snapshot }));
