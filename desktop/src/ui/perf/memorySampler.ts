/**
 * 内存采样器：应用启动起每秒读一次 performance.memory（Chromium 私有），
 * 环形保留最近 10 分钟——诊断页「性能」折线图的数据源。
 *
 * - 只在支持 performance.memory 的环境记录（WebView2 / Chrome 支持，
 *   jsdom 不支持）；不支持时 memorySamplingSupported=false，页面显示
 *   「此环境不支持内存读数」；
 * - 后台标签的定时器会被浏览器节流（≥1s），样本变稀不影响正确性；
 * - 单例定时器不停止：每秒一次的读数量级可忽略，换来随时打开都有历史。
 */
export interface MemorySample {
  /** 采样时刻（epoch 毫秒）。 */
  readonly at: number;
  readonly bytes: number;
}

/** 采样间隔（毫秒）。 */
const SAMPLE_INTERVAL_MS = 1000;
/** 环形缓冲容量：600 点 = 10 分钟。 */
export const MAX_MEMORY_SAMPLES = 600;

const samples: MemorySample[] = [];

interface MemoryLike {
  readonly usedJSHeapSize?: number;
}

function readMemory(): MemoryLike | null {
  const memory = (performance as Performance & { readonly memory?: MemoryLike })
    .memory;
  return typeof memory === "object" && memory !== null ? memory : null;
}

export const memorySamplingSupported: boolean = readMemory() !== null;

/** 记录一个样本（超容量丢最旧）；测试直接灌样本也走这里。 */
export function recordMemorySample(at: number, bytes: number): void {
  samples.push({ at, bytes });
  if (samples.length > MAX_MEMORY_SAMPLES) {
    samples.shift();
  }
}

if (
  memorySamplingSupported &&
  new URLSearchParams(location.search).get("diagnostics") !== "1"
) {
  setInterval(() => {
    const memory = readMemory();
    if (memory !== null && typeof memory.usedJSHeapSize === "number") {
      recordMemorySample(Date.now(), memory.usedJSHeapSize);
    }
  }, SAMPLE_INTERVAL_MS);
}

/** 最近样本的快照（拷贝，渲染期间不受后续写入影响）。 */
export function getMemorySamples(): readonly MemorySample[] {
  return [...samples];
}
