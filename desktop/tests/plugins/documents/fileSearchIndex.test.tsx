import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useFileSearchIndex } from "../../../src/plugins/documents/ui/file-tree/useFileSearchIndex.ts";
import type { DocumentsService } from "../../../src/plugins/documents/service.ts";

const readDirectory = vi.fn<DocumentsService["directory"]>();
const documents = { directory: readDirectory };
const entry = (path: string, directory = false) => ({
  path,
  name: path.split("/").pop()!,
  directory,
  symlink: false,
});
beforeEach(() => vi.resetAllMocks());
it("扫描超过并发批次的所有同层目录与未展开的子目录", async () => {
  readDirectory.mockImplementation((path) =>
    Promise.resolve({
      entries:
        path === "D:/p"
          ? Array.from({ length: 9 }, (_, i) => entry(`D:/p/d${i}`, true))
          : [entry(`${path}/green-new.ts`)],
      truncated: false,
    }),
  );
  const { result } = renderHook(() =>
    useFileSearchIndex({
      documents,
      root: "D:/p",
      enabled: true,
      refreshVersion: 0,
    }),
  );
  await waitFor(() => expect(result.current.loaded).toBe(true));
  expect(result.current.entries.filter((e) => !e.directory)).toHaveLength(9);
  expect(
    result.current.entries.some((e) => e.relativePath === "d8/green-new.ts"),
  ).toBe(true);
  expect(result.current.notice).toBeNull();
});
it("读取失败和目录截断时保留已读结果并提示不完整", async () => {
  readDirectory.mockImplementation((path) => {
    if (path.endsWith("bad")) return Promise.reject(new Error("denied"));
    return Promise.resolve({
      entries: [entry("D:/p/ok.ts"), entry("D:/p/bad", true)],
      truncated: true,
    });
  });
  const { result } = renderHook(() =>
    useFileSearchIndex({
      documents,
      root: "D:/p",
      enabled: true,
      refreshVersion: 0,
    }),
  );
  await waitFor(() => expect(result.current.loaded).toBe(true));
  expect(result.current.entries.some((e) => e.name === "ok.ts")).toBe(true);
  expect(result.current.notice).toContain("读取失败");
  expect(result.current.notice).toContain("10000");
});
it("仍排除依赖目录", async () => {
  readDirectory.mockResolvedValue({
    entries: [entry("D:/p/node_modules", true)],
    truncated: false,
  });
  const { result } = renderHook(() =>
    useFileSearchIndex({
      documents,
      root: "D:/p",
      enabled: true,
      refreshVersion: 0,
    }),
  );
  await waitFor(() => expect(result.current.loaded).toBe(true));
  expect(readDirectory).toHaveBeenCalledTimes(1);
});

it("达到条目上限和深度上限时提示截断", async () => {
  readDirectory.mockResolvedValue({
    entries: Array.from({ length: 20001 }, (_, i) => entry(`D:/p/f${i}.ts`)),
    truncated: false,
  });
  const first = renderHook(() =>
    useFileSearchIndex({
      documents,
      root: "D:/p",
      enabled: true,
      refreshVersion: 0,
    }),
  );
  await waitFor(() => expect(first.result.current.loaded).toBe(true));
  expect(first.result.current.entries).toHaveLength(20000);
  expect(first.result.current.notice).toContain("20000");
  first.unmount();
  readDirectory.mockImplementation((path) =>
    Promise.resolve({
      entries: [entry(`${path}/nested`, true)],
      truncated: false,
    }),
  );
  const second = renderHook(() =>
    useFileSearchIndex({
      documents,
      root: "D:/deep",
      enabled: true,
      refreshVersion: 0,
    }),
  );
  await waitFor(() => expect(second.result.current.loaded).toBe(true));
  expect(second.result.current.notice).toContain("24");
});
