/**
 * 诊断页「性能」页签（评审定稿）：只回答资源消耗——
 * - **内存**：折线图（应用启动起每秒采样，保留最近 10 分钟），标注当前
 *   值与区间峰值；异常膨胀（>1.5 GB）时给重启/报修指引；
 * - **对话存储**：浏览器真实配额（navigator.storage.estimate）的已用 /
 *   总量 / 百分比，配接近满时的行为说明。
 *
 * 不承载：流畅度体检、历史重渲验证、压测灌入——这些由 CI 基准测试
 * （tests/perf）承担，页面上不出现开发工具。
 */
import { useEffect, useState } from "react";

import { measureConversationStorage } from "../conversationStorage.ts";
import { MemoryChart } from "./perf/MemoryChart.tsx";
import { useStore } from "zustand";
import type { DiagnosticsService, MemorySample } from "../../../contracts/diagnostics.ts";

/** 内存异常膨胀的提醒线（与折线图判读解耦：图看趋势，线管报警）。 */
const MEMORY_WARN_BYTES = 1.5 * 1024 * 1024 * 1024;

/**
 * 对话历史的本机存储预算（约数）：Chromium 系对 localStorage 按源给的
 * 上限约 5 MB（浏览器无精确配额查询接口；navigator.storage.estimate 只
 * 统计 IndexedDB/Cache，量不到 localStorage，不能用）。
 */
const STORAGE_BUDGET_BYTES = 5 * 1024 * 1024;

function mbOf(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function PerfHud({ memory }: { memory: DiagnosticsService["memory"] }) {
  const samples = useStore(memory.samples);
  // 折线图每秒跟随新样本刷新一帧（页面关闭时不跑）
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setTick((tick) => tick + 1);
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);

  return (
    <PerfReport
      samples={samples}
      supported={memory.supported}
      storage={measureConversationStorage()}
    />
  );
}

export function PerfReport({
  samples,
  supported,
  storage,
}: {
  readonly samples: readonly MemorySample[];
  readonly supported: boolean;
  readonly storage: { bytes: number; projects: number };
}) {
  const currentBytes = samples.at(-1)?.bytes ?? 0;

  return (
    <div className="space-y-6">
      <section aria-label="内存" className="space-y-2">
        <h3 className="text-sm font-medium text-ink">内存</h3>
        {supported ? (
          <>
            <MemoryChart samples={samples} />
            {currentBytes > MEMORY_WARN_BYTES ? (
              <p className="text-xs text-warn-ink">
                内存占用异常偏高：请重启应用后复测；复现请截图本页报修
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-ink-faint">此环境不支持内存读数</p>
        )}
      </section>
      <section aria-label="对话存储" className="space-y-1.5">
        <h3 className="text-sm font-medium text-ink">对话存储</h3>
        <p className="font-mono text-sm text-ink">
          已用 {mbOf(storage.bytes)}（{storage.projects} 个项目）/ 上限约{" "}
          {mbOf(STORAGE_BUDGET_BYTES)}
        </p>
        <p className="text-xs text-ink-ghost">
          接近上限时最早的对话自动精简，不影响新对话
        </p>
      </section>
    </div>
  );
}
