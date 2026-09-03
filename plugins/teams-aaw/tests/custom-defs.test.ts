import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load as yamlLoad } from 'js-yaml'
import { AawError } from '../src/errors.js'
import { checkGraphShape, compileGraph, listGraphWorkflows, saveGraphWorkflow, validateGraphWorkflow } from '../src/custom-defs.js'

/**
 * The reference scenario (user requirement): 扫描代码仓 → 分支（多模块：
 * skill-A 理清关系 → 逐模块 skill-B → 全部完成后 skill-C 综合总览；
 * 单模块：skill-B → skill-C），含输入/输出校验。
 */
const REPO_SCAN = {
  id: 'repo-scan',
  title: '仓库扫描与模块设计',
  nodes: [
    { nid: 'n1', kind: 'step', name: '扫描仓库结构', prompt: '扫描仓库判断是否多模块，提交 is_multi 与模块清单。', inputs: [], outputs: [{ path: '.sdd/{SR}/仓库结构扫描.md', required: true }] },
    { nid: 'n2', kind: 'branch', name: '多模块？', field: 'is_multi', question: '是否多模块仓库', options: [{ value: 'yes', label: '是' }, { value: 'no', label: '否' }] },
    { nid: 'n3', kind: 'step', name: '理清模块关系', skill: 'skill-a', inputs: [{ path: '.sdd/{SR}/仓库结构扫描.md', required: true }], outputs: [{ path: '.sdd/{SR}/模块关系.md', required: true }] },
    { nid: 'n4', kind: 'loop', name: '逐模块设计', sourceField: 'modules', itemVar: '模块名' },
    { nid: 'n5', kind: 'step', name: '综合设计总览', skill: 'skill-c', inputs: [{ path: '.sdd/{SR}/modules', required: true }], outputs: [{ path: '.sdd/{SR}/设计总览.md', required: true }] },
    { nid: 'n6', kind: 'step', name: '单体设计', skill: 'skill-b', inputs: [{ path: '.sdd/{SR}/仓库结构扫描.md', required: true }], outputs: [{ path: '.sdd/{SR}/模块设计说明书.md', required: true }] },
  ],
  wires: [
    { from: 'n1', to: 'n2' },
    { from: 'n2', to: 'n3', option: 0 },
    { from: 'n2', to: 'n6', option: 1 },
    { from: 'n3', to: 'n4' },
    { from: 'n4', to: 'n5', outlet: 'each' },
    { from: 'n4', to: 'n5', outlet: 'join' },
  ],
} as unknown as Parameters<typeof compileGraph>[0]

test('validation rejects malformed graphs', () => {
  assert.throws(() => validateGraphWorkflow({ ...REPO_SCAN, id: 'Bad' }), AawError)
  assert.throws(() => validateGraphWorkflow({ ...REPO_SCAN, id: 'dev' }), /内置入口/)
  assert.throws(() => validateGraphWorkflow({ ...REPO_SCAN, nodes: REPO_SCAN.nodes.map(n => ({ ...n, name: '' })) }), /名称/)
})

test('shape check reports unwired branch options and missing joins', () => {
  const broken = {
    ...REPO_SCAN,
    wires: REPO_SCAN.wires.filter(w => !(w.from === 'n2' && w.option === 1)),
  } as Parameters<typeof checkGraphShape>[0]
  const { errors } = checkGraphShape(broken)
  assert.ok(errors.some(e => e.includes('选项「否」')), JSON.stringify(errors))
})

test('compiles the repo-scan scenario into kernel-loadable definitions', () => {
  const files = compileGraph(REPO_SCAN)
  const flow = yamlLoad(files['flow.yaml']!) as {
    entrypoints: Record<string, { start: string; vars: string[]; title: string }>
    edges: Record<string, Record<string, unknown>>
  }
  assert.equal(flow.entrypoints['repo-scan'].start, 'repo-scan-n1')
  assert.deepEqual(flow.entrypoints['repo-scan'].vars, ['SR'])

  // n1(扫描) 直连 n2(分支)；分支语义编译在 n2 自己的边上
  const n1Edge = flow.edges['repo-scan-n1'] as { kind: string; to: string }
  assert.equal(n1Edge.kind, 'direct')
  assert.equal(n1Edge.to, 'repo-scan-n2')
  const branchEdge = flow.edges['repo-scan-n2'] as { kind: string; choices: Array<Record<string, unknown>>; data_schema: { fields: Record<string, unknown> } }
  assert.equal(branchEdge.kind, 'choice')
  assert.equal(branchEdge.choices.length, 2)
  assert.ok(branchEdge.data_schema.fields['is_multi'])
  const multi = branchEdge.choices[0] as { when: string; to: string }
  assert.equal(multi.when, "data.is_multi == 'yes'")
  assert.equal(multi.to, 'repo-scan-n3')

  // 多模块链路：n3(skill-A) 直连循环节点 n4；循环编译为 foreach 串行 + join_to 汇合
  const relationsEdge = flow.edges['repo-scan-n3'] as { kind: string; to: string }
  assert.equal(relationsEdge.kind, 'direct')
  assert.equal(relationsEdge.to, 'repo-scan-n4')
  const loopEdge = flow.edges['repo-scan-n4'] as { kind: string; choices: Array<{ foreach: string; to: string; scheduling: string; join_to: string; vars: Record<string, string> }> }
  assert.equal(loopEdge.kind, 'choice')
  assert.equal(loopEdge.choices[0]!.foreach, 'data.modules')
  assert.equal(loopEdge.choices[0]!.scheduling, 'serial')
  assert.equal(loopEdge.choices[0]!.join_to, 'repo-scan-n5')
  assert.equal(loopEdge.choices[0]!.vars['模块名'], '{item}')

  const relationsNode = yamlLoad(files['repo-scan-n3.yaml']!) as { execution: string; skill: string[]; input: Array<{ path: string; required: boolean }>; output: Array<{ path: string; required: boolean }> }
  assert.equal(relationsNode.execution, 'skill')
  assert.deepEqual(relationsNode.skill, ['skill-a'])
  assert.equal(relationsNode.input[0]!.path, '.sdd/{SR}/仓库结构扫描.md')
  assert.equal(relationsNode.output[0]!.required, true)

  // 单模块分支直达单体设计
  assert.equal(branchEdge.choices[1]!.to, 'repo-scan-n6')
})

test('save persists files and merges flow.yaml sections per workflow', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'aaw-canvas2-'))
  try {
    await saveGraphWorkflow(repo, REPO_SCAN)
    const names = (await readdir(join(repo, '.sdd', '.aaw', 'definitions'))).sort()
    assert.ok(names.includes('flow.yaml'))
    assert.ok(names.includes('repo-scan-n1.yaml'))
    assert.ok(names.includes('repo-scan-n6.yaml'))

    // 第二个工作流保存后，第一个的 entrypoint 仍在
    const second = {
      id: 'onboard',
      title: '入职引导',
      nodes: [
        { nid: 'a', kind: 'step', name: '开户', prompt: '创建账号' },
        { nid: 'b', kind: 'step', name: '发欢迎包', prompt: '寄送欢迎包' },
      ],
      wires: [{ from: 'a', to: 'b' }],
    } as unknown as Parameters<typeof saveGraphWorkflow>[1]
    await saveGraphWorkflow(repo, second)
    const flow = yamlLoad(await readFile(join(repo, '.sdd', '.aaw', 'definitions', 'flow.yaml'), 'utf8')) as { entrypoints: Record<string, unknown> }
    assert.deepEqual(Object.keys(flow.entrypoints).sort(), ['onboard', 'repo-scan'])

    // 画布可加载回两个工作流（含分支/循环语义）
    const loaded = await listGraphWorkflows(repo)
    const scan = loaded.find(item => item.id === 'repo-scan')!
    const branch = scan.nodes.find(n => n.nid === scan.wires.find(w => w.option === 0)!.from)
    assert.ok(branch, 'branch node reconstructed')
    const loop = scan.nodes.find(n => n.kind === 'loop')
    assert.ok(loop, 'loop node reconstructed')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})
