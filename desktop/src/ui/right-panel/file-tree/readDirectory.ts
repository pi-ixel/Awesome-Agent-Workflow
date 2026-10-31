/** 目录读取的模块级并发闸（desktop 既有语义：同时最多 4 次 panel_directory）。 */
import { panelService, type DirectoryResult } from "../../../core/panelService.ts";
import { FILE_TREE_READ_CONCURRENCY } from "./constants.ts";

let running = 0;
const waiting: (() => void)[] = [];

export async function readDirectory(path: string): Promise<DirectoryResult> {
  if (running >= FILE_TREE_READ_CONCURRENCY) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  running += 1;
  try {
    return await panelService.directory(path);
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}
