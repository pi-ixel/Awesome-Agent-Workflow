import type { HostManagedStorage, HostStorage } from "../../host/types.ts";

let storage: HostStorage = {
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
  removeItem: (key) => localStorage.removeItem(key),
};

export function bindProjectStorage(hostStorage: HostStorage): void {
  storage = hostStorage;
}

export const projectStorage: HostStorage = {
  getItem: (key) => storage.getItem(key),
  setItem: (key, value) => storage.setItem(key, value),
  removeItem: (key) => storage.removeItem?.(key),
};

export function managedProjectStorage(): HostManagedStorage | undefined {
  return storage.managed;
}
