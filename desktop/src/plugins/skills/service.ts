import type { ConfigurationScope } from "../../contracts/configuration.ts";
import type { SkillFiles, SkillsService } from "../../contracts/skills.ts";
import { createStore } from "zustand";
import { createLogger } from "../../shared/diagnosticEvents/logger.ts";
import { createSkillsStore } from "./store.ts";

export const skillsSourceField = "skillsSourceDir";
const logger = createLogger("settings");
const rescanDelay = 400;

function readSource(scope: ConfigurationScope): string {
  try {
    const value = scope.read()?.[skillsSourceField];
    return typeof value === "string" && value.trim() ? value : "";
  } catch (error) {
    logger.warn("读取技能来源失败", { error: String(error) });
    return "";
  }
}

export function createSkills(
  host: SkillFiles,
  scope: ConfigurationScope,
  installer: SkillsService["installer"],
  subscribeInstaller: SkillsService["subscribeInstaller"],
) {
  const state = createSkillsStore(host);
  const source = createStore<string>(() => readSource(scope));
  let observers = 0;
  let detach: (() => void) | undefined;
  let disposed = false;
  let lastDirectory = source.getState();
  let lastCapability = installer();

  function watchInstaller(): () => void {
    if (disposed) return () => {};
    if (observers++ === 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const schedule = (force = false) => {
        clearTimeout(timer);
        const capability = installer();
        const directory = source.getState();
        if (
          directory !== lastDirectory ||
          capability !== lastCapability ||
          force
        ) {
          state.invalidateContext();
          lastDirectory = directory;
          lastCapability = capability;
        }
        if (capability && directory.trim()) {
          timer = setTimeout(() => {
            void state.store.getState().rescan(directory, capability);
          }, rescanDelay);
        }
      };
      const stopSource = source.subscribe(() => schedule());
      const stopAgent = subscribeInstaller(() => schedule(true));
      detach = () => {
        clearTimeout(timer);
        stopSource();
        stopAgent();
      };
      schedule();
    }
    let released = false;
    return () => {
      if (disposed || released) return;
      released = true;
      if (--observers === 0) {
        detach?.();
        detach = undefined;
      }
    };
  }

  return {
    state: state.store,
    source: {
      getSnapshot: source.getState,
      subscribe: source.subscribe,
      set(directory) {
        if (disposed) return;
        try {
          scope.update({ [skillsSourceField]: directory });
        } catch (error) {
          logger.warn("写入技能来源失败", { error: String(error) });
        }
        source.setState(directory, true);
      },
    },
    installer: (id) => (disposed ? undefined : installer(id)),
    subscribeInstaller: (listener) =>
      disposed ? () => {} : subscribeInstaller(listener),
    watchInstaller,
    candidates: (names, invocations) =>
      disposed
        ? []
        : names.filter((name) => typeof invocations?.[name] === "string"),
    dispose() {
      disposed = true;
      detach?.();
      detach = undefined;
      source.setState("", true);
      return state.dispose();
    },
  } satisfies SkillsService & { dispose(): Promise<void> };
}
