/**
 * Workbench 的轻量 toast 通知：复制成功 / 配置保存这类「做了什么、
 * 成了没有」的一过性反馈，不值得弹窗，也不该毫无表示——toast 是中间层。
 *
 * 语义（对齐 ZCode 的自研 toast，按我们的体量裁剪）：
 * - 默认 3 秒自动消失，`durationMs: 0` 表示持续到显式关闭（进度态）；
 * - `dedupeKey`：同业务键的新 toast **替换**旧条目（如「已复制」连点
 *   不堆叠），无键的各自独立堆叠；
 * - 退场由 ToastHost 的定时器驱动，卸载 Workbench 清空待显示条目。
 */
import { createStore } from "zustand";
import type { ToastItem, ToastState } from "../../contracts/feedback.ts";

import { createLogger } from "../../shared/diagnosticEvents/logger.ts";

const logger = createLogger("ui");

export function createToastStore() {
  let active = true;
  let nextId = 1;
  const store = createStore<ToastState>((set) => ({
    items: [],

    push: (input) => {
      if (!active) return;
      const item: ToastItem = {
        id: nextId++,
        message: input.message,
        variant: input.variant ?? "info",
        durationMs: input.durationMs ?? 3000,
        dedupeKey: input.dedupeKey ?? null,
      };
      set((state) => ({
        // 同 dedupeKey 的旧条目被本条替换；无键的各自追加（不能把别的不带键
        // 条目也滤掉——null !== null 恒 false 的反直觉陷阱）
        items: [
          ...(item.dedupeKey === null
            ? state.items
            : state.items.filter(
                (existing) => existing.dedupeKey !== item.dedupeKey,
              )),
          item,
        ].slice(-5),
      }));
      logger.debug("toast", { message: item.message, variant: item.variant });
    },

    dismiss: (id) => {
      if (!active) return;
      set((state) => ({
        items: state.items.filter((item) => item.id !== id),
      }));
    },
  }));

  return {
    store,
    dispose() {
      active = false;
      store.setState({ items: [] });
    },
  };
}
