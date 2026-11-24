export async function clearRecoveryImages(belongs: (key: string) => boolean) {
  for (const { name } of await indexedDB.databases()) {
    if (name !== "aaw-message-images" && name !== "aaw-image-drafts") continue;
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onerror = () =>
        reject(new Error("无法打开旧图片数据库", { cause: request.error }));
      request.onsuccess = () => {
        const db = request.result;
        const storeName = name === "aaw-message-images" ? "sessions" : "drafts";
        if (!db.objectStoreNames.contains(storeName)) {
          db.close();
          reject(new Error("无法识别旧图片数据库"));
          return;
        }
        const tx = db.transaction(storeName, "readwrite");
        const store = tx.objectStore(storeName);
        if (storeName === "drafts") {
          const all = store.get("all");
          all.onsuccess = () => {
            if (all.result)
              store.put(
                Object.fromEntries(
                  Object.entries(all.result as Record<string, unknown>).filter(
                    ([key]) => !belongs(key),
                  ),
                ),
                "all",
              );
          };
        } else {
          const keys = store.openKeyCursor();
          keys.onsuccess = () => {
            const cursor = keys.result;
            if (cursor) {
              if (typeof cursor.key === "string" && belongs(cursor.key))
                store.delete(cursor.key);
              cursor.continue();
            }
          };
        }
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error("图片历史清理中断"));
        };
      };
    });
  }
}
