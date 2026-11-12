/**
 * 两级错误边界（对齐 ZCode 的分层容错，按我们的体量裁剪）：
 *
 * - **AppErrorBoundary（根级）**：整树兜底。任何未捕获的渲染异常落到
 *   这里时，保留可用的错误界面（摘要 + 堆栈折叠 + 重试 / 刷新），
 *   而不是 WebView 白屏——用户至少能自救，能复制错误去反馈。
 * - **ScopedErrorBoundary（局部）**：包在单个面板外（时间线 / 消息流 /
 *   AAW 面板），那块崩了只重置那块，其余界面照常工作；`resetKey` 变化
 *   （切会话 / 切项目）时自动重置，避免换了个数据还停在旧错误上。
 *
 * 边界内错误都进 logger（诊断页可见），不静默。
 */
import { Component, type ErrorInfo, type ReactNode, type ContextType } from "react";

import { LoggerContext } from "../logging/react.ts";


interface FallbackProps {
  readonly error: Error;
  readonly onRetry: () => void;
}

/** 堆栈折叠（原生 details，零依赖）。 */
function StackDetails({ error }: { readonly error: Error }) {
  return (
    <details className="w-full">
      <summary className="cursor-pointer text-xs text-ink-faint">
        技术细节
      </summary>
      <pre className="mt-1 max-h-48 overflow-auto rounded bg-base p-2 text-left font-mono text-2xs whitespace-pre-wrap break-words text-ink-ghost">
        {error.stack ?? error.message}
      </pre>
    </details>
  );
}

/** 根级兜底：居中错误卡 + 自救出口。 */
function AppFallback({ error, onRetry }: FallbackProps) {
  return (
    <div
      role="alert"
      className="flex h-full flex-col items-center justify-center gap-3 bg-base p-8 text-center"
    >
      <p className="text-sm font-medium text-ink">界面出现异常</p>
      <p className="max-w-md text-xs leading-relaxed text-ink-mute">
        {error.message || "渲染时发生未捕获的错误。"}
      </p>
      <StackDetails error={error} />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-line-strong bg-surface px-3 py-1.5 text-xs text-ink transition-colors hover:bg-raised"
        >
          重试
        </button>
        <button
          type="button"
          onClick={() => {
            window.location.reload();
          }}
          className="rounded-md border border-line-strong px-3 py-1.5 text-xs text-ink-mute transition-colors hover:bg-raised"
        >
          刷新页面
        </button>
      </div>
    </div>
  );
}

/** 局部兜底：面板内一行错误 + 重试。 */
function PanelFallback({
  error,
  onRetry,
  scope,
}: FallbackProps & { readonly scope: string }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-xs text-ink-mute"
    >
      <span className="font-medium text-ink">{scope}</span>
      <span className="min-w-0 flex-1 truncate" data-hint={error.message}>
        加载失败：{error.message}
      </span>
      <button
        type="button"
        onClick={onRetry}
        className="shrink-0 rounded border border-line-strong px-2 py-0.5 text-xs text-ink transition-colors hover:bg-raised"
      >
        重试
      </button>
    </div>
  );
}

interface BoundaryProps {
  readonly children: ReactNode;
}

interface BoundaryState {
  readonly error: Error | null;
}

abstract class ErrorBoundaryBase extends Component<
  BoundaryProps,
  BoundaryState
> {
  static override contextType = LoggerContext;
  declare context: ContextType<typeof LoggerContext>;

  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.context("ui").error("渲染异常被边界捕获", {
      message: error.message,
      componentStack: info.componentStack ?? null,
    });
  }

  protected abstract renderFallback(error: Error, retry: () => void): ReactNode;

  override render(): ReactNode {
    const { error } = this.state;
    if (error !== null) {
      return this.renderFallback(error, () => {
        this.setState({ error: null });
      });
    }
    return this.props.children;
  }
}

/** 根级：包住整个应用外壳。 */
export class AppErrorBoundary extends ErrorBoundaryBase {
  protected override renderFallback(error: Error, retry: () => void) {
    return <AppFallback error={error} onRetry={retry} />;
  }
}

interface ScopedBoundaryProps extends BoundaryProps {
  /** 面板名（fallback 文案与日志定位）。 */
  readonly scope: string;
  /** 变化即重置（切会话 / 切项目后不该停留在旧数据的错误上）。 */
  readonly resetKey?: string | number;
}

/** 局部：包住单个面板，崩了不殃及全局。 */
export class ScopedErrorBoundary extends Component<
  ScopedBoundaryProps,
  BoundaryState
> {
  static override contextType = LoggerContext;
  declare context: ContextType<typeof LoggerContext>;

  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.context("ui").error("面板渲染异常（局部边界）", {
      scope: this.props.scope,
      message: error.message,
      componentStack: info.componentStack ?? null,
    });
  }

  override componentDidUpdate(prevProps: ScopedBoundaryProps): void {
    if (
      this.state.error !== null &&
      prevProps.resetKey !== this.props.resetKey
    ) {
      this.setState({ error: null });
    }
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error !== null) {
      return (
        <PanelFallback
          scope={this.props.scope}
          error={error}
          onRetry={() => {
            this.setState({ error: null });
          }}
        />
      );
    }
    return this.props.children;
  }
}
