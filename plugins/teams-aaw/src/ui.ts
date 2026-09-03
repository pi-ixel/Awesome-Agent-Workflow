import './ui.css'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import { createApp, defineComponent } from 'vue'
import { VueFlow, Handle } from '@vue-flow/core'
import { contributions } from './contributions.js'
import { AawClient } from './ui-client.js'
import { projectStatusToGraph, stateLabel, type GraphProjection, type StatusPayload } from './graph.js'
import type { PlanEdge, PlanNode, Workspace, WorkflowListResult } from './contract.js'

declare const BUNDLE_VERSION: string
declare const UI_STYLES: string

export const version = BUNDLE_VERSION
export { contributions }

const ENTRIES = [
  { value: 'sr', label: 'sr · 完整流程', needsRequirement: true },
  { value: 'dev', label: 'dev · 个人轻量', needsRequirement: false },
  { value: 'ar', label: 'ar · AR 快速通道', needsRequirement: false },
] as const

interface CanvasStep { name: string; prompt: string; confirm: boolean }
interface CustomWorkflow { id: string; title: string; steps: CanvasStep[] }

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
      // workspace management
      showWorkspaceForm: false,
      wsForm: { path: '', interpreter: 'python', script: '' },
      wsError: '',
      // start workflow
      showStart: false,
      startError: '',
      startForm: { entry: 'dev', sr: '', requirement: '', ar: '', title: '' },
      customWorkflows: [] as CustomWorkflow[],
      // canvas state
      canvasId: '',
      canvasTitle: '',
      canvasSteps: [] as CanvasStep[],
      canvasSelected: -1,
      canvasMsg: '',
      canvasError: '',
      nodePos: {} as Record<string, { x: number; y: number }>,
      refreshTimer: null as ReturnType<typeof setInterval> | null,
      stateLabel,
    }
  },
  computed: {
    baseEntries(): typeof ENTRIES {
      return ENTRIES
    },
    entries(): Array<{ value: string; label: string; needsRequirement: boolean }> {
      return [
        ...ENTRIES.map((item) => ({ ...item })),
        ...this.customWorkflows.map((item) => ({ value: item.id, label: `自定义 · ${item.title}`, needsRequirement: false })),
      ]
    },
    currentEntry(): { value: string; label: string; needsRequirement: boolean } {
      return this.entries.find((item) => item.value === this.startForm.entry) ?? this.entries[0]!
    },
    canvasNodes() {
      return this.canvasSteps.map((step, index) => {
        const id = `s${index}`
        const position = this.nodePos[id] ?? { x: 40 + index * 300, y: 180 }
        return {
          id,
          type: 'aaw-step',
          position,
          draggable: true,
          data: {
            stepId: index + 1,
            name: step.name || `步骤${index + 1}`,
            stepType: step.confirm ? '含确认门' : '自定义步骤',
            execution: '',
            state: 'pending' as const,
            attempt: 1,
            startedAt: null,
            endedAt: null,
            isTaskDev: false,
            taskDevPhase: null,
            pendingConfirm: false,
          },
        }
      })
    },
    canvasEdges() {
      return this.canvasSteps.slice(0, -1).map((step, index) => ({
        id: `ce${index}`,
        source: `s${index}`,
        target: `s${index + 1}`,
        animated: false,
        label: step.confirm ? '需确认' : undefined,
        style: { stroke: step.confirm ? '#f59e0b' : '#94a3b8' },
      }))
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
        const label = edge.kind === 'foreach' ? 'foreach ×N' : edge.kind === 'choice' ? 'choice' : undefined
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
      this.customWorkflows = workflows
    },
    refreshAll() {
      // select outside the guard: guard() drops re-entrant calls while busy
      return this.guard(async () => {
        await this.reloadWorkspaces()
        await this.loadCustomList().catch(() => {})
      }).then((toSelect) => {
        if (toSelect) return this.selectSr(toSelect)
      })
    },
    /** Loads workspace list + SR list; returns the SR to auto-select, if any. */
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
    // -- workspace management -------------------------------------------------

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
    // -- start workflow ---------------------------------------------------------

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
    // -- canvas -----------------------------------------------------------------

    canvasAdd() {
      const step = { name: `步骤${this.canvasSteps.length + 1}`, prompt: '', confirm: false }
      this.canvasSteps.push(step)
      this.canvasSelected = this.canvasSteps.length - 1
    },
    canvasRemove(index: number) {
      this.canvasSteps.splice(index, 1)
      this.canvasSelected = -1
    },
    canvasMove(index: number, delta: number) {
      const target = index + delta
      if (target < 0 || target >= this.canvasSteps.length) return
      const steps = [...this.canvasSteps]
      const [moved] = steps.splice(index, 1)
      steps.splice(target, 0, moved!)
      this.canvasSteps = steps
      this.canvasSelected = target
    },
    canvasSelect(index: number) {
      this.canvasSelected = index
    },
    canvasNew() {
      this.canvasId = `flow-${Date.now().toString(36).slice(-5)}`
      this.canvasTitle = ''
      this.canvasSteps = [{ name: '步骤1', prompt: '', confirm: false }]
      this.canvasSelected = 0
      this.canvasMsg = ''
      this.canvasError = ''
      this.nodePos = {}
    },
    canvasLoad(id: string) {
      const workflow = this.customWorkflows.find((item) => item.id === id)
      if (!workflow) return
      this.canvasId = workflow.id
      this.canvasTitle = workflow.title
      this.canvasSteps = workflow.steps.map((step) => ({ ...step }))
      this.canvasSelected = -1
      this.canvasMsg = ''
      this.canvasError = ''
      this.nodePos = {}
    },
    canvasSave() {
      this.guard(async () => {
        const { ok, entry } = await this.client!.call<{ ok: true; entry: string }>('workflow.saveCustom', {
          workspaceId: this.workspaceId,
          workflow: { id: this.canvasId.trim(), title: this.canvasTitle.trim(), steps: this.canvasSteps },
        })
        await this.loadCustomList()
        this.canvasMsg = `已保存为自定义工作流「${entry}」，可在“新建工作流”的入口里选择并启动。`
        return ok
      }, 'canvasError')
    },
    onNodeDragStop(params: { node: { id: string; position: { x: number; y: number } } }) {
      this.nodePos[params.node.id] = params.node.position
    },
    onNodeClick(params: { node: { id: string } }) {
      const index = Number(params.node.id.replace('s', ''))
      if (!Number.isNaN(index)) this.canvasSelected = index
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
        <button type="button" class="aaw-primary" :disabled="!workspaceId" @click="showStart = !showStart">新建工作流</button>
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
        <p class="aaw-hint">自定义工作流保存在画布上，启动后切到「监看」跟随进度；执行由 Chrys 驱动（对话中让它执行该 SR 即可）。</p>
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
          <div class="aaw-form" style="border-bottom:none;border-top:1px solid #e2e8f0">
            <b>我的工作流画布</b>
            <label>标识（小写英文，保存后即启动入口名）<input v-model="canvasId" placeholder="release-flow"></label>
            <label>名称<input v-model="canvasTitle" placeholder="发布流程"></label>
            <label>加载已有
              <select @change="canvasLoad($event.target.value)">
                <option value="">选择…</option>
                <option v-for="w in customWorkflows" :key="w.id" :value="w.id">{{ w.title }}（{{ w.id }}）</option>
              </select>
            </label>
            <div class="aaw-form__actions">
              <button type="button" @click="canvasNew">新建</button>
              <button type="button" @click="canvasAdd">＋ 添加步骤</button>
              <button type="button" class="aaw-primary" :disabled="busy || !canvasSteps.length || !canvasId.trim() || !workspaceId" @click="canvasSave">保存到当前工作区</button>
              <span v-if="canvasMsg" style="color:#166534">{{ canvasMsg }}</span>
              <span v-if="canvasError" class="aaw-error">{{ canvasError }}</span>
            </div>
            <p class="aaw-hint">步骤节点可自由拖拽排布；顺序即执行链。每个步骤 = 一条给 Chrys 的执行提示词；打开「确认门」表示该步完成后需用户放行才继续。保存写入仓库 .sdd/.aaw/definitions/，由 AAW 内核加载执行。</p>
          </div>

          <div style="display:flex;flex:1;min-height:0">
            <VueFlow
              v-if="canvasNodes.length"
              class="aaw-canvas"
              :nodes="canvasNodes"
              :edges="canvasEdges"
              :fit-view-on-init="true"
              :nodes-connectable="false"
              :edges-updatable="false"
              @node-click="onNodeClick"
              @node-drag-stop="onNodeDragStop"
            >
              <template #node-aaw-step="p">
                <div class="aaw-node" :class="{ 'is-selected': canvasSelected === p.data.stepId - 1 }" @click.stop="canvasSelect(p.data.stepId - 1)">
                  <Handle type="target" position="left" />
                  <div class="aaw-node__head">{{ p.data.stepId }}. {{ p.data.name }}</div>
                  <div class="aaw-node__chips">
                    <span class="aaw-chip">{{ p.data.stepType }}</span>
                  </div>
                  <Handle type="source" position="right" />
                </div>
              </template>
            </VueFlow>
            <div v-else class="aaw-empty aaw-graph__empty">点击「＋ 添加步骤」开始搭建你的工作流</div>

            <aside v-if="canvasSelected >= 0 && canvasSteps[canvasSelected]" class="aaw-side" style="width:280px">
              <div class="aaw-side__head"><span>步骤 {{ canvasSelected + 1 }}</span></div>
              <label class="aaw-editor__label">名称<input v-model="canvasSteps[canvasSelected].name" maxlength="40"></label>
              <label class="aaw-editor__label">执行提示词（交给 Chrys）<textarea v-model="canvasSteps[canvasSelected].prompt" placeholder="这一步要做什么，写清楚验收标准…"></textarea></label>
              <label v-if="canvasSelected < canvasSteps.length - 1" class="aaw-editor__check">
                <input type="checkbox" v-model="canvasSteps[canvasSelected].confirm"> 完成后需要用户确认才进入下一步
              </label>
              <p v-else class="aaw-hint">最后一步之后没有后续，确认门不生效。</p>
              <div class="aaw-form__actions" style="padding:8px 0">
                <button type="button" :disabled="canvasSelected === 0" @click="canvasMove(canvasSelected, -1)">↑</button>
                <button type="button" :disabled="canvasSelected === canvasSteps.length - 1" @click="canvasMove(canvasSelected, 1)">↓</button>
                <button type="button" @click="canvasRemove(canvasSelected)">删除步骤</button>
              </div>
            </aside>
          </div>

          <footer class="aaw-legend">
            <span>拖拽节点自由排布 · 顺序即执行链</span><span>保存 = 写入仓库 .sdd/.aaw/definitions/，内核直接可执行</span>
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
  return () => {
    app.unmount()
    host.remove()
  }
}

/** Cordis UI plugin: registers the slot contributions with the shell. */
export default function aawUi(_context: unknown, config: { register(value: unknown): () => void }) {
  return contributions.map(config.register)
}
