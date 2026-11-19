/**
 * `shortcut.mjs` 的类型声明。
 *
 * 这个模块是普通 ESM（启动器不经过 TS 构建），但测试要 import 它，
 * 没有声明文件就会被 `noImplicitAny` 判成 any 报错。`.d.mts` 不会被
 * `scripts/build-tools-runtime.mjs` 复制进 dist（它只认 mjs/cjs/js/html/css）。
 */
export type ShortcutRegistration = {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
};

export type ShortcutStore = {
  read(): { shortcut?: string } & Record<string, unknown>;
  update(patch: { shortcut: string }): void;
};

export type ShortcutState = { shortcut: string; shortcutReady: boolean };

export type ShortcutStartResult = {
  ok: boolean;
  fallbackFrom?: string;
  occupied?: string;
};

export type ShortcutController = {
  readonly state: ShortcutState;
  start(): ShortcutStartResult;
  pause(): void;
  resume(): void;
  change(value: string): void;
};

export function normalizeShortcut(value: string): string;
export function createShortcutController(
  api: ShortcutRegistration,
  store: ShortcutStore,
  callback: () => void,
): ShortcutController;
