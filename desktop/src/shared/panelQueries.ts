/** 同一个查询只运行一个实例；运行中产生的刷新合并为下一轮。 */
export function createLatestQuery<T>(
  query: () => Promise<T>,
): () => Promise<T> {
  let active = false;
  let waiting: {
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
  }[] = [];
  const run = async (): Promise<void> => {
    active = true;
    while (waiting.length > 0) {
      const batch = waiting;
      waiting = [];
      try {
        const result = await query();
        for (const item of batch) item.resolve(result);
      } catch (error) {
        for (const item of batch) item.reject(error);
      }
    }
    active = false;
  };
  return () =>
    new Promise<T>((resolve, reject) => {
      waiting.push({ resolve, reject });
      if (!active) void run();
    });
}
