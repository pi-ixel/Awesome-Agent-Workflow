import type { Context } from "cordis";
import type { AcpConnectionService } from "./service.ts";
import { DesktopAcpConnection } from "./lifecycle/connectionService.ts";

export const name = "acpConnection";
export const inject = ["host", "diagnostics"];

export function apply(ctx: Context): void {
  const connections = new DesktopAcpConnection(ctx.host, {
    logger: ctx.diagnostics.createLogger("acp"),
    recordRaw: ctx.diagnostics.recordAcpRaw,
  });
  ctx.provide(name, {
    createTransport: connections.createTransport.bind(connections),
    createPool: connections.createPool.bind(connections),
    createConnection: connections.createConnection.bind(connections),
    releaseConnection: connections.releaseConnection.bind(connections),
    shutdown: connections.shutdown.bind(connections),
  } satisfies AcpConnectionService);
  ctx.effect(() => () => connections.shutdown(), "acpConnection:resources");
}
