interface RequestOptions {
  readonly background?: boolean;
  readonly signal?: AbortSignal;
}

function abortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error
    ? reason
    : new Error("Request aborted", { cause: reason });
}

interface WaitingRequest {
  background: boolean;
  readonly signal?: AbortSignal;
  readonly run: () => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  cleanup: () => void;
}

/** Per-connection admission for list/new/load/prompt. Control traffic bypasses it. */
export class RequestScheduler {
  private readonly waiting: WaitingRequest[] = [];
  private running = 0;
  private backgroundRunning = 0;
  private closed: Error | undefined;

  get runningRequests(): number {
    return this.running;
  }

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new Error("Request capacity must be a positive integer");
  }

  request<T>(
    operation: () => Promise<T>,
    options: RequestOptions = {},
  ): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    if (options.signal?.aborted)
      return Promise.reject(abortError(options.signal));
    return new Promise<T>((resolve, reject) => {
      const entry: WaitingRequest = {
        background: options.background === true,
        signal: options.signal,
        run: operation,
        resolve: (value) => resolve(value as T),
        reject,
        cleanup: () => {},
      };
      const abort = () => {
        const index = this.waiting.indexOf(entry);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        entry.cleanup();
        reject(abortError(options.signal));
        this.drain();
      };
      entry.cleanup = () => options.signal?.removeEventListener("abort", abort);
      options.signal?.addEventListener("abort", abort, { once: true });
      this.waiting.push(entry);
      this.drain();
    });
  }

  /** Taking over a prewarmed session promotes its queued work, never duplicates it. */
  promote(signal: AbortSignal): void {
    for (const entry of this.waiting) {
      if (entry.signal === signal) entry.background = false;
    }
    this.drain();
  }

  /** Reject queued work. Running work retains its slot until its operation settles. */
  close(reason = new Error("Connection request scheduler closed")): void {
    if (this.closed) return;
    this.closed = reason;
    for (const entry of this.waiting.splice(0)) {
      entry.cleanup();
      entry.reject(reason);
    }
  }

  private drain(): void {
    while (!this.closed && this.running < this.capacity) {
      let index = this.waiting.findIndex((entry) => !entry.background);
      if (index < 0 && this.backgroundRunning === 0)
        index = this.waiting.findIndex((entry) => entry.background);
      if (index < 0) return;
      const entry = this.waiting.splice(index, 1)[0]!;
      entry.cleanup();
      this.running++;
      if (entry.background) this.backgroundRunning++;
      void Promise.resolve()
        .then(() => {
          if (this.closed) throw this.closed;
          return entry.run();
        })
        .then(
          (value) => this.finish(entry, true, value),
          (error: unknown) => this.finish(entry, false, error),
        );
    }
  }

  private finish(
    entry: WaitingRequest,
    succeeded: boolean,
    value: unknown,
  ): void {
    this.running--;
    if (entry.background) this.backgroundRunning--;
    this.drain();
    if (succeeded) entry.resolve(value);
    else entry.reject(value);
  }
}
