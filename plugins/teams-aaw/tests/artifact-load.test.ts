import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pack } from '../pack.js'

/**
 * Loads the *built* business.js the same way the host's BundleHost does
 * (dynamic import of the artifact directory + scope.plugin(config.host)),
 * then talks to the provided service.
 */

async function materialize(version: string): Promise<string> {
  const artifact = await pack(version, join(tmpdir(), `aaw-load-${version}`, 'artifact.json'))
  const directory = join(tmpdir(), `aaw-load-${version}`)
  for (const [name, contents] of Object.entries(artifact.files)) {
    await writeFile(join(directory, name), contents, 'utf8')
  }
  return directory
}

test('built business.js loads under a host context and serves calls', async () => {
  const directory = await materialize('0.0.0-load')
  try {
    const business = await import(pathToFileURL(join(directory, 'business.js')).href)
    assert.equal(business.version, '0.0.0-load')

    const provided = new Map<string, unknown>()
    await business.default(
      { provide: (name: string, service: unknown) => provided.set(name, service) },
      { host: { protocol: 1, bundleId: 'aaw-workflow', version: '0.0.0-load', artifactDirectory: directory, dataDirectory: directory } },
    )
    const service = provided.get('aaw-workflow') as { version: string; health: () => boolean; call: (input: unknown) => Promise<unknown> }
    assert.ok(service, 'aaw-workflow service provided')
    assert.equal(service.version, '0.0.0-load')
    assert.equal(service.health(), true)

    const status = (await service.call({ tool: 'UI' })) as { ok: boolean }
    assert.equal(status.ok, true)
    const failure = await service.call({ schemaVersion: 1, requestId: 'r', operation: 'nope', payload: {} }).then(
      () => null,
      (error: Error) => error,
    )
    assert.match(String(failure), /不支持的操作/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('entry refuses to start without the versioned native host context', async () => {
  const directory = await materialize('0.0.0-load')
  try {
    const business = await import(pathToFileURL(join(directory, 'business.js')).href)
    await assert.rejects(
      business.default({ provide: () => {} }, {}),
      /版本化的 Native 宿主上下文/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('default runner spawns a real process end-to-end with plugin env', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'aaw-spawn-data-'))
  const repo = await mkdtemp(join(tmpdir(), 'aaw-spawn-repo-'))
  try {
    const { AawBusiness } = await import('../src/business.js')
    const script = "console.log(JSON.stringify({ ok: true, srs: ['SR-X'], updateCheck: process.env.AAW_UPDATE_CHECK ?? null, telemetry: process.env.AAW_TELEMETRY_ENABLED ?? null }))"
    const business = new AawBusiness(dataDirectory)
    const added = (await business.call({
      schemaVersion: 1,
      requestId: 'r1',
      operation: 'workspace.add',
      payload: { path: repo, aawCommand: [process.execPath, '-e', script] },
    })) as { workspace: { id: string } }
    const result = (await business.call({
      schemaVersion: 1,
      requestId: 'r2',
      operation: 'srs.list',
      payload: { workspaceId: added.workspace.id },
    })) as { srs: string[] }
    assert.deepEqual(result.srs, ['SR-X'])
  } finally {
    await rm(dataDirectory, { recursive: true, force: true })
    await rm(repo, { recursive: true, force: true })
  }
})
