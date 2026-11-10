type Cleanup = () => void | Promise<void>;
type Release = (cleanup?: Cleanup) => Promise<void>;

/** 宿主实例等待申请结束，再释放调用方遗留的资源。 */
export class HostResources {
  private readonly opening = new Set<Promise<unknown>>();
  private readonly resources = new Set<Release>();
  private stopping?: Promise<void>;

  isActive(): boolean {
    return this.stopping === undefined;
  }

  /** Discard results after unload without holding disposal for a read or command. */
  async run<T>(request: () => Promise<T>): Promise<T> {
    this.assertOpen();
    const result = await request();
    this.assertOpen();
    return result;
  }

  acquire<T>(open: () => Promise<T>): Promise<T> {
    const task = Promise.resolve().then(() => this.run(open));
    this.opening.add(task);
    const finished = () => {
      this.opening.delete(task);
    };
    void task.then(finished, finished);
    return task;
  }

  own(cleanup: Cleanup): Release {
    let pending: Promise<void> | undefined;
    const release: Release = (dispose = cleanup) => {
      if (!this.resources.has(release)) return Promise.resolve();
      if (pending) return pending;
      try {
        pending = Promise.resolve(dispose()).then(
          () => {
            this.resources.delete(release);
          },
          (error: unknown) => {
            pending = undefined;
            throw error;
          },
        );
        return pending;
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error("宿主资源释放失败", { cause: error }),
        );
      }
    };
    this.resources.add(release);
    return release;
  }

  listen(install: () => Promise<Cleanup>): Promise<() => void> {
    return this.acquire(async () => {
      const cleanup = await install();
      const release = this.own(cleanup);
      return () => {
        void release().catch(() => {});
      };
    });
  }

  dispose(): Promise<void> {
    return (this.stopping ??= (async () => {
      await Promise.allSettled(this.opening);
      const results = await Promise.allSettled(
        [...this.resources].map((release) => release()),
      );
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : [],
      );
      if (errors.length) throw new AggregateError(errors, "宿主资源释放失败");
    })());
  }

  private assertOpen(): void {
    if (this.stopping) throw new Error("宿主实例正在卸载");
  }
}

/** 业务侧正常收尾后释放句柄。兜底先停止进程，再清理原生进程表。 */
export function trackProcesses<T>(
  resources: HostResources,
  handleOf: (value: T) => number,
  kill: (handle: number) => Promise<unknown>,
  release: (handle: number) => Promise<void>,
) {
  const handles = new Map<number, Release>();
  const forget = async (handle: number) => {
    await release(handle);
    handles.delete(handle);
  };
  return {
    spawn: (spawn: () => Promise<T>) =>
      resources.acquire(async () => {
        const process = await spawn();
        const handle = handleOf(process);
        if (typeof handle !== "number") return process;
        handles.set(
          handle,
          resources.own(async () => {
            await kill(handle);
            await forget(handle);
          }),
        );
        return process;
      }),
    release: (handle: number) =>
      handles.get(handle)?.(() => forget(handle)) ?? Promise.resolve(),
  };
}
