/**
 * Pure projection from the AAW machine protocol (`aaw status --json`) to a
 * layered graph.  The kernel stays the single interpreter of workflow state;
 * this module only shapes its output for rendering.
 */

export interface StatusStep {
  id: number
  type: string
  name: string
  execution: string
  finished: boolean
  execution_status: string
  attempt: number
  started_at: string | null
  ended_at: string | null
  next: number[]
  task_dev?: Record<string, unknown>
}

export interface StatusPayload {
  sr: string
  workflow_id?: string
  entry: string
  status: string
  vars?: Record<string, unknown>
  pending_user_confirm?: {
    from_step?: number
    from_name?: string
    planned_next?: Array<{ name?: string }>
  } | null
  steps: StatusStep[]
  definition_drift?: { message?: string }
}

export type StepState = 'done' | 'running' | 'failed' | 'blocked' | 'superseded' | 'pending'

export const TASK_DEV_STEP_TYPES = new Set(['task-dev', 'dev-task-dev'])

export function stepState(step: StatusStep): StepState {
  if (step.finished) return 'done'
  switch (step.execution_status) {
    case 'running':
      return 'running'
    case 'failed':
      return 'failed'
    case 'blocked':
      return 'blocked'
    case 'superseded':
      return 'superseded'
    default:
      return 'pending'
  }
}

export function stateLabel(state: StepState): string {
  switch (state) {
    case 'done':
      return '已完成'
    case 'running':
      return '进行中'
    case 'failed':
      return '失败'
    case 'blocked':
      return '阻塞'
    case 'superseded':
      return '已废弃'
    default:
      return '未开始'
  }
}

export interface GraphNodeData {
  stepId: number
  name: string
  stepType: string
  execution: string
  state: StepState
  attempt: number
  startedAt: string | null
  endedAt: string | null
  isTaskDev: boolean
  taskDevPhase: string | null
  pendingConfirm: boolean
}

export interface GraphNode {
  id: string
  type: 'aaw-step'
  position: { x: number; y: number }
  data: GraphNodeData
  draggable: boolean
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  animated: boolean
}

export interface GraphSummary {
  sr: string
  entry: string
  workflowStatus: string
  total: number
  counts: Record<StepState, number>
  driftMessage: string | null
  pendingConfirmNames: string[]
}

export interface GraphProjection {
  nodes: GraphNode[]
  edges: GraphEdge[]
  summary: GraphSummary
}

const COLUMN_WIDTH = 300
const ROW_HEIGHT = 150
const ORIGIN = 40

/** Longest-path layering from the roots, then column/row placement. */
export function projectStatusToGraph(status: StatusPayload): GraphProjection {
  const steps = status.steps ?? []
  const byId = new Map(steps.map((step) => [step.id, step]))
  const level = new Map<number, number>()
  const incoming = new Map<number, number[]>()
  for (const step of steps) {
    for (const next of step.next ?? []) {
      if (!byId.has(next)) continue
      incoming.set(next, [...(incoming.get(next) ?? []), step.id])
    }
  }

  // Kahn layering; remaining nodes (cycles/unknown) fall back to declaration order.
  const queue: number[] = []
  for (const step of steps) {
    if ((incoming.get(step.id) ?? []).length === 0) {
      level.set(step.id, 0)
      queue.push(step.id)
    }
  }
  while (queue.length > 0) {
    const current = queue.shift()!
    const currentLevel = level.get(current) ?? 0
    for (const next of byId.get(current)?.next ?? []) {
      if (!byId.has(next)) continue
      const candidate = currentLevel + 1
      if ((level.get(next) ?? -1) < candidate) {
        level.set(next, candidate)
        if (!queue.includes(next)) queue.push(next)
      }
    }
  }
  steps.forEach((step, index) => {
    if (!level.has(step.id)) level.set(step.id, index)
  })

  const pendingFrom = status.pending_user_confirm?.from_step
  const rowsByLevel = new Map<number, number>()
  const nodes: GraphNode[] = steps.map((step) => {
    const layer = level.get(step.id) ?? 0
    const row = rowsByLevel.get(layer) ?? 0
    rowsByLevel.set(layer, row + 1)
    const state = stepState(step)
    const taskDev = step.task_dev
    return {
      id: String(step.id),
      type: 'aaw-step',
      position: { x: ORIGIN + layer * COLUMN_WIDTH, y: ORIGIN + row * ROW_HEIGHT },
      draggable: true,
      data: {
        stepId: step.id,
        name: step.name,
        stepType: step.type,
        execution: step.execution,
        state,
        attempt: step.attempt ?? 1,
        startedAt: step.started_at,
        endedAt: step.ended_at,
        isTaskDev: TASK_DEV_STEP_TYPES.has(step.type),
        taskDevPhase: taskDev && typeof taskDev['status'] === 'string' ? (taskDev['status'] as string) : null,
        pendingConfirm: pendingFrom === step.id,
      },
    }
  })

  const edges: GraphEdge[] = []
  for (const step of steps) {
    for (const next of step.next ?? []) {
      if (!byId.has(next)) continue
      edges.push({
        id: `e${step.id}-${next}`,
        source: String(step.id),
        target: String(next),
        animated: stepState(step) === 'running',
      })
    }
  }

  const counts = Object.fromEntries(
    (['done', 'running', 'failed', 'blocked', 'superseded', 'pending'] as StepState[]).map((state) => [state, 0]),
  ) as Record<StepState, number>
  for (const node of nodes) counts[node.data.state] += 1

  const pendingConfirmNames = (status.pending_user_confirm?.planned_next ?? [])
    .map((item) => String(item.name ?? ''))
    .filter(Boolean)

  return {
    nodes,
    edges,
    summary: {
      sr: status.sr,
      entry: status.entry,
      workflowStatus: status.status,
      total: steps.length,
      counts,
      driftMessage: status.definition_drift?.message ?? null,
      pendingConfirmNames,
    },
  }
}
