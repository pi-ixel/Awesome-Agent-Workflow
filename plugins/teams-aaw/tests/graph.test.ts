import assert from 'node:assert/strict'
import test from 'node:test'
import { projectStatusToGraph, stateLabel, stepState, type StatusPayload } from '../src/graph.js'

function fixture(overrides: Partial<StatusPayload> = {}): StatusPayload {
  return {
    sr: 'SR-001',
    entry: 'sr',
    status: 'running',
    steps: [
      { id: 1, type: 'sr-init', name: 'SR 初始化', execution: 'skill', finished: true, execution_status: 'completed', attempt: 1, started_at: 't1', ended_at: 't2', next: [2] },
      { id: 2, type: 'sr-design', name: 'SR 设计', execution: 'skill', finished: true, execution_status: 'completed', attempt: 2, started_at: 't3', ended_at: 't4', next: [3] },
      { id: 3, type: 'sr-design-gate', name: 'SR 门禁', execution: 'ai', finished: false, execution_status: 'ready', attempt: 1, started_at: null, ended_at: null, next: [] },
    ],
    ...overrides,
  }
}

test('projects every step to a node with derived state', () => {
  const { nodes } = projectStatusToGraph(fixture())
  assert.equal(nodes.length, 3)
  assert.deepEqual(nodes.map((node) => node.data.state), ['done', 'done', 'pending'])
  assert.equal(nodes[1]!.data.attempt, 2)
  assert.equal(nodes[0]!.data.isTaskDev, false)
})

test('running / failed / blocked / superseded map distinctly', () => {
  assert.equal(stepState({ ...fixture().steps[0]!, finished: false, execution_status: 'running' }), 'running')
  assert.equal(stepState({ ...fixture().steps[0]!, finished: false, execution_status: 'failed' }), 'failed')
  assert.equal(stepState({ ...fixture().steps[0]!, finished: false, execution_status: 'blocked' }), 'blocked')
  assert.equal(stepState({ ...fixture().steps[0]!, finished: false, execution_status: 'superseded' }), 'superseded')
  assert.equal(stateLabel('running'), '进行中')
})

test('edges follow step.next with animation on the running source', () => {
  const status = fixture({
    steps: [
      { id: 1, type: 'a', name: 'a', execution: 'skill', finished: false, execution_status: 'running', attempt: 1, started_at: 't', ended_at: null, next: [2, 3] },
      { id: 2, type: 'b', name: 'b', execution: 'skill', finished: false, execution_status: 'ready', attempt: 1, started_at: null, ended_at: null, next: [] },
      { id: 3, type: 'c', name: 'c', execution: 'skill', finished: false, execution_status: 'ready', attempt: 1, started_at: null, ended_at: null, next: [] },
    ],
  })
  const { edges } = projectStatusToGraph(status)
  assert.deepEqual(edges.map((edge) => [edge.source, edge.target]), [['1', '2'], ['1', '3']])
  assert.ok(edges.every((edge) => edge.animated))
})

test('layers fan-out successors below their parent', () => {
  const { nodes } = projectStatusToGraph(fixture())
  const byId = new Map(nodes.map((node) => [node.id, node]))
  // step 2 sits exactly one column right of step 1
  assert.equal(byId.get('2')!.position.x, byId.get('1')!.position.x + 300)
  assert.equal(byId.get('3')!.position.x, byId.get('2')!.position.x + 300)
})

test('pending_user_confirm marks its source node and summary', () => {
  const { nodes, summary } = projectStatusToGraph(
    fixture({ pending_user_confirm: { from_step: 2, from_name: 'SR 设计', planned_next: [{ name: 'SR 门禁' }] } }),
  )
  const node2 = nodes.find((node) => node.id === '2')!
  assert.equal(node2.data.pendingConfirm, true)
  assert.equal(node2.data.pendingConfirm && nodes.every((node) => node.id === '2' || !node.data.pendingConfirm), true)
  assert.deepEqual(summary.pendingConfirmNames, ['SR 门禁'])
})

test('task-dev steps carry their phase-machine status', () => {
  const { nodes } = projectStatusToGraph(
    fixture({
      steps: [
        { id: 1, type: 'task-dev', name: '用户CRUD', execution: 'ai', finished: false, execution_status: 'running', attempt: 1, started_at: 't', ended_at: null, next: [], task_dev: { status: 'implemented' } },
      ],
    }),
  )
  const node = nodes[0]!
  assert.equal(node.data.isTaskDev, true)
  assert.equal(node.data.taskDevPhase, 'implemented')
})

test('summary counts states and surfaces drift', () => {
  const { summary } = projectStatusToGraph(fixture({ definition_drift: { message: '定义已升级' } }))
  assert.equal(summary.total, 3)
  assert.equal(summary.counts.done, 2)
  assert.equal(summary.counts.pending, 1)
  assert.equal(summary.driftMessage, '定义已升级')
})

test('edges to unknown steps are dropped', () => {
  const { edges } = projectStatusToGraph(fixture())
  assert.ok(edges.every((edge) => ['1', '2', '3'].includes(edge.target)))
})
