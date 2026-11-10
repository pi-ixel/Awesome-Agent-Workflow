/** Serializes user navigation within one Project instance. */
export class SessionNavigationQueue {
  private tail = Promise.resolve();
  private revision = 0;
  private disposed = false;
  private readonly cancellations = new Set<() => void>();

  enqueue<T>(
    task: (isLatest: () => boolean) => Promise<T>,
    cancelled: T,
  ): Promise<T> {
    if (this.disposed) return Promise.resolve(cancelled);
    const revision = ++this.revision;
    const isLatest = () => !this.disposed && revision === this.revision;
    const work = this.tail.then(() =>
      this.disposed ? cancelled : task(isLatest),
    );
    this.tail = work.then(
      () => undefined,
      () => undefined,
    );
    return new Promise<T>((resolve, reject) => {
      const cancel = () => resolve(cancelled);
      this.cancellations.add(cancel);
      void work
        .then(resolve, reject)
        .finally(() => this.cancellations.delete(cancel));
    });
  }

  supersede(): void {
    ++this.revision;
  }

  dispose(): void {
    this.disposed = true;
    for (const cancel of this.cancellations) cancel();
    this.cancellations.clear();
  }
}
