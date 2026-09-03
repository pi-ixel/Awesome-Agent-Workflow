import { mkdir, readdir, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { dump as yamlDump, load as yamlLoad } from 'js-yaml'
import { AawError } from './errors.js'

/**
 * Codegen/parse for user-authored workflows (the canvas), persisted in the
 * repo's project-level definition layer (`.sdd/.aaw/definitions/`) that the
 * kernel already merges at load time.  The kernel stays the only validator
 * and interpreter — this module only *shapes* definitions; every semantic
 * error (bad references, conflicts) surfaces when the kernel loads or runs.
 *
 * v1 model: each custom workflow is a linear chain of prompt steps with an
 * optional user-confirm gate after each step.  Branching needs done-data +
 * `when` conditions and lands with the canvas v2 form builder.
 */

export const DEFINITIONS_SUBDIR = join('.sdd', '.aaw', 'definitions')
export const RESERVED_ENTRY_IDS = new Set(['sr', 'ar', 'dev', 'flow'])
const ENTRY_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/
const MAX_STEPS = 30

export interface CanvasStep {
  name: string
  prompt: string
  confirm: boolean
}

export interface CustomWorkflow {
  id: string
  title: string
  steps: CanvasStep[]
}

interface ParsedFlow {
  entrypoints?: Record<string, { start?: string; vars?: string[]; title?: string }>
  edges?: Record<string, { kind?: string; to?: string; user_confirm?: string }>
}

export function validateCustomWorkflow(input: CustomWorkflow): void {
  if (!ENTRY_ID_PATTERN.test(input.id)) {
    throw new AawError('INVALID_ARGUMENT', `工作流标识非法（小写字母开头，小写字母/数字/连字符，2-32 位）: ${input.id}`)
  }
  if (RESERVED_ENTRY_IDS.has(input.id)) {
    throw new AawError('INVALID_ARGUMENT', `工作流标识不能使用内置入口名: ${input.id}`)
  }
  const title = String(input.title ?? '').trim()
  if (title.length === 0 || title.length > 40) {
    throw new AawError('INVALID_ARGUMENT', '工作流名称必须是 1-40 个字符')
  }
  if (!Array.isArray(input.steps) || input.steps.length === 0 || input.steps.length > MAX_STEPS) {
    throw new AawError('INVALID_ARGUMENT', `步骤数量必须是 1-${MAX_STEPS}`)
  }
  input.steps.forEach((step, index) => {
    const name = String(step.name ?? '').trim()
    const prompt = String(step.prompt ?? '')
    if (name.length === 0 || name.length > 40) {
      throw new AawError('INVALID_ARGUMENT', `步骤 ${index + 1} 名称必须是 1-40 个字符`)
    }
    if (prompt.trim().length === 0 || prompt.length > 20_000) {
      throw new AawError('INVALID_ARGUMENT', `步骤 ${index + 1} 提示词不能为空且不超过 2 万字符`)
    }
  })
}

const dump = (value: unknown): string => yamlDump(value, { lineWidth: -1, noRefs: true })

/** Generate the per-step node files for one workflow. Nodes are `<id>-s<i>`. */
export function renderCustomFiles(workflow: CustomWorkflow): Record<string, string> {
  const files: Record<string, string> = {}
  workflow.steps.forEach((step, index) => {
    const nodeId = `${workflow.id}-s${index + 1}`
    files[`${nodeId}.yaml`] = dump({
      name: `${workflow.title} ${index + 1}：${step.name.trim()}`,
      execution: 'prompt',
      prompt: { steps: [{ do: step.prompt }] },
    })
  })
  return files
}

/** Render the merged project flow.yaml for a set of custom workflows. */
export function buildFlowYaml(workflows: CustomWorkflow[]): string {
  const entrypoints: Record<string, unknown> = {}
  const edges: Record<string, unknown> = {}
  for (const workflow of workflows) {
    entrypoints[workflow.id] = { start: `${workflow.id}-s1`, vars: ['SR'], title: workflow.title }
    workflow.steps.forEach((step, index) => {
      const nodeId = `${workflow.id}-s${index + 1}`
      const isLast = index === workflow.steps.length - 1
      edges[nodeId] = isLast
        ? { kind: 'terminal', user_confirm: 'skip' }
        : { kind: 'direct', to: `${workflow.id}-s${index + 2}`, user_confirm: step.confirm ? 'must' : 'skip' }
    })
  }
  return dump({ entrypoints, edges })
}

/**
 * Persist one custom workflow: merge flow.yaml, write this workflow's node
 * files, and remove stale node files from previous saves of the same id.
 * Returns the list of files written.
 */
export async function saveCustomWorkflow(
  repoPath: string,
  existing: CustomWorkflow[],
  workflow: CustomWorkflow,
): Promise<string[]> {
  validateCustomWorkflow(workflow)
  const dir = join(repoPath, DEFINITIONS_SUBDIR)
  await mkdir(dir, { recursive: true })
  const merged = [...existing.filter((item) => item.id !== workflow.id), workflow]
  const written: string[] = []

  const previous = (await readdir(dir).catch(() => [] as string[]))
    .filter((name) => name.startsWith(`${workflow.id}-s`) && name.endsWith('.yaml'))
  for (const name of previous) {
    await unlink(join(dir, name)).catch(() => {})
  }

  const keep = new Set(workflow.steps.map((_, index) => `${workflow.id}-s${index + 1}.yaml`))
  for (const [name, content] of Object.entries(renderCustomFiles(workflow))) {
    if (name === 'flow.yaml') continue
    keep.add(name)
    await writeFile(join(dir, name), content, 'utf8')
    written.push(name)
  }
  await writeFile(join(dir, 'flow.yaml'), buildFlowYaml(merged), 'utf8')
  written.push('flow.yaml')
  return written
}

/** Parse the project layer back into editable custom workflows (canvas load). */
export async function listCustomWorkflows(repoPath: string): Promise<CustomWorkflow[]> {
  const dir = join(repoPath, DEFINITIONS_SUBDIR)
  let flow: ParsedFlow
  try {
    flow = yamlLoad(await readFileText(join(dir, 'flow.yaml'))) as ParsedFlow
  } catch {
    return []
  }
  const entrypoints = flow?.entrypoints ?? {}
  const edges = flow?.edges ?? {}
  const result: CustomWorkflow[] = []
  for (const [id, entrypoint] of Object.entries(entrypoints)) {
    if (!entrypoint?.start) continue
    const steps: CanvasStep[] = []
    let cursor: string | undefined = entrypoint.start
    const visited = new Set<string>()
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor)
      let node: { name?: string; prompt?: { steps?: Array<Record<string, string>> } } | undefined
      try {
        node = yamlLoad(await readFileText(join(dir, `${cursor}.yaml`))) as typeof node
      } catch {
        break
      }
      const promptStep = node?.prompt?.steps?.[0]
      steps.push({
        name: String(node?.name ?? cursor),
        prompt: String(promptStep?.['do'] ?? ''),
        confirm: edges[cursor]?.user_confirm === 'must',
      })
      cursor = edges[cursor]?.to
    }
    result.push({ id, title: String(entrypoint.title ?? id), steps })
  }
  return result
}

async function readFileText(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  return readFile(path, 'utf8')
}
