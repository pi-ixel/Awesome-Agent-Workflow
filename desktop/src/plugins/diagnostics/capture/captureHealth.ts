export interface DeliveryHealth {
  readonly failures: number;
  readonly paused: boolean;
  readonly dropped: number;
  readonly unconfirmed: number;
}

export interface CaptureHealth {
  readonly logs: DeliveryHealth;
  readonly raw: DeliveryHealth;
}

const channelName = "aaw-desktop:diagnostics-capture.v1";
export const captureHealthInterval = 2000;
export const captureHealthExpiry = 15000;

export function publishCaptureHealth(read: () => CaptureHealth): () => void {
  if (typeof BroadcastChannel !== "function") return () => {};
  const channel = new BroadcastChannel(channelName);
  const publish = () => channel.postMessage(read());
  channel.onmessage = ({ data }) => {
    if (data === "request") publish();
  };
  return () => channel.close();
}

function isDeliveryHealth(value: unknown): value is DeliveryHealth {
  return (
    value !== null &&
    typeof value === "object" &&
    "failures" in value &&
    typeof value.failures === "number" &&
    "paused" in value &&
    typeof value.paused === "boolean" &&
    "dropped" in value &&
    typeof value.dropped === "number" &&
    "unconfirmed" in value &&
    typeof value.unconfirmed === "number"
  );
}

export function subscribeCaptureHealth(
  read: (health: CaptureHealth) => void,
): () => void {
  const channel = new BroadcastChannel(channelName);
  channel.onmessage = ({ data }: MessageEvent<unknown>) => {
    if (
      data !== null &&
      typeof data === "object" &&
      "logs" in data &&
      isDeliveryHealth(data.logs) &&
      "raw" in data &&
      isDeliveryHealth(data.raw)
    ) {
      read({ logs: data.logs, raw: data.raw });
    }
  };
  const request = () => channel.postMessage("request");
  request();
  const timer = setInterval(request, captureHealthInterval);
  return () => {
    clearInterval(timer);
    channel.close();
  };
}
