import { withDeadline } from "../../../shared/asyncDeadline.ts";

export const deliveryTimeoutMs = 2000;
const maxAttempts = 3;
const maxOutstanding = 2;
const maxRecords = 2000;

export interface DeliveryId {
  readonly epoch: string;
  readonly sequence: number;
}

interface Item<T> {
  readonly value: T;
  readonly bytes: number;
}

interface Batch<T> {
  readonly id: DeliveryId;
  readonly items: Item<T>[];
  attempts: number;
  timedOut: boolean;
  outstanding: number;
}

export function createDeliveryLane<T>({
  epoch,
  batchSize,
  byteLimit,
  recordByteLimit = byteLimit,
  timeoutMs = deliveryTimeoutMs,
  send,
  onAccepted,
}: {
  epoch: string;
  batchSize: number;
  byteLimit?: number;
  recordByteLimit?: number;
  timeoutMs?: number;
  send: (records: T[], id: DeliveryId) => Promise<void>;
  onAccepted?: (records: T[]) => void;
}) {
  const queue: Item<T>[] = [];
  let batch: Batch<T> | undefined;
  let sequence = 0;
  let bytes = 0;
  let outstanding = 0;
  let failures = 0;
  let dropped = 0;
  let unconfirmed = 0;
  let retryAfter = 0;
  let sending = false;
  let retired = false;

  function release(items: Item<T>[]) {
    for (const item of items) bytes -= item.bytes;
  }

  function complete(current: Batch<T>) {
    batch = undefined;
    if (!current.outstanding) release(current.items);
  }

  function push(value: T, size = 0) {
    if (retired) return;
    const isFull = queue.length + (batch?.items.length ?? 0) >= maxRecords;
    if (
      byteLimit !== undefined &&
      (isFull ||
        bytes + size > byteLimit ||
        size > (recordByteLimit ?? byteLimit))
    ) {
      dropped++;
      return;
    }
    if (isFull) {
      release(queue.splice(0, 1));
      dropped++;
    }
    queue.push({ value, bytes: size });
    bytes += size;
  }

  async function flush(limit = 1): Promise<void> {
    if (sending) return;
    sending = true;
    try {
      for (let count = 0; count < limit; count++) {
        if (retired || outstanding >= maxOutstanding || Date.now() < retryAfter)
          return;
        if (!batch && queue.length) {
          batch = {
            id: { epoch, sequence: ++sequence },
            items: queue.splice(0, batchSize),
            attempts: 0,
            timedOut: false,
            outstanding: 0,
          };
        }
        const current = batch;
        if (!current) return;
        const records = current.items.map(({ value }) => value);
        current.attempts++;
        current.outstanding++;
        outstanding++;
        let settled = false;
        // 超时不会取消原生请求。在真正完成前保留其请求名额。
        const request = Promise.resolve()
          .then(() => send(records, current.id))
          .then(() => {
            if (retired || batch !== current) return;
            complete(current);
            failures = 0;
            retryAfter = 0;
            onAccepted?.(records);
          })
          .finally(() => {
            settled = true;
            outstanding--;
            current.outstanding--;
            if (batch !== current && !current.outstanding)
              release(current.items);
          });
        try {
          await withDeadline(request, timeoutMs, "采集上报超时");
        } catch {
          if (retired || batch !== current) return;
          current.timedOut ||= !settled;
          failures++;
          retryAfter = Date.now() + Math.min(250 * 2 ** (failures - 1), 8000);
          if (current.attempts >= maxAttempts) {
            if (current.timedOut) unconfirmed += current.items.length;
            else dropped += current.items.length;
            complete(current);
          }
          return;
        }
      }
    } finally {
      sending = false;
    }
  }

  return {
    push,
    flush,
    pending: () => sending || batch !== undefined || queue.length > 0,
    status: () => ({
      failures,
      paused: outstanding >= maxOutstanding && failures > 0,
      dropped,
      unconfirmed,
    }),
    retire() {
      retired = true;
      queue.length = 0;
      batch = undefined;
    },
  };
}
