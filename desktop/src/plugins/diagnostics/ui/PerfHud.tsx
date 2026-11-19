import { useEffect, useState } from "react";

import { MemoryChart } from "./perf/MemoryChart.tsx";
import { useStore } from "zustand";
import type { DesktopDiagnostics } from "../lifecycle/diagnostics.ts";
import type { MemorySample } from "../types.ts";

/** 内存异常膨胀的提醒线（与折线图判读解耦：图看趋势，线管报警）。 */
const MEMORY_WARN_BYTES = 1.5 * 1024 * 1024 * 1024;

export function PerfHud({ memory }: { memory: DesktopDiagnostics["memory"] }) {
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

  return <PerfReport samples={samples} supported={memory.supported} />;
}

export function PerfReport({
  samples,
  supported,
}: {
  readonly samples: readonly MemorySample[];
  readonly supported: boolean;
}) {
  const currentBytes = samples.at(-1)?.bytes ?? 0;

  return (
    <div className="space-y-6">
      <section aria-label="前端 JS 内存" className="space-y-2">
        <h3 className="text-sm font-medium text-ink">前端 JS 内存</h3>
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
    </div>
  );
}
