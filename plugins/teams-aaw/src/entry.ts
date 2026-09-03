import { isAbsolute } from 'node:path'
import { AawBusiness, version } from './business.js'
import { bundleId } from './contributions.js'

/** The host checks the loaded business module's exported version against the manifest. */
export { version }

/**
 * Business entry loaded by the host's BundleHost.  The host passes a versioned
 * native host context; refusing to start without it keeps the service from
 * ever writing its registry to an unknown directory.
 */

interface CordisContext {
  provide(name: string, service: unknown): void
}

export interface HostContext {
  protocol: number
  bundleId: string
  version: string
  artifactDirectory: string
  dataDirectory: string
}

export interface PluginConfig {
  host?: Partial<HostContext>
}

export default async function plugin(ctx: CordisContext, config: PluginConfig) {
  const host = config?.host
  if (
    !host ||
    host.protocol !== 1 ||
    host.bundleId !== bundleId ||
    !host.dataDirectory ||
    !isAbsolute(host.dataDirectory)
  ) {
    throw new Error(`aaw-workflow 需要版本化的 Native 宿主上下文 (protocol 1, bundleId=${bundleId}, 绝对路径 dataDirectory)`)
  }
  const business = new AawBusiness(host.dataDirectory)
  ctx.provide(bundleId, {
    version,
    health: () => true,
    call: (input: unknown) => business.call(input),
  })
}
