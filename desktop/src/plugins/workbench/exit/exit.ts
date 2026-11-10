import type { HostExitGate, WindowHost } from "../../host/types.ts";
import type {
  ExitParticipant,
  ExitReason,
  ExitRequest,
  WorkbenchExit,
} from "../types.ts";

const EXIT_MIN_DISPLAY_MS = 2_000;
const EXIT_CLEANUP_BUDGET_MS = 10_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ExitCoordinator implements WorkbenchExit {
  private readonly participants = new Map<string, ExitParticipant>();
  private readonly windowListeners = new Set<() => void>();
  private inFlight = false;
  private disposed = false;
  private releasePendingUpdate?: () => void;

  constructor(
    private readonly window: WindowHost,
    private readonly gate: HostExitGate,
  ) {}

  registerExit(participant: ExitParticipant): () => void {
    if (this.disposed) throw new Error("Workbench is disposed");
    if (this.participants.has(participant.id))
      throw new Error(`Duplicate exit participant: ${participant.id}`);
    this.participants.set(participant.id, participant);
    return () => {
      if (this.participants.get(participant.id) === participant)
        this.participants.delete(participant.id);
    };
  }

  getExitWork(reason: ExitReason): readonly string[] {
    const work: string[] = [];
    for (const participant of this.participants.values()) {
      const description = participant.describeWork?.(reason);
      if (description) work.push(description);
    }
    return work;
  }

  hasExitWork(reason: ExitReason): boolean {
    return this.getExitWork(reason).length > 0;
  }

  listenForClose(onClose: () => void): () => void {
    if (this.disposed) return () => {};
    let detach: (() => void) | undefined;
    const release = () => {
      if (this.windowListeners.delete(release)) detach?.();
    };
    this.windowListeners.add(release);
    void this.window
      .listenForClose(() => {
        if (
          this.windowListeners.has(release) &&
          !this.inFlight &&
          !this.gate.isExiting()
        )
          onClose();
      })
      .then((unlisten) => {
        if (this.windowListeners.has(release)) detach = unlisten;
        else unlisten();
      })
      .catch((error: unknown) =>
        console.error("Window close listener failed", error),
      );
    return release;
  }

  async requestExit(request: ExitRequest): Promise<boolean> {
    if (this.disposed || this.inFlight || this.gate.isExiting()) return false;
    this.inFlight = true;
    let releaseGate: (() => void) | undefined;
    try {
      for (const item of this.participants.values()) {
        if (item.check && !(await item.check())) return false;
      }
      if (this.disposed) return false;
      if (
        request.reason === "update" &&
        !request.force &&
        this.hasExitWork("update")
      )
        return false;
      releaseGate = this.gate.begin();
      if (!releaseGate) return false;
      const prepare = async () => {
        const outcomes = await Promise.allSettled(
          [...this.participants.values()].map(async (item) =>
            item.prepare?.(request.reason, request.force),
          ),
        );
        const failures = outcomes.flatMap((outcome) =>
          outcome.status === "rejected" ? [outcome.reason as unknown] : [],
        );
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1)
          throw new AggregateError(failures, "Exit preparation failed");
      };
      if (request.reason === "update") {
        this.releasePendingUpdate = releaseGate;
        await prepare();
        if (this.disposed) return false;
        this.releasePendingUpdate = undefined;
        await request.handoff();
      } else {
        request.onAccepted();
        const display = delay(EXIT_MIN_DISPLAY_MS).then(() => {
          void this.window.hide().catch(() => {});
        });
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const budget = new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, EXIT_CLEANUP_BUDGET_MS);
        });
        const cleanup = prepare()
          .catch((error: unknown) =>
            console.error("Exit preparation failed", error),
          )
          .then(() => request.shutdown(request.force))
          .catch((error: unknown) =>
            console.error("Desktop shutdown failed", error),
          );
        await Promise.all([display, Promise.race([cleanup, budget])]);
        clearTimeout(timeout);
        await this.window.forceClose();
      }
      return true;
    } catch (error) {
      releaseGate?.();
      throw error;
    } finally {
      this.inFlight = false;
      this.releasePendingUpdate = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.releasePendingUpdate?.();
    this.releasePendingUpdate = undefined;
    for (const release of this.windowListeners) release();
    this.participants.clear();
  }
}
