import type { SessionInfo } from "../../../contracts/acp/protocol.ts";

export class ProjectContext<Session = unknown> {
  private readonly warmups = new Map<
    string,
    { cancelled: boolean; task: Promise<void> }
  >();
  private readonly warming = new Set<Promise<void>>();
  warmSessions(
    agentKey: string,
    query: () => Promise<readonly SessionInfo[] | null>,
    load: (sessionId: string) => Promise<unknown>,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (this.closing) return Promise.resolve();
    const existing = this.warmups.get(agentKey);
    if (existing) return existing.task;
    const entry = { cancelled: false, task: Promise.resolve() };
    const valid = () => !entry.cancelled && !this.closing && isCurrent();
    entry.task = Promise.resolve()
      .then(async () => {
        if (!valid()) {
          if (this.warmups.get(agentKey) === entry)
            this.warmups.delete(agentKey);
          return;
        }
        const history = await query();
        if (!history || !valid()) {
          if (this.warmups.get(agentKey) === entry)
            this.warmups.delete(agentKey);
          return;
        }
        const recent = [...history]
          .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
          .slice(0, 2);
        // Empty projects never create a session. Completed warmup is not replenished.
        const results = await Promise.allSettled(
          recent.map(async (item) =>
            valid() ? load(item.sessionId) : undefined,
          ),
        );
        const errors = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason as unknown] : [],
        );
        if (errors.length)
          throw new AggregateError(errors, "Session warmup failed");
      })
      .catch((error: unknown) => {
        if (this.warmups.get(agentKey) === entry) this.warmups.delete(agentKey);
        throw error;
      })
      .finally(() => this.warming.delete(entry.task));
    this.warmups.set(agentKey, entry);
    this.warming.add(entry.task);
    return entry.task;
  }
  invalidateWarmups(keep: (agentKey: string) => boolean): void {
    for (const [agentKey, entry] of this.warmups) {
      if (keep(agentKey)) continue;
      entry.cancelled = true;
      this.warmups.delete(agentKey);
    }
  }
  private readonly histories = new Map<string, readonly SessionInfo[]>();
  private readonly historyRevisions = new Map<string, number>();
  setHistory(agentKey: string, sessions: readonly SessionInfo[]): void {
    if (!this.closing) this.histories.set(agentKey, sessions);
  }
  history(agentKey: string): readonly SessionInfo[] {
    return this.histories.get(agentKey) ?? [];
  }
  /** Publish only a complete, still-current project history; never a partial page. */
  async refreshHistory(
    agentKey: string,
    readHistory: (valid: () => boolean) => Promise<readonly SessionInfo[] | null>,
    isCurrent: () => boolean,
  ): Promise<readonly SessionInfo[] | null> {
    const revision = (this.historyRevisions.get(agentKey) ?? 0) + 1;
    this.historyRevisions.set(agentKey, revision);
    const valid = () =>
      !this.closing &&
      this.historyRevisions.get(agentKey) === revision &&
      isCurrent();
    const history = await readHistory(valid);
    if (!history || !valid()) return null;
    this.setHistory(agentKey, history);
    return history;
  }
  private readonly preparations = new Map<
    string,
    {
      promise: Promise<readonly SessionInfo[] | null>;
      cancelled: boolean;
      run: () => Promise<void>;
      finish: (value: readonly SessionInfo[] | null) => void;
    }
  >();
  private readonly preparationTasks = new Set<Promise<void>>();
  private readonly preparationErrors: unknown[] = [];
  ensurePreparation(
    agentKey: string,
    prepare: (
      isCurrent: () => boolean,
    ) => Promise<readonly SessionInfo[] | null>,
    schedule: (run: () => Promise<void>, priority: boolean) => void,
    promote: (run: () => Promise<void>) => void,
    priority = false,
  ): Promise<readonly SessionInfo[] | null> {
    if (this.closing) return Promise.resolve(null);
    const existing = this.preparations.get(agentKey);
    if (existing) {
      if (priority) promote(existing.run);
      return existing.promise;
    }
    let finish!: (value: readonly SessionInfo[] | null) => void;
    const promise = new Promise<readonly SessionInfo[] | null>((resolve) => {
      finish = resolve;
    });
    const entry = {
      promise,
      finish,
      cancelled: false,
      run: async () => {
        if (entry.cancelled) return;
        const task = (async () => {
          try {
            const value = await prepare(
              () => !entry.cancelled && !this.closing,
            );
            if (entry.cancelled) return;
            if (!value && this.preparations.get(agentKey) === entry)
              this.preparations.delete(agentKey);
            finish(value);
          } catch (error) {
            this.preparationErrors.push(error);
            if (this.preparations.get(agentKey) === entry)
              this.preparations.delete(agentKey);
            finish(null);
          }
        })();
        this.preparationTasks.add(task);
        try {
          await task;
        } finally {
          this.preparationTasks.delete(task);
        }
      },
    };
    this.preparations.set(agentKey, entry);
    schedule(entry.run, priority);
    return promise;
  }
  invalidatePreparations(keep: (agentKey: string) => boolean): void {
    for (const [agentKey, entry] of this.preparations) {
      if (keep(agentKey)) continue;
      this.preparations.delete(agentKey);
      entry.cancelled = true;
      entry.finish(null);
    }
  }
  async closePreparations(): Promise<void> {
    this.invalidatePreparations(() => false);
    await Promise.all([...this.preparationTasks]);
    if (this.preparationErrors.length)
      throw new AggregateError(
        this.preparationErrors.splice(0),
        "Project preparation cleanup failed",
      );
  }
  readonly sessions = new Set<Session>();
  private closing?: Promise<void>;
  constructor(readonly workspacePath: string) {}
  add(session: Session): void {
    if (this.closing) throw new Error("Project is closing");
    this.sessions.add(session);
  }
  close(dispose: (session: Session) => Promise<void>): Promise<void> {
    this.invalidateWarmups(() => false);
    return (this.closing ??= (async () => {
      const results = await Promise.allSettled([
        this.closePreparations(),
        ...this.warming,
        ...[...this.sessions].map(dispose),
      ]);
      this.sessions.clear();
      const errors = results
        .filter((r) => r.status === "rejected")
        .map((r): unknown => r.reason);
      if (errors.length)
        throw new AggregateError(errors, "Project cleanup failed");
    })());
  }
}
