import { listen } from "@tauri-apps/api/event";
import type { UpdatesHost, UpdateSnapshot } from "../../contracts/updates.ts";
import { isTauriEnv } from "./host.ts";
import { invoke } from "./invoke.ts";

export const updatesHost: UpdatesHost = {
  isNative: () => isTauriEnv(),
  listen: (receive) =>
    listen<UpdateSnapshot>("desktop-update", ({ payload }) => receive(payload)),
  status: () => invoke("update_status"),
  check: () => invoke("update_check"),
  download: () => invoke("update_download"),
  preferences: (preferences) => invoke("update_preferences", { preferences }),
  prepare: (version) => invoke("update_prepare", { version }),
  cancel: () => invoke("update_cancel"),
  install: () => invoke("update_install"),
  openFolder: () => invoke("update_open_folder"),
};
