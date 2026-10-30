/** One pending/ready resource per key, with bounded background preparation. */
export class StandbyConnections<T> {
  private entries = new Map<
    string,
    {
      promise: Promise<T | null>;
      value?: T;
      cancelled: boolean;
      run: () => Promise<void>;
      finish: (value: T | null) => void;
    }
  >();
  private queue: Array<() => Promise<void>> = [];
  private running = 0;
  private tasks = new Set<Promise<void>>();
  private cleanups = new Set<Promise<void>>();

  constructor(
    private dispose: (value: T) => Promise<void>,
    private limit = 2,
  ) {}

  private release(value: T): Promise<void> {
    const task = this.dispose(value).catch(() => undefined);
    this.cleanups.add(task);
    void task.finally(() => this.cleanups.delete(task));
    return task;
  }

  ensure(
    key: string,
    prepare: (isCurrent: () => boolean) => Promise<T | null>,
    priority = false,
  ): Promise<T | null> {
    const existing = this.entries.get(key);
    if (existing) {
      if (priority) {
        const index = this.queue.indexOf(existing.run);
        if (index >= 0) this.queue.unshift(...this.queue.splice(index, 1));
      }
      return existing.promise;
    }
    let finish!: (value: T | null) => void;
    const promise = new Promise<T | null>((resolve) => {
      finish = resolve;
    });
    const entry = {
      promise,
      finish,
      cancelled: false,
      value: undefined as T | undefined,
      run: async () => {
        if (entry.cancelled) return;
        try {
          const value = await prepare(() => !entry.cancelled);
          if (entry.cancelled) {
            if (value) await this.release(value);
            return;
          }
          if (value) entry.value = value;
          else if (this.entries.get(key) === entry) this.entries.delete(key);
          finish(value);
        } catch {
          if (this.entries.get(key) === entry) this.entries.delete(key);
          finish(null);
        }
      },
    };
    this.entries.set(key, entry);
    if (priority) this.queue.unshift(entry.run);
    else this.queue.push(entry.run);
    this.drain();
    return promise;
  }

  private drain(): void {
    while (this.running < this.limit && this.queue.length) {
      const run = this.queue.shift()!;
      this.running++;
      const task = run().finally(() => {
        this.tasks.delete(task);
        this.running--;
        this.drain();
      });
      this.tasks.add(task);
    }
  }

  async take(key: string): Promise<T | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    const value = await entry.promise;
    if (entry.cancelled || this.entries.get(key) !== entry) return null;
    this.entries.delete(key);
    return value;
  }

  invalidate(keep: (key: string) => boolean): void {
    for (const [key, entry] of this.entries) {
      if (keep(key)) continue;
      this.entries.delete(key);
      entry.cancelled = true;
      entry.finish(null);
      const index = this.queue.indexOf(entry.run);
      if (index >= 0) this.queue.splice(index, 1);
      if (entry.value) void this.release(entry.value);
    }
  }

  async close(): Promise<void> {
    const pending = [...this.entries.values()].map((entry) => entry.promise);
    this.invalidate(() => false);
    await Promise.all(pending);
    await Promise.all([...this.tasks]);
    await Promise.all([...this.cleanups]);
  }
}
