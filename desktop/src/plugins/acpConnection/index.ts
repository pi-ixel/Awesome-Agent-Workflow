import type { Context } from "cordis";
import type { AcpConnectionInternals } from "./service.ts";
import { DesktopAcpConnection } from "./lifecycle/connectionService.ts";

export const name = "acpConnection";
export const inject = ["host", "diagnostics"];

export function apply(ctx: Context): void {
  const connections = new DesktopAcpConnection(ctx.host, {
    logger: ctx.diagnostics.createLogger("acp"),
    recordRaw: ctx.diagnostics.recordAcpRaw,
  });
  // 建池能力保留在运行时对象上（acpRuntime 单点装配用），但不进插件可见
  // 的 AcpConnectionService 类型——Context 声明的服务面不带 createPool。
  ctx.provide(name, {
    createTransport: connections.createTransport.bind(connections),
    diagnostics: connections.diagnostics.bind(connections),
    probe: connections.probe.bind(connections),
    createPool: connections.createPool.bind(connections),
    createConnection: connections.createConnection.bind(connections),
    releaseConnection: connections.releaseConnection.bind(connections),
    shutdown: connections.shutdown.bind(connections),
  } satisfies AcpConnectionInternals);
  ctx.effect(() => () => connections.shutdown(), "acpConnection:resources");
}
