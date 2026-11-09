import { Context } from "cordis";
import "./services.ts";
import { AcpBasePlugin } from "./acpBase/plugin.ts";
import { AcpPlugin } from "./acp/plugin.ts";
import type { AcpRuntimeHost } from "./acp/service.ts";

/** One root per main-window application, never per React mount. */
export function createDesktopRuntime(host: AcpRuntimeHost) {
  const context = new Context();
  const ready = (async () => {
    try {
      await context.plugin(AcpBasePlugin);
      await context.plugin(AcpPlugin, host);
      return { acpBase: context.acpBase, acp: context.acp };
    } catch (error) {
      await context.fiber.dispose();
      throw error;
    }
  })();
  let stopping: Promise<void> | undefined;
  return {
    ready,
    shutdown(options: { force?: boolean } = {}): Promise<void> {
      return (stopping ??= (async () => {
        const errors: unknown[] = [];
        try {
          const services = await ready;
          try {
            await services.acp.shutdown(options);
          } catch (error) {
            errors.push(error);
          }
          try {
            await services.acpBase.shutdown();
          } catch (error) {
            errors.push(error);
          }
        } catch (error) {
          errors.push(error);
        }
        try {
          await context.fiber.dispose();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length)
          throw new AggregateError(errors, "Desktop runtime shutdown failed");
      })());
    },
  };
}
