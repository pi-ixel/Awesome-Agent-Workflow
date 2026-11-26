import { expect, it } from "vitest";
import { isNativeConfigurationKey } from "../../src/plugins/host/storage/storage.ts";
import { remoteProjectsKey } from "../../src/plugins/remoteProject/store/remoteProjectStore.ts";

it("远程项目 SSH 绑定和工作区都登记为原生配置", () => {
  expect(isNativeConfigurationKey(remoteProjectsKey)).toBe(true);
  expect(isNativeConfigurationKey("aaw-desktop/workspace/v1")).toBe(true);
});
