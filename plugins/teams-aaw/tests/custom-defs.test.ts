import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dump as yamlDump, load as yamlLoad } from 'js-yaml'
import { buildFlowYaml, listCustomWorkflows, renderCustomFiles, saveCustomWorkflow, validateCustomWorkflow } from '../src/custom-defs.js'
import { AawError } from '../src/errors.js'

const workflow = {
  id: 'release-flow',
  title: '发布流程',
  steps: [
    { name: '检查清单', prompt: '逐项检查发布前置条件', confirm: false },
    { name: '打包', prompt: '执行构建与打包', confirm: true },
    { name: '上线', prompt: '执行发布并观察监控', confirm: true },
  ],
}

test('node files are prompt-mode templates the kernel can load', () => {
  const files = renderCustomFiles(workflow)
  assert.deepEqual(Object.keys(files).sort(), ['release-flow-s1.yaml', 'release-flow-s2.yaml', 'release-flow-s3.yaml'])
  const first = yamlLoad(files['release-flow-s1.yaml']!) as { name: string; execution: string; prompt: { steps: Array<Record<string, string>> } }
  assert.equal(first.execution, 'prompt')
  assert.equal(first.prompt.steps[0]!['do'], '逐项检查发布前置条件')
  assert.match(first.name, /发布流程 1：检查清单/)
})

test('flow.yaml chains the steps with confirm gates and SR var', () => {
  const flow = yamlLoad(buildFlowYaml([workflow])) as {
    entrypoints: Record<string, { start: string; vars: string[]; title: string }>
    edges: Record<string, { kind: string; to?: string; user_confirm?: string }>
  }
  assert.equal(flow.entrypoints['release-flow'].start, 'release-flow-s1')
  assert.deepEqual(flow.entrypoints['release-flow'].vars, ['SR'])
  assert.equal(flow.entrypoints['release-flow'].title, '发布流程')
  assert.equal(flow.edges['release-flow-s1']!.kind, 'direct')
  assert.equal(flow.edges['release-flow-s1']!.user_confirm, 'skip')
  assert.equal(flow.edges['release-flow-s2']!.user_confirm, 'must')
  assert.equal(flow.edges['release-flow-s3']!.kind, 'terminal')
})

test('validation rejects bad ids, reserved names and empty steps', () => {
  assert.throws(() => validateCustomWorkflow({ ...workflow, id: 'Bad_Id' }), AawError)
  assert.throws(() => validateCustomWorkflow({ ...workflow, id: 'dev' }), /内置入口/)
  assert.throws(() => validateCustomWorkflow({ ...workflow, steps: [] }), /步骤数量/)
  assert.throws(() => validateCustomWorkflow({ ...workflow, steps: [{ name: '', prompt: 'x', confirm: false }] }), /名称/)
})

test('save merges flow.yaml across workflows and cleans stale node files', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'aaw-canvas-'))
  try {
    const defs = join(repo, '.sdd', '.aaw', 'definitions')
    await mkdir(defs, { recursive: true })
    // simulate an earlier save of the same workflow with 4 steps
    await writeFile(join(defs, 'release-flow-s4.yaml'), 'name: old\n', 'utf8')
    await writeFile(join(defs, 'other-flow-s1.yaml'), 'name: keep\n', 'utf8')

    await saveCustomWorkflow(repo, [], workflow)
    const names = (await readdir(defs)).sort()
    assert.ok(!names.includes('release-flow-s4.yaml'), 'stale step file removed')
    assert.ok(names.includes('other-flow-s1.yaml'), 'unrelated files kept')

    // saving a second workflow keeps the first one in flow.yaml
    const second = { id: 'onboard', title: '入职引导', steps: [{ name: '开户', prompt: '创建账号', confirm: false }] }
    const existing = await listCustomWorkflows(repo)
    await saveCustomWorkflow(repo, existing, second)
    const flow = yamlLoad(await readFile(join(defs, 'flow.yaml'), 'utf8')) as { entrypoints: Record<string, unknown> }
    assert.deepEqual(Object.keys(flow.entrypoints).sort(), ['onboard', 'release-flow'])

    const loaded = await listCustomWorkflows(repo)
    const release = loaded.find((item) => item.id === 'release-flow')!
    assert.equal(release.title, '发布流程')
    assert.equal(release.steps.length, 3)
    // the last step has no successor, so its confirm gate is a no-op by design
    assert.equal(release.steps[2]!.confirm, false)
    assert.equal(release.steps[1]!.confirm, true)
    assert.equal(release.steps[0]!.prompt, '逐项检查发布前置条件')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})
