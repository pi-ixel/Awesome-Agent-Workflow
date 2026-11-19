export type CdpPage = { url: string; webSocketDebuggerUrl: string };
export type CdpEvaluation = {
  result?: { value?: unknown };
  exceptionDetails?: unknown;
};

export class BrowserCdpClient {
  private sequence = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: CdpEvaluation) => void; reject: (error: Error) => void }
  >();
  private constructor(private readonly socket: WebSocket) {
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        error?: unknown;
        result?: CdpEvaluation;
      };
      if (typeof message.id !== "number") return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error)
        pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result ?? {});
    };
  }
  static async connect(page: CdpPage): Promise<BrowserCdpClient> {
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("CDP socket failed"));
    });
    return new BrowserCdpClient(socket);
  }
  async evaluate(expression: string, timeoutMs = 15000): Promise<unknown> {
    const result = await this.send(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
      timeoutMs,
    );
    if (result.exceptionDetails)
      throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  }
  private send(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<CdpEvaluation> {
    const id = ++this.sequence;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timeout`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }
  close(): void {
    this.socket.close();
  }
}

export async function browserPages(): Promise<CdpPage[]> {
  const response = await fetch("http://127.0.0.1:9223/json/list");
  if (!response.ok) throw new Error("CDP_NOT_AVAILABLE");
  return (await response.json()) as CdpPage[];
}

export async function connectBrowserMain(): Promise<BrowserCdpClient> {
  const mainPage = (await browserPages()).find(
    (page) => page.url === "http://localhost:1420/",
  );
  if (!mainPage) throw new Error("AAW_MAIN_WINDOW_NOT_FOUND");
  return BrowserCdpClient.connect(mainPage);
}

export const browserSleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
