import { mkdir, readdir, readFile, writeFile, unlink } from 'node:fs/promises'
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
 * v2 model (following the n8n / Dify builder conventions): a free graph of
 * three node kinds wired by the user —
 *   step   prompt or skill execution, with input/output artifact checks
 *   branch asks a question at done; each option is its own outgoing wire and
 *          compiles to a `when: data.<field> == '<value>'` choice edge
 *   loop   "run the next node once per item": two outgoing wires — 每项
 *          (foreach fan-out, serial) and 完成后 (fan-in via kernel join_to)
 */

export const DEFINITIONS_SUBDIR = join('.sdd', '.aaw', 'definitions')
export const RESERVED_ENTRY_IDS = new Set(['sr', 'ar', 'dev', 'flow'])
const ENTRY_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/
const SKILL_PATTERN = /^[a-z][a-z0-9-]{1,63}$/
const MAX_NODES = 30

export type NodeKind = 'step' | 'branch' | 'loop'

export interface IoArtifact {
  path: string
  required: boolean
}

export interface CanvasNode {
  nid: string
  kind: NodeKind
  name: string
  /** step: prompt 模式的执行指令 */
  prompt?: string
  /** step: skill 模式引用的技能名 */
  skill?: string
  /** step: 输入/输出产物校验 */
  inputs?: IoArtifact[]
  outputs?: IoArtifact[]
  /** step: 完成后需用户确认才放行 */
  confirm?: boolean
  /** branch: 提交数据字段名 */
  field?: string
  /** branch: 问题（写入 data_schema 描述） */
  question?: string
  /** branch: 选项，每个选项一条出线 */
  options?: Array<{ value: string; label: string }>
  /** loop: 扇出数据来源字段（data.<field> 必须是数组） */
  sourceField?: string
  /** loop: 每项注入的变量名 */
  itemVar?: string
}

/** n1 -> n2 这类连线；branch 的出线带 option 下标 */
export interface CanvasWire {
  from: string
  to: string
  option?: number
  /** loop 节点：'each' 每项 | 'join' 完成后 */
  outlet?: 'each' | 'join'
}

export interface GraphWorkflow {
  id: string
  title: string
  nodes: CanvasNode[]
  wires: CanvasWire[]
}

// -- validation ---------------------------------------------------------------

export function validateGraphWorkflow(input: GraphWorkflow): void {
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
  if (!Array.isArray(input.nodes) || input.nodes.length === 0 || input.nodes.length > MAX_NODES) {
    throw new AawError('INVALID_ARGUMENT', `节点数量必须是 1-${MAX_NODES}`)
  }
  const ids = new Set<string>()
  for (const node of input.nodes) {
    if (!/^[a-z0-9]{1,20}$/.test(node.nid)) throw new AawError('INVALID_ARGUMENT', `节点标识非法: ${node.nid}`)
    if (ids.has(node.nid)) throw new AawError('INVALID_ARGUMENT', `节点标识重复: ${node.nid}`)
    ids.add(node.nid)
    const name = String(node.name ?? '').trim()
    if (name.length === 0 || name.length > 40) throw new AawError('INVALID_ARGUMENT', `节点 ${node.nid} 名称必须是 1-40 个字符`)
    if (node.kind === 'step') {
      if (node.skill) {
        if (!SKILL_PATTERN.test(node.skill)) throw new AawError('INVALID_ARGUMENT', `节点 ${node.nid} 技能名非法: ${node.skill}`)
      } else if (String(node.prompt ?? '').trim().length === 0) {
        throw new AawError('INVALID_ARGUMENT', `节点 ${node.nid} 的执行提示词不能为空（或改用技能引用）`)
      }
      if ((node.prompt ?? '').length > 20_000) throw new AawError('INVALID_ARGUMENT', `节点 ${node.nid} 提示词超过 2 万字符`)
    } else if (node.kind === 'branch') {
      const field = String(node.field ?? '').trim()
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(field)) throw new AawError('INVALID_ARGUMENT', `分支节点 ${node.nid} 的字段名非法`)
      if (String(node.question ?? '').trim().length === 0) throw new AawError('INVALID_ARGUMENT', `分支节点 ${node.nid} 缺少问题描述`)
      const options = node.options ?? []
      if (options.length < 2) throw new AawError('INVALID_ARGUMENT', `分支节点 ${node.nid} 至少需要两个选项`)
      const values = new Set<string>()
      options.forEach((option, index) => {
        const value = String(option.value ?? '').trim()
        if (!/^[\w\u4e00-\u9fff-]{1,32}$/.test(value)) throw new AawError('INVALID_ARGUMENT', `分支节点 ${node.nid} 选项 ${index + 1} 取值非法: ${value}`)
        if (values.has(value)) throw new AawError('INVALID_ARGUMENT', `分支节点 ${node.nid} 选项取值重复: ${value}`)
        values.add(value)
      })
    } else if (node.kind === 'loop') {
      const field = String(node.sourceField ?? '').trim()
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(field)) throw new AawError('INVALID_ARGUMENT', `循环节点 ${node.nid} 的来源字段非法`)
      const itemVar = String(node.itemVar ?? '模块名').trim()
      if (!/^[\w\u4e00-\u9fff]{1,16}$/.test(itemVar)) throw new AawError('INVALID_ARGUMENT', `循环节点 ${node.nid} 的逐项变量名非法: ${itemVar}`)
    } else {
      throw new AawError('INVALID_ARGUMENT', `未知节点类型: ${node.kind}`)
    }
  }
  for (const wire of input.wires) {
    if (!ids.has(wire.from) || !ids.has(wire.to)) throw new AawError('INVALID_ARGUMENT', `连线指向不存在的节点: ${wire.from} -> ${wire.to}`)
    if (wire.from === wire.to) throw new AawError('INVALID_ARGUMENT', `不允许自环连线: ${wire.from}`)
  }
}

// -- graph well-formedness (canvas-side structure checks; the kernel re-validates semantics) --

interface GraphIssues {
  start: CanvasNode
  errors: string[]
}

export function checkGraphShape(workflow: GraphWorkflow): GraphIssues {
  const errors: string[] = []
  const byNid = new Map(workflow.nodes.map((node) => [node.nid, node]))
  const incoming = new Map<string, number>()
  for (const wire of workflow.wires) incoming.set(wire.to, (incoming.get(wire.to) ?? 0) + 1)

  const starts = workflow.nodes.filter((node) => !incoming.get(node.nid))
  if (starts.length !== 1) errors.push(`起点必须唯一（当前 ${starts.length} 个无入线节点）；每个节点都应被连上，只有一个开始`)
  const start = starts[0] ?? workflow.nodes[0]!

  for (const node of workflow.nodes) {
    const wires = workflow.wires.filter((wire) => wire.from === node.nid)
    if (node.kind === 'step') {
      if (wires.length > 1) errors.push(`步骤 ${node.name} 只能有一条出线（分支请用「分支」节点）`)
    } else if (node.kind === 'branch') {
      const options = node.options ?? []
      options.forEach((option, index) => {
        const count = wires.filter((wire) => wire.option === index).length
        if (count !== 1) errors.push(`分支 ${node.name} 的选项「${option.label || option.value}」必须连出一条线（当前 ${count} 条）`)
      })
      const stray = wires.filter((wire) => wire.option === undefined)
      if (stray.length) errors.push(`分支 ${node.name} 的出线必须从选项出口连出`)
    } else if (node.kind === 'loop') {
      const each = wires.filter((wire) => wire.outlet === 'each')
      const join = wires.filter((wire) => wire.outlet === 'join')
      if (each.length !== 1) errors.push(`循环 ${node.name} 的「每项」出口必须连出一条线（当前 ${each.length} 条）`)
      if (join.length !== 1) errors.push(`循环 ${node.name} 的「完成后」出口必须连出一条线（当前 ${join.length} 条）`)
      for (const wire of each) {
        const target = byNid.get(wire.to)
        if (target && (workflow.wires.filter((item) => item.from === target.nid).length > 0)) {
          errors.push(`循环 ${node.name} 的「每项」目标（${target.name}）必须是末步：逐项分身之后不能再连线（汇合走「完成后」出口）`)
        }
      }
    }
  }

  // reachability from start
  const adjacency = new Map<string, string[]>(workflow.nodes.map((node) => [node.nid, []]))
  for (const wire of workflow.wires) adjacency.get(wire.from)!.push(wire.to)
  const seen = new Set<string>([start.nid])
  const queue = [start.nid]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const next of adjacency.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next)
        queue.push(next)
      }
    }
  }
  for (const node of workflow.nodes) {
    if (!seen.has(node.nid)) errors.push(`节点 ${node.name} 未连入从起点出发的链路`)
  }
  return { start, errors }
}

// -- codegen --------------------------------------------------------------------

interface KernelEdge {
  kind: string
  to?: string
  user_confirm?: string
  data_schema?: { description: string; fields: Record<string, unknown> }
  choices?: Array<{ when?: string; to: string; foreach?: string; scheduling?: string; join_to?: string; user_confirm?: string; vars?: Record<string, string> }>
  reject?: Array<{ when?: string; message: string }>
  foreach?: string
  scheduling?: string
  join_to?: string
  vars?: Record<string, string>
}

/** Compile the canvas graph into the kernel definition file set. */
export function compileGraph(workflow: GraphWorkflow): Record<string, string> {
  validateGraphWorkflow(workflow)
  const { start, errors } = checkGraphShape(workflow)
  if (errors.length > 0) throw new AawError('INVALID_ARGUMENT', `画布结构有问题：${errors.join('；')}`)

  const nodeId = (nid: string) => `${workflow.id}-${nid}`
  const files: Record<string, string> = {}
  const entrypoints: Record<string, unknown> = { [workflow.id]: { start: nodeId(start.nid), vars: ['SR'], title: workflow.title } }
  const edges: Record<string, KernelEdge> = {}

  for (const node of workflow.nodes) {
    const wires = workflow.wires.filter((wire) => wire.from === node.nid)
    const kernelId = nodeId(node.nid)
    let edge: KernelEdge

    if (node.kind === 'step') {
      const body: Record<string, unknown> = {
        name: `${workflow.title}：${node.name}`,
        execution: node.skill ? 'skill' : 'prompt',
      }
      if (node.skill) body['skill'] = [node.skill]
      else body['prompt'] = { steps: [{ do: node.prompt }] }
      if (node.inputs?.length) body['input'] = node.inputs.map((item) => ({ path: item.path, required: item.required }))
      if (node.outputs?.length) body['output'] = node.outputs.map((item) => ({ path: item.path, required: item.required }))
      files[`${kernelId}.yaml`] = yamlDump(body, { lineWidth: -1, noRefs: true })

      const wire = wires[0]
      edge = wire
        ? { kind: 'direct', to: nodeId(wire.to), user_confirm: node.confirm ? 'must' : 'skip' }
        : { kind: 'terminal', user_confirm: 'skip' }
    } else if (node.kind === 'branch') {
      const field = node.field!
      const options = node.options ?? []
      files[`${kernelId}.yaml`] = yamlDump(promptNode(node), { lineWidth: -1, noRefs: true })
      edge = {
        kind: 'choice',
        user_confirm: node.confirm ? 'must' : 'skip',
        data_schema: {
          description: node.question!,
          fields: { [field]: { description: node.question!, example: options[0]!.value } },
        },
        choices: wires.map((wire) => {
          const option = options[wire.option ?? -1]
          if (!option) throw new AawError('INVALID_ARGUMENT', `分支 ${node.name} 出线缺少对应选项`)
          return { when: `data.${field} == '${option.value}'`, to: nodeId(wire.to) }
        }),
        reject: [{
          message: `「${node.name}」提交的 ${field} 不在任何分支选项内（${options.map((option) => option.value).join('/')}），请修正后重新提交。`,
        }],
      }
    } else {
      files[`${kernelId}.yaml`] = yamlDump(promptNode(node), { lineWidth: -1, noRefs: true })
      const each = wires.find((wire) => wire.outlet === 'each')!
      const join = wires.find((wire) => wire.outlet === 'join')!
      edge = {
        kind: 'choice',
        user_confirm: node.confirm ? 'must' : 'skip',
        data_schema: {
          description: `提交 ${node.sourceField} 清单（逐项展开）`,
          fields: { [node.sourceField!]: { description: node.sourceField, example: [] } },
        },
        choices: [{
          when: `data.${node.sourceField}`,
          to: nodeId(each.to),
          foreach: `data.${node.sourceField}`,
          scheduling: 'serial',
          join_to: nodeId(join.to),
          vars: { [node.itemVar ?? '模块名']: '{item}' },
        }],
      }
    }
    edges[kernelId] = edge
  }

  return { ...files, 'flow.yaml': yamlDump({ entrypoints, edges }, { lineWidth: -1, noRefs: true }) }
}

function promptNode(node: CanvasNode): Record<string, unknown> {
  return {
    name: `${node.name}`,
    execution: 'prompt',
    prompt: { steps: [{ do: node.prompt ?? `执行：${node.name}` }] },
  }
}

// -- parse back (canvas load) ----------------------------------------------------

export async function listGraphWorkflows(repoPath: string): Promise<GraphWorkflow[]> {
  const dir = join(repoPath, DEFINITIONS_SUBDIR)
  let flow: { entrypoints?: Record<string, { start?: string; vars?: string[]; title?: string }>; edges?: Record<string, KernelEdge & { choices?: Array<Record<string, unknown> & { vars?: Record<string, string> }> }> }
  try {
    flow = yamlLoad(await readFile(join(dir, 'flow.yaml'), 'utf8')) as typeof flow
  } catch {
    return []
  }
  const result: GraphWorkflow[] = []
  for (const [id, entry] of Object.entries(flow?.entrypoints ?? {})) {
    try {
      result.push(await parseGraphWorkflow(id, entry ?? {}, flow?.edges ?? {}, dir))
    } catch {
      // not expressible on the v2 canvas (hand-authored YAML) — skip from editing
    }
  }
  return result
}

async function parseGraphWorkflow(id: string, entry: { start?: string; title?: string }, edges: Record<string, KernelEdge & { choices?: Array<Record<string, unknown> & { vars?: Record<string, string> }> }>, dir: string): Promise<GraphWorkflow> {
  if (!entry.start) throw new Error('no start')
  const nodes: CanvasNode[] = []
  const wires: CanvasWire[] = []
  const visited = new Set<string>()
  let seq = 0
  const nidOf = new Map<string, string>()
  const queue = [entry.start]
  while (queue.length > 0) {
    const kernelId = queue.shift()!
    if (visited.has(kernelId)) continue
    visited.add(kernelId)
    const edge = edges[kernelId]
    const nodeYaml = (yamlLoad(await readFile(join(dir, `${kernelId}.yaml`), 'utf8')) ?? {}) as {
      name?: string
      execution?: string
      skill?: string[]
      prompt?: { steps?: Array<Record<string, string>> }
      input?: Array<{ path: string; required?: boolean }>
      output?: Array<{ path: string; required?: boolean }>
    }
    let nid = nidOf.get(kernelId)
    if (!nid) {
      nid = `n${++seq}`
      nidOf.set(kernelId, nid)
    }
    const base: CanvasNode = {
      nid,
      kind: 'step',
      name: String(nodeYaml.name ?? kernelId).split('：').pop() ?? kernelId,
      prompt: String(nodeYaml.prompt?.steps?.[0]?.['do'] ?? ''),
      skill: nodeYaml.execution === 'skill' ? String(nodeYaml.skill?.[0] ?? '') : undefined,
      inputs: (nodeYaml.input ?? []).map((item) => ({ path: item.path, required: item.required !== false })),
      outputs: (nodeYaml.output ?? []).map((item) => ({ path: item.path, required: item.required !== false })),
      confirm: false,
    }
    if (nodeYaml.execution === 'skill' && !base.skill) throw new Error('skill 引用为空，无法在画布编辑')
    nodes.push(base)

    if (!edge || edge.kind === 'terminal') continue
    if (edge.kind === 'direct') {
      const target = await ensureNid(edge.to!)
      wires.push({ from: nid, to: target })
      queue.push(edge.to!)
      continue
    }
    if (edge.kind === 'foreach') {
      throw new Error('裸 foreach 边暂不支持画布编辑')
    }
    // choice: branch or loop
    const choices = edge.choices ?? []
    const loopChoice = choices.find((choice) => typeof choice['foreach'] === 'string')
    if (loopChoice) {
      const joinTo = String(loopChoice['join_to'] ?? '')
      if (!joinTo || choices.length !== 1) throw new Error('复杂 choice 无法在画布编辑')
      const sourceField = String(loopChoice['foreach']).replace(/^data\./, '')
      base.kind = 'loop'
      base.sourceField = sourceField
      base.itemVar = String(Object.keys(loopChoice.vars ?? { 模块名: '{}' })[0] ?? '模块名')
      const eachNid = await ensureNid(String(loopChoice['to']))
      const joinNid = await ensureNid(joinTo)
      wires.push({ from: nid, to: eachNid, outlet: 'each' })
      wires.push({ from: nid, to: joinNid, outlet: 'join' })
      queue.push(String(loopChoice['to']), joinTo)
      continue
    }
    // branch: every choice must be a `data.<f> == '<v>'` equality over one field
    const fieldMatch = choices.map((choice) => String(choice['when'] ?? '').match(/^data\.([A-Za-z_][A-Za-z0-9_]*) == '(.+)'$/))
    if (fieldMatch.some((match) => !match) || choices.length < 2) throw new Error('choice 条件不是简单等式，无法在画布编辑')
    const field = fieldMatch[0]![1]
    if (fieldMatch.some((match) => match![1] !== field)) throw new Error('分支条件字段不一致，无法在画布编辑')
    base.kind = 'branch'
    base.field = field
    base.question = String(edge.data_schema?.description ?? `选择 ${field}`)
    const options = fieldMatch.map((match, index) => {
      const raw = choices[index]!
      return { value: match![2], label: match![2] }
    })
    base.options = options
    for (const [index, choice] of choices.entries()) {
      const target = String(choice['to'])
      const targetNid = await ensureNid(target)
      wires.push({ from: nid, to: targetNid, option: index })
      queue.push(target)
    }
  }

  async function ensureNid(kernelId: string): Promise<string> {
    const existing = nidOf.get(kernelId)
    if (existing) return existing
    const nid = `n${++seq}`
    nidOf.set(kernelId, nid)
    queue.push(kernelId)
    return nid
  }

  return { id, title: String(entry.title ?? id), nodes, wires }
}

// -- persistence -------------------------------------------------------------------

/**
 * Persist one canvas workflow: write/refresh its node files and rewrite ONLY
 * its own entrypoint + edge sections inside the shared project flow.yaml
 * (other workflows sharing this repo keep their sections untouched).
 */
export async function saveGraphWorkflow(repoPath: string, workflow: GraphWorkflow): Promise<string[]> {
  validateGraphWorkflow(workflow)
  const dir = join(repoPath, DEFINITIONS_SUBDIR)
  await mkdir(dir, { recursive: true })

  const files = compileGraph(workflow)
  const keep = new Set(Object.keys(files))

  const previous = (await readdir(dir).catch(() => [] as string[]))
    .filter((name) => name.startsWith(`${workflow.id}-`) && name.endsWith('.yaml'))
  for (const name of previous) {
    if (!keep.has(name)) await unlink(join(dir, name)).catch(() => {})
  }

  // merge into the shared flow.yaml: replace only this workflow's sections
  let shared: { entrypoints?: Record<string, unknown>; edges?: Record<string, unknown> }
  try {
    shared = yamlLoad(await readFile(join(dir, 'flow.yaml'), 'utf8')) as typeof shared
  } catch {
    shared = {}
  }
  const compiled = yamlLoad(files['flow.yaml']) as { entrypoints: Record<string, unknown>; edges: Record<string, unknown> }
  const entrypoints = { ...(shared.entrypoints ?? {}) }
  const edges = { ...(shared.edges ?? {}) }
  for (const key of Object.keys(edges)) {
    if (key.startsWith(`${workflow.id}-`)) delete edges[key]
  }
  Object.assign(entrypoints, compiled.entrypoints)
  Object.assign(edges, compiled.edges)
  const mergedFlow = yamlDump({ entrypoints, edges }, { lineWidth: -1, noRefs: true })

  const written: string[] = []
  for (const [name, content] of Object.entries(files)) {
    if (name === 'flow.yaml') continue
    await writeFile(join(dir, name), content, 'utf8')
    written.push(name)
  }
  await writeFile(join(dir, 'flow.yaml'), mergedFlow, 'utf8')
  written.push('flow.yaml')
  return written
}
