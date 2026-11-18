import type {
  AcpTransport,
  TransportExit,
  TransportExitHandler,
} from "../../host/types.ts";

/** 退出确认统一归还启动额度，并保留传输原有的退出订阅语义。 */
export function budgetedTransport(
  raw: AcpTransport,
  release: () => void,
): AcpTransport {
  let exit: TransportExit | undefined;
  const listeners = new Set<TransportExitHandler>();
  const exited = (result: TransportExit) => {
    if (exit) return;
    exit = result;
    release();
    for (const listener of listeners) listener(result);
  };
  raw.onExit(exited);
  return {
    get processHandle() {
      return raw.processHandle;
    },
    get isClosed() {
      return raw.isClosed;
    },
    writeLine: (line) => raw.writeLine(line),
    ...(raw.writeLineConfirmed
      ? { writeLineConfirmed: (line: string) => raw.writeLineConfirmed!(line) }
      : {}),
    onLine: (handler) => raw.onLine(handler),
    onStderr: (handler) => raw.onStderr(handler),
    onExit: (handler) => {
      listeners.add(handler);
      if (exit) handler(exit);
    },
    ...(raw.onFailure
      ? {
          onFailure: (handler: (reason: string) => void) =>
            raw.onFailure!(handler),
        }
      : {}),
    close: async (graceMs) => {
      const result = await raw.close(graceMs);
      exited(result);
      return result;
    },
    kill: async () => {
      const result = await raw.kill();
      exited(result);
      return result;
    },
    dispose: () => raw.dispose?.(),
  };
}
