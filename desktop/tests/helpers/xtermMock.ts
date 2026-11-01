/**
 * xterm 三件套（@xterm/xterm / @xterm/addon-fit / @xterm/addon-clipboard）
 * 的测试替身：jsdom 无真实渲染面（canvas 度量、字符尺寸测量均不可用），
 * 终端面板的 UI 测试只关心页签语义与挂载关系，xterm 以桩类替代。
 *
 * 用法（vi.mock 工厂在提升期运行，只能经动态 import 载入本模块）：
 *   vi.mock("@xterm/xterm", async () => await import("<rel>/helpers/xtermMock.ts"));
 *   vi.mock("@xterm/addon-fit", async () => await import("<rel>/helpers/xtermMock.ts"));
 *   vi.mock("@xterm/addon-clipboard", async () => await import("<rel>/helpers/xtermMock.ts"));
 *
 * 桩件刻意覆盖真实 Terminal 的视图用面（write / onData / options /
 * hasSelection / paste / focus / dispose…），未覆盖到的调用会在测试中
 * 以 TypeError 暴露，避免静默假阳性。
 */

type Disposable = { dispose: () => void };

export class Terminal {
  cols = 80;
  rows = 24;
  options: Record<string, unknown> = {};
  /** 全部实例（跨用例断言挂载 / dispose 用，测试自管重置）。 */
  static instances: Terminal[] = [];

  written: Array<string | Uint8Array> = [];
  disposed = false;
  focused = false;
  /** open() 是否已调用（延迟 open 回归断言用）。 */
  opened = false;
  /** open() 调用次数（重开面板不得重复 open，openedRef 防重入断言用）。 */
  openCalls = 0;
  private onDataCallbacks: Array<(data: string) => void> = [];

  constructor(options?: Record<string, unknown>) {
    if (options !== undefined) {
      this.options = { ...options };
    }
    Terminal.instances.push(this);
  }

  loadAddon(): void {}
  open(): void {
    this.opened = true;
    this.openCalls += 1;
  }
  focus(): void {
    this.focused = true;
  }
  dispose(): void {
    this.disposed = true;
  }
  write(data: string | Uint8Array): void {
    this.written.push(data);
  }
  writeln(data: string | Uint8Array): void {
    this.write(data);
  }
  paste(data: string): void {
    this.write(data);
  }
  getSelection(): string {
    return "";
  }
  hasSelection(): boolean {
    return false;
  }
  clear(): void {}
  attachCustomKeyEventHandler(): void {}
  registerLinkProvider(): Disposable {
    return { dispose: () => {} };
  }
  registerOscHandler(): Disposable {
    return { dispose: () => {} };
  }
  onData(callback: (data: string) => void): Disposable {
    this.onDataCallbacks.push(callback);
    return {
      dispose: () => {
        this.onDataCallbacks = this.onDataCallbacks.filter(
          (cb) => cb !== callback,
        );
      },
    };
  }

  /** 测试驱动键入（触发 term.onData 订阅者）。 */
  emitData(data: string): void {
    for (const callback of [...this.onDataCallbacks]) {
      callback(data);
    }
  }
}

export class FitAddon {
  fit(): void {}
  proposeDimensions(): { cols: number; rows: number } | undefined {
    return { cols: 80, rows: 24 };
  }
}

export class ClipboardAddon {}
