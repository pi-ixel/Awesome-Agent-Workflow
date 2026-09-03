import './ui.css'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import { createApp, defineComponent } from 'vue'
import { VueFlow, Handle } from '@vue-flow/core'
import { contributions } from './contributions.js'
import { AawClient } from './ui-client.js'
import { projectStatusToGraph, stateLabel, type GraphProjection, type StatusPayload } from './graph.js'
import type { PlanEdge, PlanNode, Workspace, WorkflowListResult } from './contract.js'
import type { CanvasNode, CanvasWire, NodeKind } from './custom-defs.js'

declare const BUNDLE_VERSION: string
declare const UI_STYLES: string

export const version = BUNDLE_VERSION
export { contributions }

const ENTRIES = [
  { value: 'sr', label: 'sr · 完整流程', needsRequirement: true },
  { value: 'dev', label: 'dev · 个人轻量', needsRequirement: false },
  { value: 'ar', label: 'ar · AR 快速通道', needsRequirement: false },
] as const

const NODE_LABEL: Record<NodeKind, string> = { step: '步骤', branch: '分支', loop: '循环' }

const App = defineComponent({
  name: 'AawApp',
  components: { VueFlow, Handle },
  props: { bundleId: { type: String, required: true } },
  data() {
    return {
      client: null as AawClient | null,
      view: 'watch' as 'watch' | 'canvas',
      workspaces: [] as Workspace[],
      workspaceId: '',
      srs: [] as string[],
      sr: '',
      projection: null as GraphProjection | null,
      plan: null as { nodes: PlanNode[]; edges: PlanEdge[] } | null,
      busy: false,
      error: '',
      showWorkspaceForm: false,
      wsForm: { path: '', interpreter: 'python', script: '' },
      wsError: '',
      showStart: false,
      startError: '',
      startForm: { entry: 'dev', sr: '', requirement: '', ar: '', title: '' },
      customWorkflows: [] as Array<{ id: string; title: string; nodes: Array<Record<string, unknown>>; wires: Array<{ from: string; to: string; option?: number; outlet?: 'each' | 'join' }> }>,
      // canvas state (v2: free-wired graph)
      canvasId: '',
      canvasTitle: '',
      canvasNodes: [] as CanvasNode[],
      canvasWires: [] as CanvasWire[],
      canvasSelected: '',
      canvasMsg: '',
      canvasError: '',
      nodePos: {} as Record<string, { x: number; y: number }>,
      refreshTimer: null as ReturnType<typeof setInterval> | null,
      stateLabel,
      NODE_LABEL,
    }
  },
  computed: {
    entries(): Array<{ value: string; label: string; needsRequirement: boolean }> {
      return [
        ...ENTRIES.map((item) => ({ ...item })),
        ...this.customWorkflows.map((item) => ({ value: item.id, label: `自定义 · ${item.title}`, needsRequirement: false })),
      ]
    },
    currentEntry(): { value: string; label: string; needsRequirement: boolean } {
      return this.entries.find((item) => item.value === this.startForm.entry) ?? this.entries[0]!
    },
    /** Watch view: materialized steps + dashed template ghosts for the not-yet-generated tail. */
    graph(): { nodes: GraphProjection['nodes']; edges: GraphProjection['edges'] } {
      if (!this.projection) return { nodes: [], edges: [] }
      const nodes = [...this.projection.nodes]
      const edges = [...this.projection.edges]
      if (!this.plan || this.plan.nodes.length === 0) return { nodes, edges }

      const materializedTypes = new Set(nodes.map((node) => node.data.stepType))
      const ghosts = this.plan.nodes.filter((node) => !materializedTypes.has(node.id))
      if (ghosts.length === 0) return { nodes, edges }
      const ghostIds = new Set(ghosts.map((node) => node.id))

      const depth = new Map<string, number>()
      const ghostEdges = this.plan.edges.filter((edge) => ghostIds.has(edge.to))
      let changed = true
      while (changed) {
        changed = false
        for (const edge of ghostEdges) {
          const base = ghostIds.has(edge.from) ? (depth.get(edge.from) ?? -1) + 1 : 0
          if ((depth.get(edge.to) ?? -1) < base) {
            depth.set(edge.to, base)
            changed = true
          }
        }
      }

      const maxMatX = nodes.reduce((max, node) => Math.max(max, node.position.x), 0)
      const rowsPerDepth = new Map<number, number>()
      for (const ghost of ghosts) {
        const d = depth.get(ghost.id) ?? 0
        const row = rowsPerDepth.get(d) ?? 0
        rowsPerDepth.set(d, row + 1)
        const incoming = this.plan!.edges.find((edge) => edge.to === ghost.id)
        nodes.push({
          id: `tpl:${ghost.id}`,
          type: 'aaw-step',
          position: { x: maxMatX + 300 * (d + 1), y: 40 + row * 150 },
          draggable: true,
          data: {
            stepId: -1,
            name: ghost.name,
            stepType: ghost.id,
            execution: '',
            state: 'pending' as const,
            attempt: 1,
            startedAt: null,
            endedAt: null,
            isTaskDev: false,
            taskDevPhase: null,
            pendingConfirm: false,
            ghost: true,
            isGate: ghost.is_gate,
            needConfirm: incoming?.user_confirm === 'must',
            edgeKind: incoming?.kind ?? 'direct',
          },
        })
      }

      for (const edge of this.plan.edges) {
        const label = edge.kind === 'foreach' ? 'foreach ×N' : edge.kind === 'choice' ? 'choice' : edge.kind === 'join' ? 'join' : undefined
        if (ghostIds.has(edge.from) && ghostIds.has(edge.to)) {
          edges.push({
            id: `ge${edge.from}-${edge.to}`,
            source: `tpl:${edge.from}`,
            target: `tpl:${edge.to}`,
            animated: false,
            label,
            style: { stroke: '#94a3b8', strokeDasharray: '6 4' },
          })
        } else if (!ghostIds.has(edge.from) && ghostIds.has(edge.to)) {
          const outgoing = new Set(edges.map((item) => item.source))
          let sources = nodes.filter(
            (node) => !node.data.ghost && node.data.stepType === edge.from && !outgoing.has(node.id),
          )
          if (sources.length === 0) {
            sources = nodes.filter((node) => !node.data.ghost && node.data.stepType === edge.from)
          }
          for (const source of sources) {
            edges.push({
              id: `ge${source.id}-${edge.to}`,
              source: source.id,
              target: `tpl:${edge.to}`,
              animated: source.data.state === 'running',
              label,
              style: { stroke: '#94a3b8', strokeDasharray: '6 4' },
            })
          }
        }
      }
      return { nodes, edges }
    },
    canvasFlowNodes() {
      return this.canvasNodes.map((node, index) => {
        const position = this.nodePos[node.nid] ?? { x: 40 + (index % 4) * 300, y: 40 + Math.floor(index / 4) * 190 }
        return { id: node.nid, type: 'aaw-step', position, draggable: true, data: { node } }
      })
    },
    canvasFlowEdges() {
      return this.canvasWires.map((wire, index) => {
        const source = this.canvasNodes.find((node) => node.nid === wire.from)
        let label = ''
        let style: Record<string, string> = { stroke: '#94a3b8' }
        if (source?.kind === 'branch' && wire.option !== undefined) {
          label = source.options?.[wire.option]?.value ?? `选项${(wire.option ?? 0) + 1}`
          style = { stroke: '#f59e0b' }
        } else if (wire.outlet === 'join') {
          label = '完成后'
          style = { stroke: '#2563eb', strokeDasharray: '6 4' }
        } else if (wire.outlet === 'each') {
          label = '每项 ×N'
          style = { stroke: '#16a34a' }
        }
        return {
          id: `w${index}-${wire.from}-${wire.to}`,
          source: wire.from,
          target: wire.to,
          sourceHandle: wire.outlet ?? (wire.option !== undefined ? `opt-${wire.option}` : 'out'),
          targetHandle: 'in',
          animated: false,
          label,
          style,
        }
      })
    },
    selectedNode(): CanvasNode | null {
      return this.canvasNodes.find((node) => node.nid === this.canvasSelected) ?? null
    },
    selectedWires(): Array<{ wire: CanvasWire; index: number; title: string }> {
      if (!this.selectedNode) return []
      return this.canvasWires
        .map((wire, index) => ({ wire, index }))
        .filter(({ wire }) => wire.from === this.selectedNode!.nid)
        .map(({ wire, index }) => {
          const target = this.canvasNodes.find((node) => node.nid === wire.to)?.name ?? wire.to
          const outlet = wire.outlet === 'join' ? '完成后 → ' : wire.outlet === 'each' ? '每项 → ' : wire.option !== undefined ? `选项「${this.selectedNode!.options?.[wire.option]?.value ?? ''}」 → ` : ''
          return { wire, index, title: `${outlet}${target}` }
        })
    },
  },
  created() {
    this.client = new AawClient(this.bundleId)
  },
  mounted() {
    void this.refreshAll()
    // v1 keeps a light poll; the controlled plugin-events SSE route will replace it.
    this.refreshTimer = setInterval(() => void this.refreshStatus(), 15_000)
  },
  beforeUnmount() {
    if (this.refreshTimer) clearInterval(this.refreshTimer)
  },
  methods: {
    guard<T>(action: () => Promise<T>, errorKey: 'error' | 'wsError' | 'startError' | 'canvasError' = 'error'): Promise<T | undefined> {
      if (this.busy) return Promise.resolve(undefined)
      this.busy = true
      if (errorKey === 'wsError') this.wsError = ''
      else if (errorKey === 'startError') this.startError = ''
      else if (errorKey === 'canvasError') { this.canvasError = ''; this.canvasMsg = '' }
      else this.error = ''
      return action()
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          if (errorKey === 'wsError') this.wsError = message
          else if (errorKey === 'startError') this.startError = message
          else if (errorKey === 'canvasError') this.canvasError = message
          else this.error = message
          return undefined
        })
        .finally(() => {
          this.busy = false
        })
    },
    switchView(view: 'watch' | 'canvas') {
      this.view = view
      if (view === 'canvas' && this.workspaceId) void this.loadCustomList()
    },
    async loadCustomList() {
      const { workflows } = await this.client!.call<WorkflowListResult>('workflow.listCustom', { workspaceId: this.workspaceId })
      this.customWorkflows = workflows as unknown as typeof this.customWorkflows
    },
    refreshAll() {
      // select outside the guard: guard() drops re-entrant calls while busy
      return this.guard(async () => {
        const toSelect = await this.reloadWorkspaces()
        await this.loadCustomList().catch(() => {})
        return toSelect
      }).then((toSelect) => {
        if (toSelect) return this.selectSr(toSelect)
      })
    },
    async reloadWorkspaces(): Promise<string> {
      const listed = await this.client!.call<{ workspaces: Workspace[] }>('workspace.list')
      this.workspaces = listed.workspaces
      if (!this.workspaceId && this.workspaces.length > 0) this.workspaceId = this.workspaces[0]!.id
      if (!this.workspaceId) return ''
      const { srs } = await this.client!.call<{ srs: string[] }>('srs.list', { workspaceId: this.workspaceId })
      this.srs = srs
      if (this.sr && !srs.includes(this.sr)) {
        this.sr = ''
        this.projection = null
        this.plan = null
      }
      if (!this.sr && srs.length > 0) return srs[0]!
      return ''
    },
    onWorkspaceChange() {
      this.sr = ''
      this.projection = null
      this.plan = null
      this.guard(async () => {
        const toSelect = await this.reloadWorkspaces()
        await this.loadCustomList().catch(() => {})
        return toSelect
      }).then((toSelect) => {
        if (toSelect) return this.selectSr(toSelect)
      })
    },
    selectSr(sr: string) {
      this.sr = sr
      return this.refreshStatus()
    },
    refreshStatus() {
      if (!this.sr || !this.workspaceId) return Promise.resolve()
      return this.guard(async () => {
        const [statusResult, planResult] = await Promise.all([
          this.client!.call<{ status: StatusPayload }>('srs.status', { workspaceId: this.workspaceId, sr: this.sr }),
          this.client!.call<{ status: { nodes: PlanNode[]; edges: PlanEdge[] } }>('srs.plan', {
            workspaceId: this.workspaceId,
            sr: this.sr,
          }).catch(() => null),
        ])
        this.projection = projectStatusToGraph(statusResult.status)
        this.plan = planResult?.status ?? null
      })
    },
    submitWorkspace() {
      const path = this.wsForm.path.trim()
      const command = [this.wsForm.interpreter.trim(), this.wsForm.script.trim()].filter(Boolean)
      this.guard(async () => {
        const { workspace } = await this.client!.call<{ workspace: Workspace }>('workspace.add', { path, aawCommand: command })
        this.showWorkspaceForm = false
        this.wsForm = { path: '', interpreter: 'python', script: '' }
        this.workspaceId = workspace.id
        await this.reloadWorkspaces()
        await this.loadCustomList().catch(() => {})
        return undefined
      }, 'wsError')
    },
    async removeWorkspace(id: string) {
      await this.client!.call('workspace.remove', { id })
      if (this.workspaceId === id) {
        this.workspaceId = ''
        this.sr = ''
        this.projection = null
        this.plan = null
      }
      await this.reloadWorkspaces()
      await this.loadCustomList().catch(() => {})
    },
    submitRemove(id: string) {
      this.guard(() => this.removeWorkspace(id), 'wsError').then((toSelect) => {
        if (toSelect) return this.selectSr(toSelect)
      })
    },
    submitStart() {
      const form = this.startForm
      const sr = form.sr.trim() || undefined
      const vars: Record<string, string> = {}
      if (form.entry === 'ar') {
        if (!form.ar.trim() || !form.title.trim()) {
          this.startError = 'ar 入口需要 AR 编号和标题'
          return
        }
        vars['AR'] = form.ar.trim()
        vars['TITLE'] = form.title.trim()
      }
      const requirement = this.currentEntry.needsRequirement ? form.requirement : undefined
      let createdSr = ''
      // NOTE: the follow-up select must run OUTSIDE the guard — guard() drops
      // re-entrant calls while busy, so the inner refresh would be lost.
      this.guard(async () => {
        const { started } = await this.client!.call<{ started: Record<string, unknown> }>('srs.start', {
          workspaceId: this.workspaceId,
          entry: form.entry,
          sr,
          vars: Object.keys(vars).length ? vars : undefined,
          requirement,
        })
        this.showStart = false
        this.startForm = { entry: 'dev', sr: '', requirement: '', ar: '', title: '' }
        createdSr = typeof started['sr'] === 'string' ? (started['sr'] as string) : ''
        const { srs } = await this.client!.call<{ srs: string[] }>('srs.list', { workspaceId: this.workspaceId })
        this.srs = srs
      }, 'startError').then(() => {
        if (createdSr && this.srs.includes(createdSr) && this.sr !== createdSr) {
          this.view = 'watch'
          void this.selectSr(createdSr)
        }
      })
    },
    // -- canvas v2 ---------------------------------------------------------------

    canvasAdd(kind: NodeKind) {
      if (this.canvasNodes.length === 0 && !this.canvasId.trim()) this.canvasId = `flow-${Date.now().toString(36).slice(-5)}`
      const seq = this.canvasNodes.length + 1
      const nid = `n${Date.now().toString(36).slice(-4)}${seq}`
      let node: CanvasNode
      if (kind === 'step') {
        node = { nid, kind, name: `步骤${seq}`, prompt: '', inputs: [], outputs: [], confirm: false }
      } else if (kind === 'branch') {
        node = { nid, kind, name: `分支${seq}`, field: 'route', question: '请选择处理方式', options: [{ value: 'yes', label: '是' }, { value: 'no', label: '否' }] }
      } else {
        node = { nid, kind, name: `循环${seq}`, sourceField: 'modules', itemVar: '模块名' }
      }
      this.canvasNodes.push(node)
      this.canvasSelected = nid
    },
    canvasRemove(nid: string) {
      this.canvasNodes = this.canvasNodes.filter((node) => node.nid !== nid)
      this.canvasWires = this.canvasWires.filter((wire) => wire.from !== nid && wire.to !== nid)
      if (this.canvasSelected === nid) this.canvasSelected = ''
    },
    canvasAddOption(nid: string) {
      const node = this.canvasNodes.find((item) => item.nid === nid)
      if (!node) return
      const options = node.options ?? []
      options.push({ value: `opt${options.length + 1}`, label: `选项${options.length + 1}` })
      node.options = options
    },
    canvasRemoveOption(nid: string, index: number) {
      const node = this.canvasNodes.find((item) => item.nid === nid)
      if (!node?.options) return
      node.options.splice(index, 1)
      this.canvasWires = this.canvasWires.filter((wire) => !(wire.from === nid && wire.option === index))
      this.canvasWires.forEach((wire) => {
        if (wire.from === nid && wire.option !== undefined && wire.option > index) wire.option -= 1
      })
    },
    addArtifact(nid: string, key: 'inputs' | 'outputs') {
      const node = this.canvasNodes.find((item) => item.nid === nid)
      if (!node) return
      const arr = node[key] ?? []
      arr.push({ path: '', required: true })
      node[key] = arr
    },
    removeArtifact(nid: string, key: 'inputs' | 'outputs', index: number) {
      const node = this.canvasNodes.find((item) => item.nid === nid)
      node?.[key]?.splice(index, 1)
    },
    canvasNew() {
      this.canvasId = `flow-${Date.now().toString(36).slice(-5)}`
      this.canvasTitle = ''
      this.canvasNodes = [{ nid: 'n1', kind: 'step', name: '第一步', prompt: '', inputs: [], outputs: [], confirm: false }]
      this.canvasWires = []
      this.canvasSelected = ''
      this.canvasMsg = ''
      this.canvasError = ''
      this.nodePos = {}
    },
    canvasLoad(id: string) {
      const workflow = this.customWorkflows.find((item) => item.id === id)
      if (!workflow) return
      this.canvasId = workflow.id
      this.canvasTitle = workflow.title
      this.canvasNodes = (workflow.nodes as unknown as CanvasNode[]).map((node) => ({ ...node }))
      this.canvasWires = (workflow.wires as unknown as CanvasWire[]).map((wire) => ({ ...wire }))
      this.canvasSelected = ''
      this.canvasMsg = ''
      this.canvasError = ''
      this.nodePos = {}
    },
    canvasSave() {
      this.guard(async () => {
        const { ok, entry } = await this.client!.call<{ ok: true; entry: string }>('workflow.saveCustom', {
          workspaceId: this.workspaceId,
          workflow: { id: this.canvasId.trim(), title: this.canvasTitle.trim(), nodes: this.canvasNodes, wires: this.canvasWires },
        })
        await this.loadCustomList()
        this.canvasMsg = `已保存为自定义工作流「${entry}」，可在「启动工作流」的入口里选择并启动。`
        return ok
      }, 'canvasError')
    },
    onConnect(params: { source: string; target: string; sourceHandle?: string | null }) {
      const source = this.canvasNodes.find((node) => node.nid === params.source)
      if (!source || params.source === params.target) return
      const wire: CanvasWire = { from: params.source, to: params.target }
      if (source.kind === 'branch') {
        const index = Number((params.sourceHandle ?? '').replace('opt-', ''))
        if (Number.isNaN(index)) return
        wire.option = index
      } else if (source.kind === 'loop') {
        if (params.sourceHandle !== 'each' && params.sourceHandle !== 'join') return
        wire.outlet = params.sourceHandle
      }
      const duplicate = this.canvasWires.some((item) =>
        item.from === wire.from && item.to === wire.to &&
        item.option === wire.option && item.outlet === wire.outlet,
      )
      if (!duplicate) this.canvasWires.push(wire)
    },
    removeWire(index: number) {
      this.canvasWires.splice(index, 1)
    },
    wireTitle(wire: CanvasWire): string {
      const target = this.canvasNodes.find((node) => node.nid === wire.to)?.name ?? wire.to
      const outlet = wire.outlet === 'join' ? '完成后 → ' : wire.outlet === 'each' ? '每项 → ' : wire.option !== undefined ? `选项「${this.selectedNode?.options?.[wire.option]?.value ?? ''}」 → ` : ''
      return `${outlet}${target}`
    },
    onModeChange(mode: string) {
      const node = this.selectedNode
      if (!node) return
      if (mode === 'skill') {
        node.skill = node.skill || 'skill-b'
      } else {
        node.skill = undefined
        if (node.prompt === undefined) node.prompt = ''
      }
    },
    onNodeDragStop(params: { node: { id: string; position: { x: number; y: number } } }) {
      this.nodePos[params.node.id] = params.node.position
    },
    selectNode(nid: string) {
      this.canvasSelected = nid
    },
  },
  template: `
    <div class="aaw-app">
      <header class="aaw-bar">
        <b>AAW 工作流</b>
        <div class="aaw-tabs">
          <button type="button" :class="{ active: view === 'watch' }" @click="switchView('watch')">监看</button>
          <button type="button" :class="{ active: view === 'canvas' }" @click="switchView('canvas')">画布</button>
        </div>
        <span v-if="!workspaces.length" class="aaw-empty">尚未登记工作区</span>
        <select v-else v-model="workspaceId" @change="onWorkspaceChange">
          <option v-for="w in workspaces" :key="w.id" :value="w.id">{{ w.path }}</option>
        </select>
        <button type="button" @click="showWorkspaceForm = !showWorkspaceForm">工作区管理…</button>
        <button type="button" :disabled="busy" @click="refreshAll">刷新</button>
        <button type="button" class="aaw-primary" :disabled="!workspaceId" @click="showStart = !showStart">启动工作流</button>
        <span v-if="error" class="aaw-error">{{ error }}</span>
      </header>

      <div v-if="showWorkspaceForm" class="aaw-form">
        <b>工作区管理</b>
        <div v-for="w in workspaces" :key="w.id" class="aaw-wsrow">
          <span class="aaw-wsrow__path">{{ w.path }}</span>
          <button type="button" :disabled="busy" @click="submitRemove(w.id)">移除</button>
        </div>
        <p v-if="!workspaces.length" class="aaw-hint" style="width:100%">尚未登记工作区。</p>
        <label>仓库绝对路径<input v-model="wsForm.path" placeholder="D:\\\\dev\\\\my-project" @keydown.enter="submitWorkspace"></label>
        <label>AAW CLI 命令<input v-model="wsForm.interpreter" placeholder="python / aaw"></label>
        <label>aaw.py 路径（命令为 aaw 时留空）<input v-model="wsForm.script" placeholder="D:\\\\...\\\\scripts\\\\aaw.py" @keydown.enter="submitWorkspace"></label>
        <div class="aaw-form__actions">
          <button type="button" class="aaw-primary" :disabled="busy || !wsForm.path.trim()" @click="submitWorkspace">登记</button>
          <button type="button" @click="showWorkspaceForm = false">关闭</button>
          <span v-if="wsError" class="aaw-error">{{ wsError }}</span>
        </div>
        <p class="aaw-hint">登记时会真实调用一次 aaw status 做冒烟校验；工作区注册表保存在本机插件数据目录。</p>
      </div>

      <div v-if="showStart" class="aaw-form">
        <b>启动工作流实例</b>
        <label>入口
          <select v-model="startForm.entry">
            <option v-for="e in entries" :key="e.value" :value="e.value">{{ e.label }}</option>
          </select>
        </label>
        <label>实例编号（SR）<input v-model="startForm.sr" placeholder="SR-001（可留空由 CLI 分配）"></label>
        <template v-if="startForm.entry === 'ar'">
          <label>AR 编号<input v-model="startForm.ar" placeholder="AR-001"></label>
          <label>标题<input v-model="startForm.title" placeholder="用户管理"></label>
        </template>
        <label v-if="currentEntry.needsRequirement" class="aaw-form__wide">原始需求<textarea v-model="startForm.requirement" placeholder="粘贴原始需求文本…（CLI 会原文保存为 original-requirement.md）"></textarea></label>
        <div class="aaw-form__actions">
          <button type="button" class="aaw-primary" :disabled="busy" @click="submitStart">启动</button>
          <button type="button" @click="showStart = false">取消</button>
          <span v-if="startError" class="aaw-error">{{ startError }}</span>
        </div>
        <p class="aaw-hint">自定义工作流在画布上搭建；启动后切到「监看」跟随进度，执行由 Chrys 驱动。</p>
      </div>

      <div v-if="view === 'watch'" class="aaw-main">
        <aside class="aaw-side">
          <div class="aaw-side__head"><span>SR 列表</span><button type="button" :disabled="busy" @click="refreshAll">↻</button></div>
          <button v-for="s in srs" :key="s" type="button" class="aaw-sr" :class="{ active: s === sr }" @click="selectSr(s)">{{ s }}</button>
          <p v-if="!srs.length" class="aaw-empty">{{ workspaceId ? '暂无 SR' : '请先登记工作区' }}</p>
        </aside>

        <section class="aaw-graph">
          <div v-if="projection" class="aaw-summary">
            <span class="aaw-chip">{{ projection.summary.sr }}</span>
            <span class="aaw-chip">entry: {{ projection.summary.entry }}</span>
            <span class="aaw-chip">{{ projection.summary.workflowStatus }}</span>
            <span class="aaw-chip st-done">完成 {{ projection.summary.counts.done }}/{{ projection.summary.total }}</span>
            <span v-if="projection.summary.counts.running" class="aaw-chip st-running">进行中 {{ projection.summary.counts.running }}</span>
            <span v-if="projection.summary.counts.failed" class="aaw-chip st-failed">失败 {{ projection.summary.counts.failed }}</span>
            <span v-if="plan" class="aaw-chip st-ghost">规划 {{ plan.nodes.length }} 步 · 未生成 {{ graph.nodes.filter(n => n.data.ghost).length }}</span>
            <div v-if="projection.summary.pendingConfirmNames.length" class="aaw-confirm-banner">
              等待用户确认：step {{ sr }} → {{ projection.summary.pendingConfirmNames.join('、') }}（请在与 Agent 的对话中确认）
            </div>
            <div v-if="projection.summary.driftMessage" class="aaw-drift">{{ projection.summary.driftMessage }}</div>
          </div>

          <VueFlow
            v-if="graph.nodes.length"
            class="aaw-canvas"
            :nodes="graph.nodes"
            :edges="graph.edges"
            :fit-view-on-init="true"
            :nodes-connectable="false"
            :edges-updatable="false"
          >
            <template #node-aaw-step="p">
              <div v-if="p.data.ghost" class="aaw-node is-ghost">
                <Handle type="target" position="left" />
                <div class="aaw-node__head">{{ p.data.name }}</div>
                <div class="aaw-node__chips">
                  <span class="aaw-chip st-ghost">未生成</span>
                  <span v-if="p.data.isGate" class="aaw-chip st-blocked">门禁</span>
                  <span v-if="p.data.needConfirm" class="aaw-chip st-confirm">需确认</span>
                </div>
                <Handle type="source" position="right" />
              </div>
              <div v-else class="aaw-node" :class="'is-' + p.data.state">
                <Handle type="target" position="left" />
                <div class="aaw-node__head">#{{ p.data.stepId }} {{ p.data.name }}</div>
                <div class="aaw-node__chips">
                  <span class="aaw-chip">{{ p.data.stepType }}</span>
                  <span class="aaw-chip" :class="'st-' + p.data.state">{{ stateLabel(p.data.state) }}</span>
                  <span v-if="p.data.attempt > 1" class="aaw-chip st-retry">重跑 ×{{ p.data.attempt - 1 }}</span>
                  <span v-if="p.data.taskDevPhase" class="aaw-chip st-phase">{{ p.data.taskDevPhase }}</span>
                </div>
                <div v-if="p.data.pendingConfirm" class="aaw-node__confirm">等待用户确认</div>
                <Handle type="source" position="right" />
              </div>
            </template>
          </VueFlow>

          <div v-else class="aaw-empty aaw-graph__empty">
            {{ sr ? '正在加载工作流…' : '从左侧选择一个 SR 查看工作流图谱' }}
          </div>

          <footer v-if="graph.nodes.length" class="aaw-legend">
            <span>实线 = 已物化步骤</span><span>虚线 = 定义规划（随推进生成）</span><span>15s 自动刷新</span>
          </footer>
        </section>
      </div>

      <div v-if="view === 'canvas'" class="aaw-main">
        <section class="aaw-graph">
          <div class="aaw-form" style="border-bottom:none">
            <b>我的工作流画布</b>
            <label>标识（小写英文，保存后即启动入口名）<input v-model="canvasId" placeholder="repo-scan"></label>
            <label>名称<input v-model="canvasTitle" placeholder="仓库扫描与模块设计"></label>
            <label>加载已有
              <select @change="canvasLoad($event.target.value)">
                <option value="">选择…</option>
                <option v-for="w in customWorkflows" :key="w.id" :value="w.id">{{ w.title }}（{{ w.id }}）</option>
              </select>
            </label>
            <div class="aaw-form__actions">
              <button type="button" @click="canvasNew">新建</button>
              <button type="button" @click="canvasAdd('step')">＋ 步骤</button>
              <button type="button" @click="canvasAdd('branch')">＋ 分支</button>
              <button type="button" @click="canvasAdd('loop')">＋ 循环</button>
              <button type="button" class="aaw-primary" :disabled="busy || !canvasNodes.length || !canvasId.trim() || !workspaceId" @click="canvasSave">保存到当前工作区</button>
              <span v-if="canvasMsg" style="color:#166534">{{ canvasMsg }}</span>
              <span v-if="canvasError" class="aaw-error">{{ canvasError }}</span>
            </div>
            <p class="aaw-hint">拖拽排布节点；从右侧出口拖到目标左侧入口即连线。步骤 = 提示词或技能引用（可配输入/输出校验与确认门）；分支 = 按提交数据的取值路由；循环 = 按数据清单「每项」展开，全部完成后走「完成后」汇合。</p>
          </div>

          <div style="display:flex;flex:1;min-height:0">
            <VueFlow
              v-if="canvasNodes.length"
              class="aaw-canvas"
              :nodes="canvasFlowNodes"
              :edges="canvasFlowEdges"
              :fit-view-on-init="true"
              :nodes-connectable="true"
              :edges-updatable="false"
              @node-click="selectNodeProxy"
              @node-drag-stop="onNodeDragStop"
              @connect="onConnect"
            >
              <template #node-aaw-step="p">
                <div class="aaw-node aaw-cnode" :class="{ 'is-selected': canvasSelected === p.data.node.nid }" @click.stop="selectNode(p.data.node.nid)">
                  <Handle type="target" position="left" id="in" />
                  <div class="aaw-node__head">{{ p.data.node.name }}</div>
                  <div class="aaw-node__chips">
                    <span class="aaw-chip">{{ NODE_LABEL[p.data.node.kind] || p.data.node.kind }}</span>
                    <span v-if="p.data.node.kind === 'step' && p.data.node.skill" class="aaw-chip st-phase">技能: {{ p.data.node.skill }}</span>
                    <span v-if="p.data.node.kind === 'step' && p.data.node.confirm" class="aaw-chip st-confirm">确认门</span>
                    <span v-if="p.data.node.outputs?.length" class="aaw-chip st-done">输出×{{ p.data.node.outputs.length }}</span>
                  </div>
                  <div v-if="p.data.node.kind === 'branch'" class="aaw-cnode__outs">
                    <div v-for="(opt, i) in p.data.node.options" :key="i" class="aaw-cnode__out">
                      <span>{{ opt.value }}</span>
                      <Handle type="source" position="right" :id="'opt-' + i" :style="{ top: 12 + i * 22 + 'px' }" />
                    </div>
                  </div>
                  <div v-if="p.data.node.kind === 'loop'" class="aaw-cnode__outs">
                    <div class="aaw-cnode__out aaw-cnode__out--each"><span>每项 ×N</span><Handle type="source" position="right" id="each" :style="{ top: 12 + 'px' }" /></div>
                    <div class="aaw-cnode__out aaw-cnode__out--join"><span>完成后</span><Handle type="source" position="right" id="join" :style="{ top: 38 + 'px' }" /></div>
                  </div>
                  <Handle v-if="p.data.node.kind === 'step'" type="source" position="right" id="out" :style="{ top: 12 + 'px' }" />
                </div>
              </template>
            </VueFlow>
            <div v-else class="aaw-empty aaw-graph__empty">点击「＋ 步骤 / ＋ 分支 / ＋ 循环」开始搭建</div>

            <aside v-if="selectedNode" class="aaw-side" style="width:300px">
              <div class="aaw-side__head"><span>{{ NODE_LABEL[selectedNode.kind] }}：{{ selectedNode.name }}</span></div>
              <label class="aaw-editor__label">名称<input :value="selectedNode.name" @input="selectedNode.name = $event.target.value" maxlength="40"></label>

              <template v-if="selectedNode.kind === 'step'">
                <label class="aaw-editor__label">执行方式
                  <select :value="selectedNode.skill ? 'skill' : 'prompt'" @change="onModeChange($event.target.value)">
                    <option value="prompt">提示词（写清这一步做什么）</option>
                    <option value="skill">技能引用（执行一个已装技能）</option>
                  </select>
                </label>
                <label v-if="selectedNode.skill" class="aaw-editor__label">技能名<input :value="selectedNode.skill" @input="selectedNode.skill = $event.target.value" placeholder="skill-a"></label>
                <label v-else class="aaw-editor__label">执行提示词<textarea :value="selectedNode.prompt" @input="selectedNode.prompt = $event.target.value" placeholder="这一步要做什么，写清楚验收标准…"></textarea></label>

                <div class="aaw-editor__label">输入校验（开始前必须存在）
                  <div v-for="(a, i) in selectedNode.inputs" :key="'i' + i" class="aaw-io">
                    <input :value="a.path" @input="selectedNode.inputs[i].path = $event.target.value" placeholder=".sdd/{SR}/xxx.md">
                    <label class="aaw-io__req"><input type="checkbox" :checked="a.required" @change="selectedNode.inputs[i].required = $event.target.checked">必须</label>
                    <button type="button" @click="removeArtifact(selectedNode.nid, 'inputs', i)">×</button>
                  </div>
                  <button type="button" @click="addArtifact(selectedNode.nid, 'inputs')">＋ 输入</button>
                </div>
                <div class="aaw-editor__label">输出校验（完成时必须产出）
                  <div v-for="(a, i) in selectedNode.outputs" :key="'o' + i" class="aaw-io">
                    <input :value="a.path" @input="selectedNode.outputs[i].path = $event.target.value" placeholder=".sdd/{SR}/产出.md">
                    <label class="aaw-io__req"><input type="checkbox" :checked="a.required" @change="selectedNode.outputs[i].required = $event.target.checked">必须</label>
                    <button type="button" @click="removeArtifact(selectedNode.nid, 'outputs', i)">×</button>
                  </div>
                  <button type="button" @click="addArtifact(selectedNode.nid, 'outputs')">＋ 输出</button>
                </div>
                <label v-if="canvasWires.some(w => w.from === selectedNode.nid)" class="aaw-editor__check">
                  <input type="checkbox" :checked="selectedNode.confirm" @change="selectedNode.confirm = $event.target.checked"> 完成后需要用户确认才进入下一步
                </label>
              </template>

              <template v-if="selectedNode.kind === 'branch'">
                <label class="aaw-editor__label">数据字段名<input :value="selectedNode.field" @input="selectedNode.field = $event.target.value" placeholder="route"></label>
                <label class="aaw-editor__label">问题（写入提交校验说明）<input :value="selectedNode.question" @input="selectedNode.question = $event.target.value"></label>
                <div class="aaw-editor__label">选项（每个选项一条出线）
                  <div v-for="(opt, i) in selectedNode.options" :key="i" class="aaw-io">
                    <input :value="opt.value" @input="selectedNode.options[i].value = $event.target.value" placeholder="取值">
                    <input :value="opt.label" @input="selectedNode.options[i].label = $event.target.value" placeholder="显示名">
                    <button type="button" @click="canvasRemoveOption(selectedNode.nid, i)">×</button>
                  </div>
                  <button type="button" @click="canvasAddOption(selectedNode.nid)">＋ 选项</button>
                </div>
              </template>

              <template v-if="selectedNode.kind === 'loop'">
                <label class="aaw-editor__label">逐项来源字段（本节点提交数据里的数组）<input :value="selectedNode.sourceField" @input="selectedNode.sourceField = $event.target.value" placeholder="modules"></label>
                <label class="aaw-editor__label">逐项变量名（注入下游路径与提示词）<input :value="selectedNode.itemVar" @input="selectedNode.itemVar = $event.target.value" placeholder="模块名"></label>
              </template>

              <div class="aaw-form__actions" style="padding:8px 0">
                <button type="button" @click="canvasRemove(selectedNode.nid)">删除节点</button>
              </div>

              <div class="aaw-editor__label" v-if="selectedWires.length">
                本节点出线（× 删除）
                <div v-for="item in selectedWires" :key="item.index" class="aaw-io">
                  <span class="aaw-wiretext">{{ item.title }}</span>
                  <button type="button" @click="removeWire(item.index)">×</button>
                </div>
              </div>
            </aside>
          </div>

          <footer class="aaw-legend">
            <span>拖拽排布 · 出口拖到入口即连线</span><span>保存 = 写入仓库 .sdd/.aaw/definitions/，内核直接可执行</span>
          </footer>
        </section>
      </div>
    </div>
  `,
})

/**
 * Full-height native page.  The shell calls this with
 * `mount(container, { bundleId, pageId, version })` and expects a cleanup
 * function back.  Styles live in a ShadowRoot so the plugin never leaks CSS
 * into (or from) the Vue shell.
 */
export function mount(container: HTMLElement, context?: { bundleId?: string }) {
  const host = document.createElement('div')
  host.style.cssText = 'height:100%;width:100%'
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = UI_STYLES
  const appRoot = document.createElement('div')
  appRoot.className = 'aaw-root'
  shadow.append(style, appRoot)
  container.appendChild(host)

  const app = createApp(App, { bundleId: context?.bundleId || 'aaw-workflow' })
  app.config.errorHandler = (err, _instance, info) => {
    // Diagnostic channel: surfaces as the host element attribute, readable even in production builds.
    host.dataset.mountError = `${info}: ${err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)}`.slice(0, 2000)
  }
  app.mount(appRoot)
  if (appRoot.children.length === 0) {
    host.dataset.mountError = (host.dataset.mountError ?? '') + ' | render produced no element'
  }
}

/** Cordis UI plugin: registers the slot contributions with the shell. */
export default function aawUi(_context: unknown, config: { register(value: unknown): () => void }) {
  return contributions.map(config.register)
}
