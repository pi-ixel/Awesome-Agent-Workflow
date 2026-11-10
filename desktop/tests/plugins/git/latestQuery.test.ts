import { describe, expect, it } from "vitest";
import { createLatestQuery } from "../../../src/plugins/git/diff/latestQuery.ts";

describe("右栏路径与恢复", () => {
  it("突发刷新只保留一轮待执行读取，且较早结果不会冒充较晚结果", async () => {
    const finish: ((value: number) => void)[] = [];
    const read = createLatestQuery(
      () => new Promise<number>((resolve) => finish.push(resolve)),
    );
    const first = read();
    const second = read();
    const third = read();
    expect(finish).toHaveLength(1);
    finish[0]?.(1);
    expect(await first).toBe(1);
    expect(finish).toHaveLength(2);
    finish[1]?.(2);
    expect(await Promise.all([second, third])).toEqual([2, 2]);
  });
});
