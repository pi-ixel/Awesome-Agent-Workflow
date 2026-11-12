export interface PendingUsage<T> {
  id: string;
  enabledAt: number;
  zone: string;
  turn: T;
}

async function transact<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("aaw-usage-outbox", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("turns", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new Error(request.error?.message ?? "无法打开用量待写入队列"));
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction("turns", mode, { durability: "strict" });
      const request = run(tx.objectStore("turns"));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () =>
        reject(new Error(tx.error?.message ?? "用量待写入队列事务失败"));
    });
  } finally {
    db.close();
  }
}

export function loadPendingUsage<T>(): Promise<PendingUsage<T>[]> {
  return transact(
    "readonly",
    (store) => store.getAll() as IDBRequest<PendingUsage<T>[]>,
  );
}

export async function savePendingUsage<T>(
  pending: PendingUsage<T>,
): Promise<void> {
  await transact("readwrite", (store) => store.put(pending));
}

export async function acknowledgeUsage(id: string): Promise<void> {
  await transact("readwrite", (store) => store.delete(id));
}
