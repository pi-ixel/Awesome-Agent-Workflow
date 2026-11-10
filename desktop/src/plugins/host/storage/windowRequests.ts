/** Request/response channel shared by the main and diagnostic WebViews. */
export function openWindowRequests<Request, Response>(
  name: string,
  handle?: (request: Request) => Promise<Response>,
) {
  const channel =
    typeof BroadcastChannel === "undefined"
      ? undefined
      : new BroadcastChannel(name);
  const pending = new Map<
    string,
    (reply?: { value?: Response; error?: string }) => void
  >();
  let closed = false;
  if (channel)
    channel.onmessage = async ({ data }) => {
      if (!data || typeof data.id !== "string") return;
      if (data.type === "reply") {
        pending.get(data.id)?.(data);
        return;
      }
      if (!handle || data.type !== "request") return;
      const reply: {
        type: string;
        id: string;
        value?: Response;
        error?: string;
      } = {
        type: "reply",
        id: data.id,
      };
      try {
        reply.value = await handle(data.request);
      } catch (error) {
        reply.error = String(error);
      }
      if (!closed) channel.postMessage(reply);
    };
  return {
    request(request: Request): Promise<Response> {
      if (closed || !channel)
        return Promise.reject(new Error("存储服务不可用"));
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => pending.get(id)?.(), 15_000);
        pending.set(id, (reply) => {
          clearTimeout(timer);
          pending.delete(id);
          if (reply?.value !== undefined) resolve(reply.value);
          else
            reject(
              new Error(
                reply?.error ?? "主窗口未返回存储操作结果，请刷新确认当前状态",
              ),
            );
        });
        channel.postMessage({ type: "request", id, request });
      });
    },
    dispose() {
      closed = true;
      channel?.close();
      for (const complete of pending.values()) complete();
    },
  };
}
