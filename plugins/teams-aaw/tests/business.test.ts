import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AawBusiness } from '../src/business.js'
import { PLUGIN_SPAWN_ENV, type Runner, type SpawnResult } from '../src/aaw-cli.js'

interface RecordedCall {
  command: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

function harness(script: (call: RecordedCall, index: number) => SpawnResult | Promise<SpawnResult>) {
  const calls: RecordedCall[] = []
  const runner: Runner = async (command, options) => {
    const call = { command, cwd: options.cwd, env: options.env }
    calls.push(call)
    return script(call, calls.length - 1)
  }
  return { calls, runner }
}

const okStatusList = { code: 0, stdout: JSON.stringify({ ok: true, srs: [] }), stderr: '' }

async function withTempBusiness(script: Parameters<typeof harness>[0]) {
  const directory = await mkdtemp(join(tmpdir(), 'aaw-biz-'))
  const { calls, runner } = harness(script)
  return { business: new AawBusiness(directory, runner), calls, directory, cleanup: () => rm(directory, { recursive: true, force: true }) }
}

const envelope = (operation: string, payload: Record<string, unknown>, requestId = 'r1') => ({
  schemaVersion: 1,
  requestId,
  operation,
  payload,
})

test('rejects malformed envelopes with precise errors', async () => {
  const { business, cleanup } = await withTempBusiness(() => okStatusList)
  try {
    await assert.rejects(business.call({ nope: 1 }), /schemaVersion/)
    await assert.rejects(business.call(envelope('nope.op', {})), /不支持的操作/)
    await assert.rejects(business.call(envelope('workspace.list', {}, 'x'.repeat(200))), /requestId/)
  } finally {
    await cleanup()
  }
})

test('legacy demo command body {tool:UI} answers plugin status', async () => {
  const { business, cleanup } = await withTempBusiness(() => okStatusList)
  try {
    const result = (await business.call({ tool: 'UI' })) as { ok: boolean; version: string }
    assert.equal(result.ok, true)
    assert.ok(result.version.length > 0)
  } finally {
    await cleanup()
  }
})

test('workspace.add validates the path, smoke-runs the CLI and persists', async () => {
  const { business, calls, directory, cleanup } = await withTempBusiness(() => okStatusList)
  try {
    await assert.rejects(business.call(envelope('workspace.add', { path: 'relative/path' })), /绝对路径/)
    await assert.rejects(business.call(envelope('workspace.add', { path: join(directory, 'missing') })), /不存在/)

    const added = (await business.call(envelope('workspace.add', { path: directory, aawCommand: ['py', '-3', 'aaw.py'] }))) as {
      workspace: { id: string; aawCommand: string[] }
    }
    assert.equal(added.workspace.aawCommand.join(' '), 'py -3 aaw.py')
    const call = calls[0]!
    assert.deepEqual(call.command.slice(-2), ['status', '--json'])
    assert.equal(call.cwd, directory)
    assert.equal(call.env['AAW_UPDATE_CHECK'], 'off')
    assert.equal(call.env['AAW_TELEMETRY_ENABLED'], 'false')

    const stored = JSON.parse(await readFile(join(directory, 'workspaces.json'), 'utf8'))
    assert.equal(stored.length, 1)
    // duplicate path (different slashes/case) is rejected
    await assert.rejects(business.call(envelope('workspace.add', { path: directory.toUpperCase() })), /已登记/)
  } finally {
    await cleanup()
  }
})

test('workspace.add fails and does not persist when the CLI smoke check fails', async () => {
  const { business, directory, cleanup } = await withTempBusiness(() => ({ code: 1, stdout: '', stderr: 'python 坏了' }))
  try {
    await assert.rejects(business.call(envelope('workspace.add', { path: directory })), /冒烟检查失败.*python 坏了/)
    await assert.rejects(readFile(join(directory, 'workspaces.json')), /ENOENT/)
  } finally {
    await cleanup()
  }
})

test('srs.status spawns the CLI with --sr and returns the raw payload', async () => {
  const statusPayload = { ok: true, sr: 'SR-1', steps: [] }
  const { business, calls, directory, cleanup } = await withTempBusiness((_, index) =>
    index === 0 ? okStatusList : { code: 0, stdout: JSON.stringify(statusPayload), stderr: '' },
  )
  try {
    const added = (await business.call(envelope('workspace.add', { path: directory }))) as { workspace: { id: string } }
    const result = (await business.call(envelope('srs.status', { workspaceId: added.workspace.id, sr: 'SR-1' }))) as {
      status: Record<string, unknown>
    }
    assert.deepEqual(result.status, statusPayload)
    const call = calls[1]!
    assert.deepEqual(call.command.slice(-4), ['status', '--sr', 'SR-1', '--json'])
    await assert.rejects(business.call(envelope('srs.status', { workspaceId: added.workspace.id, sr: 'SR 1!' })), /SR 编号非法/)
  } finally {
    await cleanup()
  }
})

test('srs.start writes a temp requirement file and cleans it up', async () => {
  const startPayload = { ok: true, sr: 'SR-9' }
  const { business, calls, directory, cleanup } = await withTempBusiness((_, index) =>
    index === 0 ? okStatusList : { code: 0, stdout: JSON.stringify(startPayload), stderr: '' },
  )
  try {
    const added = (await business.call(envelope('workspace.add', { path: directory }))) as { workspace: { id: string } }
    const result = (await business.call(
      envelope('srs.start', { workspaceId: added.workspace.id, entry: 'sr', sr: 'SR-9', requirement: '原始需求：用户管理' }),
    )) as { started: Record<string, unknown> }
    assert.deepEqual(result.started, startPayload)
    const call = calls[1]!
    assert.deepEqual(call.command.slice(1, 3), ['start', '--entry'])
    const fileArg = call.command.find((arg) => arg.endsWith('.md'))
    assert.ok(fileArg, 'requirement temp file passed')
    await assert.rejects(readFile(fileArg!), /ENOENT/, 'temp requirement file deleted after the call')
    const leftovers = (await readdir(directory)).filter((name) => name.startsWith('requirement-'))
    assert.equal(leftovers.length, 0)
  } finally {
    await cleanup()
  }
})

test('srs.start rejects invalid entries before spawning', async () => {
  const { business, calls, directory, cleanup } = await withTempBusiness(() => okStatusList)
  try {
    const added = (await business.call(envelope('workspace.add', { path: directory }))) as { workspace: { id: string } }
    await assert.rejects(business.call(envelope('srs.start', { workspaceId: added.workspace.id, entry: '../evil' })), /入口名非法/)
    assert.equal(calls.length, 1, 'no spawn happened for the rejected request')
  } finally {
    await cleanup()
  }
})

test('CLI JSON errors map onto AawError codes/messages', async () => {
  const { business, directory, cleanup } = await withTempBusiness((_, index) =>
    index === 0
      ? okStatusList
      : { code: 1, stdout: JSON.stringify({ schema_version: 1, ok: false, error: { code: 'DUPLICATE_SR', message: 'SR SR-1 已存在' } }), stderr: '' },
  )
  try {
    const added = (await business.call(envelope('workspace.add', { path: directory }))) as { workspace: { id: string } }
    await assert.rejects(
      business.call(envelope('srs.start', { workspaceId: added.workspace.id, entry: 'sr', sr: 'SR-1', requirement: '需求' })),
      /SR SR-1 已存在/,
    )
  } finally {
    await cleanup()
  }
})

test('srs.plan spawns the definition projection and returns it raw', async () => {
  const planPayload = { ok: true, entry: 'dev', definition_version: 2, nodes: [], edges: [] }
  const { business, calls, directory, cleanup } = await withTempBusiness((_, index) =>
    index === 0 ? okStatusList : { code: 0, stdout: JSON.stringify(planPayload), stderr: '' },
  )
  try {
    const added = (await business.call(envelope('workspace.add', { path: directory }))) as { workspace: { id: string } }
    const result = (await business.call(envelope('srs.plan', { workspaceId: added.workspace.id, sr: 'SR-1' }))) as {
      status: Record<string, unknown>
    }
    assert.deepEqual(result.status, planPayload)
    const call = calls[1]!
    assert.deepEqual(call.command.slice(-4), ['plan', '--sr', 'SR-1', '--json'])
    await assert.rejects(business.call(envelope('srs.plan', { workspaceId: added.workspace.id, sr: 'SR 1!' })), /SR 编号非法/)
  } finally {
    await cleanup()
  }
})

test('plugin status reports the registry size', async () => {
  const { business, directory, cleanup } = await withTempBusiness(() => okStatusList)
  try {
    await business.call(envelope('workspace.add', { path: directory }))
    const result = (await business.call(envelope('aaw-workflow.status', {}))) as { ok: boolean; workspaces: number }
    assert.equal(result.ok, true)
    assert.equal(result.workspaces, 1)
  } finally {
    await cleanup()
  }
})

test('spawn env pins telemetry off and update check off', () => {
  assert.equal(PLUGIN_SPAWN_ENV['AAW_TELEMETRY_ENABLED'], 'false')
  assert.equal(PLUGIN_SPAWN_ENV['AAW_UPDATE_CHECK'], 'off')
})
