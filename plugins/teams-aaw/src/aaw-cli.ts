import { execFile } from 'node:child_process'
import { AawError } from './errors.js'

/**
 * Spawning wrapper around the AAW CLI.
 *
 * Embedded invocations must be deterministic and side-effect free, so every
 * spawn disables telemetry upload and the release-update check
 * (`AAW_UPDATE_CHECK` is honoured by cli.update.auto_update_on_entry).
 */

export interface SpawnOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  timeout: number
  maxBuffer: number
}

export interface SpawnResult {
  code: number
  stdout: string
  stderr: string
}

export type Runner = (command: string[], options: SpawnOptions) => Promise<SpawnResult>

export const SPAWN_TIMEOUT_MS = 30_000
export const SPAWN_MAX_BUFFER = 16 * 1024 * 1024

export const PLUGIN_SPAWN_ENV: Record<string, string> = {
  AAW_TELEMETRY_ENABLED: 'false',
  AAW_UPDATE_CHECK: 'off',
}

export const defaultRunner: Runner = (command, options) =>
  new Promise((resolve) => {
    execFile(
      command[0]!,
      command.slice(1),
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = error && typeof (error as NodeJS.ErrnoException).code === 'number' ? ((error as unknown as { code: number }).code) : error ? 1 : 0
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      },
    )
  })

export function buildSpawnEnv(): NodeJS.ProcessEnv {
  return { ...process.env, ...PLUGIN_SPAWN_ENV }
}

export function statusArgs(sr?: string): string[] {
  return sr ? ['status', '--sr', sr, '--json'] : ['status', '--json']
}

export interface StartRequest {
  entry: string
  sr?: string
  vars?: Record<string, string>
  requirementPath?: string
}

export function startArgs(request: StartRequest): string[] {
  const args = ['start', '--entry', request.entry]
  if (request.sr) args.push('--sr', request.sr)
  for (const [key, value] of Object.entries(request.vars ?? {})) args.push('--var', `${key}=${value}`)
  if (request.requirementPath) args.push('--requirement-file', request.requirementPath)
  args.push('--json')
  return args
}

/**
 * Run the AAW CLI in a workspace and return the parsed JSON payload.
 * With `--json`, our CLI prints structured errors on stdout, which are mapped
 * to `AawError` here so the gateway reports `{ error, code }`.
 */
export async function spawnAaw(
  workspace: { path: string; aawCommand: string[] },
  args: string[],
  runner: Runner = defaultRunner,
): Promise<Record<string, unknown>> {
  if (workspace.aawCommand.length === 0) {
    throw new AawError('INVALID_ARGUMENT', 'AAW CLI 命令为空，请先在工作区设置中配置')
  }
  const result = await runner([...workspace.aawCommand, ...args], {
    cwd: workspace.path,
    env: buildSpawnEnv(),
    timeout: SPAWN_TIMEOUT_MS,
    maxBuffer: SPAWN_MAX_BUFFER,
  })
  const parsed = parseJsonObject(result.stdout)
  if (result.code === 0 && parsed) return parsed
  if (parsed) {
    const err = parsed['error']
    const code = typeof err === 'object' && err !== null ? String((err as Record<string, unknown>)['code'] ?? 'OPERATION_FAILED') : 'OPERATION_FAILED'
    const message = typeof err === 'object' && err !== null ? String((err as Record<string, unknown>)['message'] ?? result.stderr) : String(err ?? result.stderr)
    throw new AawError('OPERATION_FAILED', `${message} (code=${code})`)
  }
  const tail = (result.stderr || result.stdout).trim().split('\n').slice(-3).join('\n')
  throw new AawError(result.code === 0 ? 'RUNTIME_UNAVAILABLE' : 'OPERATION_FAILED', `AAW CLI 调用失败 (exit ${result.code}): ${tail || '无输出'}`)
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const value = JSON.parse(trimmed) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}
