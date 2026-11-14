import type { AcpProtocolResources } from "./types.ts";

import type {} from "cordis";

declare module "cordis" {
  interface Context {
    acpRuntime: AcpRuntimeService;
  }
}

export interface AcpRuntimeService {
  readonly protocol: AcpProtocolResources;
  shutdown(options?: { force?: boolean }): Promise<void>;
}

export {
  AcpClosedError,
  AcpResponseError,
  AcpTimeoutError,
  AcpWriteError,
} from "../acpConnection/service.ts";
export { configModels, configModes } from "./protocol/configOptions.ts";
/**
 * 共享协议会话类的公开出口（ADR 024 §7 注入面修正：工作流节点会话直接
 * 装配 `AcpSession`，不注入 acpRuntime 服务）。跨插件边界只放行本模块，
 * 类本体仍归 protocol/session.ts 所有。
 */
export { AcpSession } from "./protocol/session.ts";
export {
  customAnswerDraftKey,
  customAnswerFieldDraftKey,
  fieldOptions,
  formDefaults,
  validateForm,
} from "./protocol/elicitation.ts";
