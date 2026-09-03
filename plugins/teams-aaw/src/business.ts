import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { AawError, isAawError } from './errors.js'
import { spawnAaw, planArgs, startArgs, statusArgs, type Runner, defaultRunner } from './aaw-cli.js'
import type {
  CallEnvelope,
  PluginStatusResult,
  SrsListResult,
  SrsPlanResult,
  SrsStartResult,
  SrsStatusResult,
  Workspace,
  WorkspaceListResult,
} from './contract.js'

declare const BUNDLE_VERSION: string
/** BUNDLE_VERSION is a pack-time define; raw-TS consumers (tests) fall back to a dev marker. */
export const version: string = typeof BUNDLE_VERSION === 'string' ? BUNDLE_VERSION : '0.0.0-source'

const MAX_BODY_CHARS = 256 * 1024
const MAX_WORKSPACES = 20
const SR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const ENTRY_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

const OPERATIONS = new Set([
  'workspace.list',
  'workspace.add',
  'workspace.remove',
  'srs.list',
  'srs.status',
  'srs.plan',
  'srs.start',
  'aaw-workflow.status',
])

/**
 * Business module of the aaw-workflow feature bundle.
 *
 * The AAW CLI is the single writer of workflow state; this service only
 * triggers it (read-only commands plus `start`) inside user-registered
 * workspaces and never touches `.sdd/` itself.  The `runner` parameter exists
 * for tests; production uses the execFile-based default.
 */
export class AawBusiness {
  private readonly registryFile: string

  constructor(
    dataDirectory: string,
    private readonly runner: Runner = defaultRunner,
  ) {
    if (!isAbsolute(dataDirectory)) throw new AawError('INVALID_ARGUMENT', 'dataDirectory 必须是绝对路径')
    this.registryFile = join(dataDirectory, 'workspaces.json')
  }

  async call(input: unknown): Promise<unknown> {
    // The demo shell's command slot still posts the sample body `{tool:'UI'}`;
    // treat it as a plugin status probe instead of failing the button.
    if (isPlainObject(input) && (input as Record<string, unknown>)['tool'] === 'UI') {
      return this.pluginStatus()
    }
    const request = parseEnvelope(input)
    try {
      return await this.dispatch(request.operation, request.payload)
    } catch (error) {
      if (isAawError(error)) throw error
      throw new AawError('OPERATION_FAILED', `插件内部错误: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // -- dispatch ---------------------------------------------------------------

  private async dispatch(operation: string, payload: Record<string, unknown>): Promise<unknown> {
    switch (operation) {
      case 'workspace.list':
        return { workspaces: await this.listWorkspaces() } satisfies WorkspaceListResult
      case 'workspace.add':
        return this.addWorkspace(payload)
      case 'workspace.remove':
        return this.removeWorkspace(payload)
      case 'srs.list':
        return this.listSrs(payload)
      case 'srs.status':
        return this.srsStatus(payload)
      case 'srs.plan':
        return this.srsPlan(payload)
      case 'srs.start':
        return this.srsStart(payload)
      case 'aaw-workflow.status':
        return this.pluginStatus()
      default:
        throw new AawError('UNSUPPORTED_CAPABILITY', `不支持的操作: ${operation}`)
    }
  }

  private async pluginStatus(): Promise<PluginStatusResult> {
    return { ok: true, version, workspaces: (await this.listWorkspaces()).length }
  }

  // -- workspace registry -------------------------------------------------------

  private async listWorkspaces(): Promise<Workspace[]> {
    try {
      const raw = await readFile(this.registryFile, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      return Array.isArray(parsed) ? (parsed as Workspace[]) : []
    } catch {
      return []
    }
  }

  private async persist(workspaces: Workspace[]): Promise<void> {
    await mkdir(dirname(this.registryFile), { recursive: true })
    await writeFile(this.registryFile, JSON.stringify(workspaces, null, 2), 'utf8')
  }

  private async addWorkspace(payload: Record<string, unknown>): Promise<{ workspace: Workspace }> {
    const rawPath = String(payload['path'] ?? '').trim()
    if (!isAbsolute(rawPath)) throw new AawError('INVALID_ARGUMENT', '工作区路径必须是绝对路径')
    let info
    try {
      info = await stat(rawPath)
    } catch {
      throw new AawError('INVALID_ARGUMENT', `工作区目录不存在: ${rawPath}`)
    }
    if (!info.isDirectory()) throw new AawError('INVALID_ARGUMENT', `工作区路径不是目录: ${rawPath}`)

    const command = parseAawCommand(payload['aawCommand'])
    const workspaces = await this.listWorkspaces()
    if (workspaces.some((item) => normalizePath(item.path) === normalizePath(rawPath))) {
      throw new AawError('INVALID_ARGUMENT', '该工作区已登记')
    }
    if (workspaces.length >= MAX_WORKSPACES) {
      throw new AawError('INVALID_ARGUMENT', `最多登记 ${MAX_WORKSPACES} 个工作区`)
    }

    const workspace: Workspace = { id: randomUUID(), path: rawPath, aawCommand: command, createdAt: new Date().toISOString() }
    // Smoke check: a cheap read-only CLI call proves the command works in this cwd.
    try {
      const probe = await spawnAaw(workspace, statusArgs(), this.runner)
      if (!isPlainObject(probe)) throw new Error('CLI 未返回 JSON object')
    } catch (error) {
      const detail = isAawError(error) ? error.message : String(error)
      throw new AawError('INVALID_ARGUMENT', `AAW CLI 冒烟检查失败: ${detail}`)
    }

    await this.persist([...workspaces, workspace])
    return { workspace }
  }

  private async removeWorkspace(payload: Record<string, unknown>): Promise<{ ok: true }> {
    const id = String(payload['id'] ?? '')
    const workspaces = await this.listWorkspaces()
    const next = workspaces.filter((item) => item.id !== id)
    if (next.length === workspaces.length) throw new AawError('NOT_FOUND', `工作区不存在: ${id}`)
    await this.persist(next)
    return { ok: true }
  }

  // -- workflow instances ---------------------------------------------------------

  private async resolveWorkspace(payload: Record<string, unknown>): Promise<Workspace> {
    const id = String(payload['workspaceId'] ?? '')
    const workspace = (await this.listWorkspaces()).find((item) => item.id === id)
    if (!workspace) throw new AawError('NOT_FOUND', `工作区不存在: ${id}`)
    return workspace
  }

  private async listSrs(payload: Record<string, unknown>): Promise<SrsListResult> {
    const workspace = await this.resolveWorkspace(payload)
    const raw = await spawnAaw(workspace, statusArgs(), this.runner)
    const srs = Array.isArray(raw['srs']) ? raw['srs'].map(String) : []
    return { srs }
  }

  private async srsStatus(payload: Record<string, unknown>): Promise<SrsStatusResult> {
    const workspace = await this.resolveWorkspace(payload)
    const sr = requirePattern(payload['sr'], SR_PATTERN, 'SR 编号非法')
    const raw = await spawnAaw(workspace, statusArgs(sr), this.runner)
    return { status: raw }
  }

  private async srsPlan(payload: Record<string, unknown>): Promise<SrsPlanResult> {
    const workspace = await this.resolveWorkspace(payload)
    const sr = requirePattern(payload['sr'], SR_PATTERN, 'SR 编号非法')
    // `plan` is a pure definition projection: no state file access, no
    // auto-update hook, no telemetry on the CLI side.
    const raw = await spawnAaw(workspace, planArgs(sr), this.runner)
    return { status: raw as SrsPlanResult['status'] }
  }

  private async srsStart(payload: Record<string, unknown>): Promise<SrsStartResult> {
    const workspace = await this.resolveWorkspace(payload)
    const entry = requirePattern(payload['entry'], ENTRY_PATTERN, '入口名非法')
    const sr =
      payload['sr'] === undefined || payload['sr'] === null || payload['sr'] === ''
        ? undefined
        : requirePattern(payload['sr'], SR_PATTERN, 'SR 编号非法')
    const vars = parseVars(payload['vars'])
    const requirement = payload['requirement'] === undefined ? undefined : String(payload['requirement'])

    let requirementPath: string | undefined
    try {
      if (requirement !== undefined) {
        if (requirement.trim().length === 0) throw new AawError('INVALID_ARGUMENT', '需求内容为空')
        if (requirement.length > 200_000) throw new AawError('INVALID_ARGUMENT', '需求内容过长（上限 20 万字符）')
        requirementPath = join(dirname(this.registryFile), `requirement-${randomUUID()}.md`)
        await writeFile(requirementPath, requirement, 'utf8')
      }
      const raw = await spawnAaw(workspace, startArgs({ entry, sr, vars, requirementPath }), this.runner)
      return { started: raw }
    } finally {
      if (requirementPath) await unlink(requirementPath).catch(() => {})
    }
  }
}

// -- helpers ---------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseEnvelope(input: unknown): CallEnvelope {
  if (!isPlainObject(input)) throw new AawError('INVALID_ARGUMENT', '请求体必须是 JSON object')
  if (JSON.stringify(input).length > MAX_BODY_CHARS) throw new AawError('INVALID_ARGUMENT', '请求体超过 256KB 上限')
  if (input['schemaVersion'] !== 1) throw new AawError('INVALID_ARGUMENT', 'schemaVersion 必须为 1')
  const requestId = input['requestId']
  if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 128) {
    throw new AawError('INVALID_ARGUMENT', 'requestId 非法')
  }
  const operation = input['operation']
  if (typeof operation !== 'string' || !OPERATIONS.has(operation)) {
    throw new AawError('UNSUPPORTED_CAPABILITY', `不支持的操作: ${String(operation)}`)
  }
  const payload = input['payload']
  if (!isPlainObject(payload)) throw new AawError('INVALID_ARGUMENT', 'payload 必须是 JSON object')
  return { schemaVersion: 1, requestId, operation, payload }
}

function parseAawCommand(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return ['aaw']
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    throw new AawError('INVALID_ARGUMENT', 'aawCommand 必须是 1-8 个元素的字符串数组')
  }
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > 2048) {
      throw new AawError('INVALID_ARGUMENT', 'aawCommand 元素必须是非空字符串')
    }
  }
  return value as string[]
}

function parseVars(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined
  if (!isPlainObject(value)) throw new AawError('INVALID_ARGUMENT', 'vars 必须是 JSON object')
  const entries = Object.entries(value)
  if (entries.length > 32) throw new AawError('INVALID_ARGUMENT', 'vars 最多 32 个变量')
  const result: Record<string, string> = {}
  for (const [key, raw] of entries) {
    if (key.length === 0 || key.length > 64 || /[\s=]/.test(key)) throw new AawError('INVALID_ARGUMENT', `变量名非法: ${key}`)
    if (typeof raw !== 'string') throw new AawError('INVALID_ARGUMENT', `变量值必须是字符串: ${key}`)
    if (raw.length > 4096) throw new AawError('INVALID_ARGUMENT', `变量值过长: ${key}`)
    result[key] = raw
  }
  return result
}

function requirePattern(value: unknown, pattern: RegExp, message: string): string {
  const text = String(value ?? '')
  if (!pattern.test(text)) throw new AawError('INVALID_ARGUMENT', `${message}: ${String(value)}`)
  return text
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}
