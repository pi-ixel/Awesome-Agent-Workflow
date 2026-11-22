import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDeliveryLane,
  deliveryTimeoutMs,
  type DeliveryId,
} from "../../../src/plugins/diagnostics/capture/delivery.ts";

afterEach(() => vi.useRealTimers());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((unblock) => {
    resolve = unblock;
  });
  return { promise, resolve };
}

describe("诊断采集批次", () => {
  it("重试保持批次标识，挂起请求达到上限后等待真实回执", async () => {
    vi.useFakeTimers();
    const original = deferred();
    const retry = deferred();
    const send = vi
      .fn<(records: string[], id: DeliveryId) => Promise<void>>()
      .mockReturnValueOnce(original.promise)
      .mockReturnValueOnce(retry.promise)
      .mockResolvedValue(undefined);
    const onAccepted = vi.fn();
    const lane = createDeliveryLane({
      epoch: "main",
      batchSize: 1,
      send,
      onAccepted,
    });
    lane.push("第一条");
    const first = lane.flush();
    await vi.advanceTimersByTimeAsync(deliveryTimeoutMs + 250);
    await first;
    lane.push("第二条");
    const second = lane.flush();
    await vi.advanceTimersByTimeAsync(deliveryTimeoutMs + 1000);
    await second;
    await lane.flush();
    expect(send.mock.calls).toEqual([
      [["第一条"], { epoch: "main", sequence: 1 }],
      [["第一条"], { epoch: "main", sequence: 1 }],
    ]);
    expect(lane.status()).toMatchObject({ paused: true, failures: 2 });

    original.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await lane.flush();
    retry.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(send.mock.calls.at(-1)).toEqual([
      ["第二条"],
      { epoch: "main", sequence: 2 },
    ]);
    expect(onAccepted.mock.calls).toEqual([[["第一条"]], [["第二条"]]]);
    expect(lane.status()).toEqual({
      paused: false,
      failures: 0,
      dropped: 0,
      unconfirmed: 0,
    });
  });

  it("明确拒绝耗尽重试时记录丢弃，后续记录仍能发送", async () => {
    vi.useFakeTimers();
    const send = vi
      .fn<(records: string[], id: DeliveryId) => Promise<void>>()
      .mockRejectedValueOnce("队列已满")
      .mockRejectedValueOnce("队列已满")
      .mockRejectedValueOnce("队列已满")
      .mockResolvedValue(undefined);
    const lane = createDeliveryLane({ epoch: "main", batchSize: 1, send });
    lane.push("丢弃");
    lane.push("保留");
    for (const wait of [250, 500, 1000]) {
      await lane.flush();
      await vi.advanceTimersByTimeAsync(wait);
    }
    expect(lane.status()).toMatchObject({ dropped: 1, unconfirmed: 0 });
    await lane.flush();
    expect(send.mock.calls.at(-1)).toEqual([
      ["保留"],
      { epoch: "main", sequence: 2 },
    ]);
    expect(lane.status()).toMatchObject({ dropped: 1, failures: 0 });
  });

  it("原文字节上限包含等待真实回执的记录", async () => {
    vi.useFakeTimers();
    const original = deferred();
    const send = vi
      .fn<(records: string[], id: DeliveryId) => Promise<void>>()
      .mockReturnValueOnce(original.promise)
      .mockResolvedValue(undefined);
    const lane = createDeliveryLane({
      epoch: "main",
      batchSize: 1,
      byteLimit: 8,
      recordByteLimit: 5,
      send,
    });
    lane.push("过大", 6);
    lane.push("在途", 5);
    const first = lane.flush();
    await vi.advanceTimersByTimeAsync(deliveryTimeoutMs + 250);
    await first;
    await lane.flush();
    lane.push("溢出", 4);
    expect(lane.status().dropped).toBe(2);
    original.resolve();
    await vi.advanceTimersByTimeAsync(0);
    lane.push("恢复", 4);
    await lane.flush();
    expect(send.mock.calls.at(-1)?.[0]).toEqual(["恢复"]);
  });
});
