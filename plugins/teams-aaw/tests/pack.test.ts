import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pack } from '../pack.js'

test('pack produces a manifest that satisfies the host bundle constraints', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aaw-pack-'))
  try {
    const artifact = await pack('0.0.0-test', join(directory, 'artifact.json'))

    assert.equal(artifact.manifest.id, 'aaw-workflow')
    assert.equal(artifact.manifest.version, '0.0.0-test')
    assert.equal(artifact.manifest.hostApi, '3')
    // the host refuses bundles missing any of the four slot kinds
    for (const slot of ['navigation', 'page', 'settings', 'command']) {
      assert.ok(artifact.manifest.contributions.some((item) => item.slot === slot), `missing slot ${slot}`)
    }
    const nav = artifact.manifest.contributions.find((item) => item.slot === 'navigation')!
    assert.equal(nav.href, '/plugins/aaw-workflow')
    assert.deepEqual(Object.keys(artifact.files).sort(), ['business.js', 'contract.js', 'ui.js'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('business bundle exposes the service with a matching version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aaw-pack-'))
  try {
    const artifact = await pack('0.0.0-test', join(directory, 'artifact.json'))
    const business = artifact.files['business.js']!
    assert.ok(business.includes('aaw-workflow'), 'provides the aaw-workflow service')
    assert.ok(business.includes('srs.status'), 'dispatches workflow operations')
    assert.ok(business.includes('0.0.0-test'), 'version define injected')
    // never leak the spawn-env toggles: they must stay opt-out via the wrapper
    assert.ok(business.includes('AAW_UPDATE_CHECK'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('ui bundle is self-contained browser ESM with inlined styles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aaw-pack-'))
  try {
    const artifact = await pack('0.0.0-test', join(directory, 'artifact.json'))
    const ui = artifact.files['ui.js']!
    assert.ok(ui.includes('aaw-workflow'), 'bundle id baked in')
    assert.ok(ui.includes('aaw-node'), 'custom node template present')
    assert.ok(ui.length > 50_000, 'vue + vue-flow are bundled, not imported')
    assert.ok(!/from\s*"[^./]/.test(ui), 'no bare module imports remain')
    assert.ok(ui.includes(':host'), 'styles rewritten for Shadow DOM')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
