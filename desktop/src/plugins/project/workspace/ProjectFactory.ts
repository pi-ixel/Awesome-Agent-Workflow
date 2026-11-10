import type { SessionInfo } from "../../../contracts/acp/protocol.ts";
import { pathKey } from "../../../shared/panelPaths.ts";
import { ProjectContext } from "./ProjectContext.ts";

export class ProjectFactory<
  Session extends { readonly workspacePath: string } = { readonly workspacePath: string },
> {
  private readonly projects = new Map<string, ProjectContext<Session>>();
  private readonly preparationQueue: Array<() => Promise<void>> = [];
  private preparing = 0;
  constructor(private readonly preparationLimit = 2) {}
  preloadPaths(paths: readonly string[]): readonly string[] {
    return [
      ...new Map(paths.map((path) => [pathKey(path), path])).values(),
    ].slice(0, 10);
  }
  invalidateWarmups(keep: (agentKey: string, path: string) => boolean): void {
    for (const project of this.projects.values())
      project.invalidateWarmups((agentKey) =>
        keep(agentKey, project.workspacePath),
      );
  }
  private drainPreparations(): void {
    while (
      this.preparing < this.preparationLimit &&
      this.preparationQueue.length
    ) {
      const run = this.preparationQueue.shift()!;
      this.preparing++;
      void run().finally(() => {
        this.preparing--;
        this.drainPreparations();
      });
    }
  }
  prepare(
    path: string,
    agentKey: string,
    prepare: (
      isCurrent: () => boolean,
    ) => Promise<readonly SessionInfo[] | null>,
    priority = false,
  ): Promise<readonly SessionInfo[] | null> {
    return this.open(path).ensurePreparation(
      agentKey,
      prepare,
      (run, urgent) => {
        if (urgent) this.preparationQueue.unshift(run);
        else this.preparationQueue.push(run);
        this.drainPreparations();
      },
      (run) => {
        const index = this.preparationQueue.indexOf(run);
        if (index >= 0)
          this.preparationQueue.unshift(
            ...this.preparationQueue.splice(index, 1),
          );
      },
      priority,
    );
  }
  invalidatePreparations(
    keep: (agentKey: string, path: string) => boolean,
  ): void {
    for (const project of this.projects.values())
      project.invalidatePreparations((agentKey) =>
        keep(agentKey, project.workspacePath),
      );
  }
  async closePreparations(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.projects.values()].map((project) => project.closePreparations()),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (errors.length)
      throw new AggregateError(errors, "Project preparation cleanup failed");
  }
  open(path: string): ProjectContext<Session> {
    const key = pathKey(path);
    let project = this.projects.get(key);
    if (!project) {
      project = new ProjectContext<Session>(path);
      this.projects.set(key, project);
    }
    return project;
  }
  list(): readonly ProjectContext<Session>[] {
    return [...this.projects.values()];
  }
  *sessions(): IterableIterator<Session> {
    for (const project of this.projects.values()) yield* project.sessions;
  }
  addSession(session: Session): void {
    this.open(session.workspacePath).add(session);
  }
  removeSession(session: Session): void {
    this.projects.get(pathKey(session.workspacePath))?.sessions.delete(session);
  }
  hasSession(session: Session): boolean {
    return (
      this.projects
        .get(pathKey(session.workspacePath))
        ?.sessions.has(session) ?? false
    );
  }
  async close(
    path: string,
    dispose: (session: Session) => Promise<void>,
  ): Promise<void> {
    const key = pathKey(path),
      project = this.projects.get(key);
    if (!project) return;
    try {
      await project.close(dispose);
    } finally {
      if (this.projects.get(key) === project) this.projects.delete(key);
    }
  }
}
