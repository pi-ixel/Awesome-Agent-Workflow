//! Definition-driven workflow scheduling, independent of any business workflow.
use crate::Action;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    ops::{Deref, DerefMut},
    sync::Arc,
};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Definition {
    pub id: String,
    pub name: String,
    pub entry: String,
    #[serde(default)]
    pub initial_vars: BTreeMap<String, Value>,
    #[serde(default)]
    pub flows: BTreeMap<String, Subflow>,
    pub nodes: BTreeMap<String, Node>,
    pub phases: BTreeMap<String, Phase>,
    /// Ordered presentation stages (ADR 025 §2). Display-only: never consulted
    /// for scheduling, routing or recovery.
    #[serde(default)]
    pub stages: Vec<Stage>,
    /// 源码内容哈希（编译器写入）；内联定义为空。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub revision: String,
    /// 来源：工作流 id、版本、起点（编译器按起点写入，运行记录据此显示）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Stage {
    pub id: String,
    pub label: String,
}
/// All instances of one run share its immutable definition in memory. The
/// root stores it once in the checkpoint; child references are restored on load.
#[derive(Debug, Clone, Default)]
pub struct SharedDefinition {
    inner: Arc<Definition>,
    embedded: bool,
}
impl SharedDefinition {
    fn new(definition: Definition) -> Self {
        Self {
            inner: Arc::new(definition),
            embedded: false,
        }
    }
    fn is_embedded(&self) -> bool {
        self.embedded
    }
}
impl Deref for SharedDefinition {
    type Target = Definition;
    fn deref(&self) -> &Definition {
        &self.inner
    }
}
impl DerefMut for SharedDefinition {
    fn deref_mut(&mut self) -> &mut Definition {
        Arc::make_mut(&mut self.inner)
    }
}
impl Serialize for SharedDefinition {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.inner.as_ref().serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for SharedDefinition {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Definition::deserialize(deserializer).map(Self::new)
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subflow {
    pub label: String,
    pub entry: String,
    /// Explicit values returned to the caller when this flow completes.
    #[serde(default)]
    pub outputs: BTreeMap<String, Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub kind: String,
    #[serde(default)]
    pub actor: String,
    /// A compositional node invokes a flow; it is not an Agent or script executor.
    #[serde(default)]
    pub call: Option<String>,
    #[serde(default)]
    pub call_entry: Option<String>,
    #[serde(default)]
    pub inputs: Option<Value>,
    #[serde(default)]
    pub scope: BTreeMap<String, Value>,
    /// Values identifying the logical iteration sharing this actor session.
    #[serde(default)]
    pub session_scope: Vec<String>,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub knowledge: String,
    #[serde(default)]
    pub knowledge_files: Vec<String>,
    #[serde(default)]
    pub schema: Option<Value>,
    #[serde(default)]
    pub script: Option<String>,
    #[serde(default)]
    pub script_sha256: Option<String>,
    /// The definition author asserts repeat execution has no side effects.
    #[serde(default)]
    pub safe_to_retry: bool,
    #[serde(default)]
    pub args: Vec<Value>,
    #[serde(default)]
    pub ui: Value,
    #[serde(default)]
    pub requires: Vec<Requirement>,
    /// 回退并丢弃成果时要删除的文件（表达式，可引用本次结果 `result.*`）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cleanup: Vec<Value>,
    /// 节点的作用撤不回时写明原因；回退预览据此提醒。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub irreversible: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Requirement {
    pub condition: Value,
    pub message: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Phase {
    #[serde(default)]
    pub flow: String,
    /// Presentation stage this phase belongs to (references `Definition::stages`).
    #[serde(default)]
    pub stage: Option<String>,
    #[serde(default)]
    pub call: Option<String>,
    #[serde(default)]
    pub call_entry: Option<String>,
    /// Object-valued expression evaluated in the caller's context.
    #[serde(default)]
    pub inputs: Option<Value>,
    /// Instantiate the called flow once per item, with a bounded number in flight.
    #[serde(default)]
    pub foreach: Option<Foreach>,
    /// Optional business-defined labels for a subflow instance.
    #[serde(default)]
    pub scope: BTreeMap<String, Value>,
    #[serde(default)]
    pub run: Vec<String>,
    /// Edges within this phase are prerequisites; nodes without incoming edges
    /// may start together and a node waits for every incoming predecessor.
    #[serde(default)]
    pub edges: Vec<Dependency>,
    pub routes: Vec<Route>,
    #[serde(default)]
    pub max_visits: Option<u32>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Dependency {
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub when: Option<Value>,
    /// An inactive incoming branch can be ignored at an explicit merge.
    #[serde(default)]
    pub optional: bool,
    #[serde(default)]
    pub label: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Foreach {
    pub items: Value,
    pub max_concurrency: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    #[serde(default)]
    pub when: Option<Value>,
    #[serde(default)]
    pub set: BTreeMap<String, Value>,
    pub next: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    /// 走这条去向前要用户确认：`must` 每次都停，`ask` 在运行开了自动放行时直接通过（ADR 031）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm: Option<String>,
}
/// 停在确认关卡上的去向。批准后由该实例下一次调度执行。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Gate {
    pub phase: String,
    pub route: usize,
    pub next: String,
    #[serde(default)]
    pub label: Option<String>,
    pub confirm: String,
    #[serde(default)]
    pub approved: bool,
}

fn uses_previous(value: &Value) -> bool {
    match value {
        Value::Object(fields) if fields.contains_key("literal") => false,
        Value::Object(fields) => {
            fields
                .get("path")
                .and_then(Value::as_str)
                .is_some_and(|path| path == "/previous" || path.starts_with("/previous/"))
                || fields.values().any(uses_previous)
        }
        Value::Array(values) => values.iter().any(uses_previous),
        _ => false,
    }
}

impl Definition {
    pub fn phase_flow(&self, phase: &Phase) -> String {
        if phase.flow.is_empty() {
            "root".into()
        } else {
            phase.flow.clone()
        }
    }
    /// The catalog is derived exclusively from executable phases, calls and routes.
    /// 给界面比对用的版本标识：编译产物用内容哈希，内联定义用固定值。
    pub fn revision_label(&self) -> String {
        if self.revision.is_empty() { "inline".into() } else { self.revision.clone() }
    }
    pub fn reachable_phases(&self) -> BTreeSet<String> {
        let mut reachable = BTreeSet::new();
        let mut pending = vec![self.entry.clone()];
        while let Some(id) = pending.pop() {
            if !reachable.insert(id.clone()) {
                continue;
            }
            if let Some(phase) = self.phases.get(&id) {
                for route in &phase.routes {
                    if self.phases.contains_key(&route.next) {
                        pending.push(route.next.clone());
                    }
                }
                if let Some(call) = &phase.call {
                    if let Some(flow) = self.flows.get(call) {
                        pending.push(
                            phase
                                .call_entry
                                .clone()
                                .unwrap_or_else(|| flow.entry.clone()),
                        );
                    }
                }
                for node in phase.run.iter().filter_map(|id| self.nodes.get(id)) {
                    if let Some(flow) = node.call.as_ref().and_then(|id| self.flows.get(id)) {
                        pending.push(
                            node.call_entry
                                .clone()
                                .unwrap_or_else(|| flow.entry.clone()),
                        );
                    }
                }
            }
        }
        reachable
    }
    pub fn has_reachable_kind(&self, kind: &str) -> bool {
        self.reachable_phases().iter().filter_map(|id| self.phases.get(id))
            .flat_map(|phase| phase.run.iter())
            .filter_map(|id| self.nodes.get(id))
            .any(|node| node.kind == kind)
    }
    pub fn catalog(&self) -> Value {
        let reachable = self.reachable_phases();
        let visible_nodes: BTreeSet<&str> = reachable
            .iter()
            .filter_map(|id| self.phases.get(id))
            .flat_map(|p| p.run.iter().map(String::as_str))
            .collect();
        let nodes: Vec<Value> = self
            .nodes
            .iter()
            .filter(|(id, _)| visible_nodes.contains(id.as_str()))
            .map(|(id, node)| {
                let mut ui = node.ui.as_object().cloned().unwrap_or_default();
                ui.insert("id".into(), json!(id));
                ui.insert("kind".into(), json!(node.kind));
                if node.kind == "flow" {
                    ui.insert("call".into(), json!(node.call));
                    ui.insert("callEntry".into(), json!(node.call_entry));
                }
                ui.entry("label").or_insert_with(|| {
                    json!(if node.actor.is_empty() {
                        id.as_str()
                    } else {
                        node.actor.as_str()
                    })
                });
                ui.entry("steps").or_insert_with(|| json!([]));
                Value::Object(ui)
            })
            .collect();
        let mut flows: BTreeMap<String, Value> = BTreeMap::new();
        for id in &reachable {
            let Some(phase) = self.phases.get(id) else {
                continue;
            };
            let flow_id = self.phase_flow(phase);
            let metadata = self.flows.get(&flow_id);
            let flow = flows.entry(flow_id.clone()).or_insert_with(|| json!({"id":flow_id,"label":metadata.map(|f|f.label.as_str()).unwrap_or(&self.name),"entry":metadata.map(|f|f.entry.as_str()).unwrap_or(&self.entry),"phases":[]}));
            flow["phases"].as_array_mut().expect("array").push(json!({"id":id,"stage":phase.stage,"run":phase.run,"edges":phase.edges,"call":phase.call,"callEntry":phase.call_entry,"foreach":phase.foreach,"routes":phase.routes.iter().enumerate().map(|(i,r)|json!({"next":r.next,"label":r.label,"conditional":r.when.is_some(),"fallback":i>0 && r.when.is_none()})).collect::<Vec<_>>() }));
        }
        let root_flow = self
            .phases
            .get(&self.entry)
            .map(|p| self.phase_flow(p))
            .unwrap_or_else(|| "root".into());
        json!({"id":self.id,"name":self.name,"entry":self.entry,"revision":self.revision_label(),"stages":self.stages,"nodes":nodes,"structure":{"rootFlow":root_flow,"flows":flows}})
    }
    pub fn validate(&self) -> Result<(), String> {
        if self.id.is_empty() || !self.phases.contains_key(&self.entry) {
            return Err("INVALID_WORKFLOW_ENTRY".into());
        }
        let mut stage_ids = BTreeSet::new();
        for stage in &self.stages {
            if stage.id.trim().is_empty()
                || stage.label.trim().is_empty()
                || !stage_ids.insert(stage.id.as_str())
            {
                return Err(format!("INVALID_STAGE:{}", stage.id));
            }
        }
        for (id, phase) in &self.phases {
            if phase
                .stage
                .as_deref()
                .is_some_and(|stage| !stage_ids.contains(stage))
            {
                return Err(format!("INVALID_PHASE_STAGE:{id}"));
            }
        }
        for (id, flow) in &self.flows {
            if id.is_empty()
                || flow.label.trim().is_empty()
                || flow
                    .outputs
                    .keys()
                    .any(|key| key.is_empty() || key.contains('/'))
                || self
                    .phases
                    .get(&flow.entry)
                    .is_none_or(|p| self.phase_flow(p) != *id)
            {
                return Err(format!("INVALID_SUBFLOW:{id}"));
            }
        }
        for (id, node) in &self.nodes {
            if id.is_empty()
                || (node.kind != "flow" && node.actor.trim().is_empty())
                || !["agent", "python", "flow"].contains(&node.kind.as_str())
            {
                return Err(format!("INVALID_NODE:{id}"));
            }
            if node.kind == "agent" && node.prompt.trim().is_empty() {
                return Err(format!("MISSING_NODE_PROMPT:{id}"));
            }
            if node
                .session_scope
                .iter()
                .any(|path| !path.starts_with("/vars/") || path.len() <= 6)
            {
                return Err(format!("INVALID_SESSION_SCOPE:{id}"));
            }
            if node.kind == "python" && node.script.as_deref().is_none_or(str::is_empty) {
                return Err(format!("MISSING_NODE_SCRIPT:{id}"));
            }
            if node.kind == "flow" {
                let flow = node
                    .call
                    .as_ref()
                    .and_then(|id| self.flows.get(id))
                    .ok_or_else(|| format!("INVALID_NODE_CALL:{id}"))?;
                let entry = node.call_entry.as_ref().unwrap_or(&flow.entry);
                if self
                    .phases
                    .get(entry)
                    .is_none_or(|p| self.phase_flow(p) != *node.call.as_ref().expect("flow id"))
                {
                    return Err(format!("INVALID_NODE_CALL_ENTRY:{id}"));
                }
            } else if node.call.is_some()
                || node.call_entry.is_some()
                || node.inputs.is_some()
                || !node.scope.is_empty()
            {
                return Err(format!("INVALID_NODE_CALL:{id}"));
            }
            if node.kind != "python" && node.safe_to_retry {
                return Err(format!("INVALID_RETRY_POLICY:{id}"));
            }
            if node.schema.as_ref().is_some_and(|schema| {
                schema["type"] != "object" || !crate::result_channel::validate_schema(schema)
            }) {
                return Err(format!("INVALID_NODE_SCHEMA:{id}"));
            }
            if node
                .requires
                .iter()
                .any(|requirement| requirement.message.trim().is_empty())
            {
                return Err(format!("INVALID_NODE_REQUIREMENT:{id}"));
            }
        }
        let mut actor_schemas: BTreeMap<(String, String), (Value, Vec<String>)> = BTreeMap::new();
        for (id, phase) in &self.phases {
            let unique: BTreeSet<_> = phase.run.iter().collect();
            let flow_id = self.phase_flow(phase);
            if (!self.flows.is_empty() && !self.flows.contains_key(&flow_id))
                || (phase.call.is_some() == !phase.run.is_empty())
                || unique.len() != phase.run.len()
                || phase.routes.is_empty()
                || phase.max_visits == Some(0)
                || phase.run.iter().any(|n| !self.nodes.contains_key(n))
            {
                return Err(format!("INVALID_PHASE:{id}"));
            }
            let mut dependencies = BTreeSet::new();
            for edge in &phase.edges {
                if !unique.contains(&edge.from)
                    || !unique.contains(&edge.to)
                    || edge.from == edge.to
                    || !dependencies.insert((&edge.from, &edge.to))
                {
                    return Err(format!("INVALID_DEPENDENCY:{id}"));
                }
            }
            let mut resolved = BTreeSet::new();
            loop {
                let before = resolved.len();
                for node in &phase.run {
                    if phase
                        .edges
                        .iter()
                        .filter(|e| e.to == *node)
                        .all(|e| resolved.contains(&e.from))
                    {
                        resolved.insert(node.clone());
                    }
                }
                if before == resolved.len() {
                    break;
                }
            }
            if resolved.len() != phase.run.len() {
                return Err(format!("CYCLIC_DEPENDENCY:{id}"));
            }
            if let Some(call) = &phase.call {
                let target = self
                    .flows
                    .get(call)
                    .ok_or_else(|| format!("INVALID_CALL:{id}"))?;
                let entry = phase.call_entry.as_ref().unwrap_or(&target.entry);
                if call == &flow_id
                    || self
                        .phases
                        .get(entry)
                        .is_none_or(|p| self.phase_flow(p) != *call)
                {
                    return Err(format!("INVALID_CALL_ENTRY:{id}"));
                }
            } else if phase.call_entry.is_some()
                || phase.inputs.is_some()
                || phase.foreach.is_some()
            {
                return Err(format!("INVALID_CALL_ENTRY:{id}"));
            }
            if phase
                .foreach
                .as_ref()
                .is_some_and(|each| each.max_concurrency == 0)
            {
                return Err(format!("INVALID_FOREACH_CONCURRENCY:{id}"));
            }
            if phase
                .foreach
                .as_ref()
                .is_some_and(|each| each.max_concurrency > 1)
                && (phase.inputs.as_ref().is_some_and(uses_previous)
                    || phase.scope.values().any(uses_previous))
            {
                return Err(format!("PREVIOUS_REQUIRES_SEQUENTIAL_FOREACH:{id}"));
            }
            let agents: Vec<_> = phase
                .run
                .iter()
                .map(|n| &self.nodes[n])
                .filter(|node| node.kind == "agent")
                .collect();
            let actors: BTreeSet<_> = agents.iter().map(|node| &node.actor).collect();
            if actors.len() != agents.len() {
                return Err(format!("PARALLEL_ACTOR_CONFLICT:{id}"));
            }
            for node_id in &phase.run {
                let node = &self.nodes[node_id];
                if node.kind != "agent" {
                    continue;
                }
                let schema = node.schema.clone().unwrap_or_else(
                    || json!({"type":"object","properties":{},"additionalProperties":true}),
                );
                let contract = (schema, node.session_scope.clone());
                if let Some(previous) =
                    actor_schemas.insert((flow_id.clone(), node.actor.clone()), contract.clone())
                {
                    if previous != contract {
                        return Err(format!("ACTOR_SCHEMA_CONFLICT:{node_id}"));
                    }
                }
            }
            for (index, route) in phase.routes.iter().enumerate() {
                if route.when.is_none() && index + 1 < phase.routes.len() {
                    return Err(format!("UNREACHABLE_ROUTE:{id}"));
                }
                if !["$complete", "$blocked", "$return"].contains(&route.next.as_str())
                    && !self.phases.contains_key(&route.next)
                {
                    return Err(format!("INVALID_ROUTE:{id}"));
                }
                if route
                    .confirm
                    .as_deref()
                    .is_some_and(|c| c != "must" && c != "ask")
                {
                    return Err(format!("INVALID_ROUTE_CONFIRM:{id}"));
                }
                if self
                    .phases
                    .get(&route.next)
                    .is_some_and(|p| self.phase_flow(p) != flow_id)
                {
                    return Err(format!("CROSS_FLOW_ROUTE:{id}"));
                }
                for key in route.set.keys() {
                    if key.is_empty() || key.contains('/') {
                        return Err(format!("INVALID_VARIABLE:{id}"));
                    }
                }
            }
        }
        fn visit(
            def: &Definition,
            id: &str,
            active: &mut BTreeSet<String>,
            done: &mut BTreeSet<String>,
        ) -> Result<(), String> {
            if done.contains(id) {
                return Ok(());
            }
            if !active.insert(id.into()) {
                return Err("RECURSIVE_SUBFLOW".into());
            }
            for phase in def.phases.values().filter(|p| def.phase_flow(p) == id) {
                if let Some(child) = &phase.call {
                    visit(def, child, active, done)?;
                }
                for child in phase
                    .run
                    .iter()
                    .filter_map(|node| def.nodes.get(node))
                    .filter(|node| node.kind == "flow")
                    .filter_map(|node| node.call.as_ref())
                {
                    visit(def, child, active, done)?;
                }
            }
            active.remove(id);
            done.insert(id.into());
            Ok(())
        }
        let mut done = BTreeSet::new();
        for id in self.flows.keys() {
            visit(self, id, &mut BTreeSet::new(), &mut done)?;
        }
        let root_flow = self.phase_flow(&self.phases[&self.entry]);
        let called: BTreeSet<&str> = self
            .phases
            .values()
            .filter_map(|p| p.call.as_deref())
            .chain(self.nodes.values().filter_map(|node| node.call.as_deref()))
            .collect();
        for (id, phase) in &self.phases {
            let flow = self.phase_flow(phase);
            for route in &phase.routes {
                if (route.next == "$return" && flow == root_flow)
                    || (route.next == "$complete" && called.contains(flow.as_str()))
                {
                    return Err(format!("INVALID_FLOW_EXIT:{id}"));
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    #[serde(default, skip_serializing_if = "SharedDefinition::is_embedded")]
    pub definition: SharedDefinition,
    pub phase: String,
    pub vars: Map<String, Value>,
    pub latest: BTreeMap<String, Value>,
    pub batch: BTreeMap<String, Value>,
    /// The current phase has already issued its actions and is awaiting results.
    pub phase_active: bool,
    pub phase_nodes: BTreeMap<String, String>,
    pub phase_edges: BTreeMap<String, bool>,
    pub phase_contexts: BTreeMap<String, Value>,
    pub phase_calls: BTreeMap<String, Box<Run>>,
    pub phase_pending: BTreeMap<String, String>,
    pub visits: BTreeMap<String, u32>,
    #[serde(default)]
    pub local_visits: BTreeMap<String, u32>,
    pub terminal: Option<String>,
    pub terminal_reason: Option<String>,
    #[serde(default)]
    pub stack: Vec<CallFrame>,
    #[serde(default)]
    pub calls: Vec<CallRecord>,
    pub skipped: Vec<SkippedRecord>,
    /// Set for an independently executing member of a dynamic call group.
    pub root_flow: Option<String>,
    pub prefix: Vec<String>,
    pub inherited_scope: Map<String, Value>,
    pub return_value: Option<Value>,
    pub group: Option<Box<CallGroup>>,
    /// 本次调度中进入步骤时的状态（检查点，ADR 031）；调度后由所有者取走落库。
    #[serde(skip)]
    pub entered: Vec<Run>,
    /// 停在确认关卡时的去向。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gate: Option<Gate>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedRecord {
    pub site: String,
    pub ordinal: u32,
    pub phase: String,
    pub actor: String,
    pub scope: Value,
    pub call_path: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallGroup {
    pub phase: String,
    pub limit: usize,
    pub children: Vec<CallChild>,
    /// Each dispatched action is routed back to its own child instance.
    pub pending: BTreeMap<String, usize>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallChild {
    pub instance_id: String,
    pub item: Value,
    pub index: usize,
    pub started: bool,
    pub run: Box<Run>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallFrame {
    pub phase: String,
    pub flow: String,
    pub instance_id: String,
    pub parent_vars: Map<String, Value>,
    pub parent_latest: BTreeMap<String, Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallRecord {
    pub id: String,
    pub phase: String,
    pub flow: String,
    pub ordinal: u32,
    pub parent: Option<String>,
    pub scope: Value,
    pub input: Value,
    pub output: Option<Value>,
    pub status: String,
}
pub fn deserialize_root<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Run, D::Error> {
    let mut run = Run::deserialize(deserializer)?;
    if run.definition.id.is_empty() {
        return Err(serde::de::Error::custom("workflow definition missing"));
    }
    let definition = run.definition.clone();
    run.restore_child_definitions(&definition);
    Ok(run)
}
impl Run {
    fn restore_child_definitions(&mut self, definition: &SharedDefinition) {
        for child in self.phase_calls.values_mut() {
            child.definition = definition.clone();
            child.definition.embedded = true;
            child.restore_child_definitions(definition);
        }
        if let Some(group) = &mut self.group {
            for child in &mut group.children {
                child.run.definition = definition.clone();
                child.run.definition.embedded = true;
                child.run.restore_child_definitions(definition);
            }
        }
    }
    pub fn new(definition: Definition, input: Value) -> Result<Self, String> {
        definition.validate()?;
        let mut vars: Map<String, Value> = definition.initial_vars.clone().into_iter().collect();
        vars.insert("input".into(), input);
        Ok(Self {
            phase: definition.entry.clone(),
            definition: SharedDefinition::new(definition),
            vars,
            latest: BTreeMap::new(),
            batch: BTreeMap::new(),
            phase_active: false,
            phase_nodes: BTreeMap::new(),
            phase_edges: BTreeMap::new(),
            phase_contexts: BTreeMap::new(),
            phase_calls: BTreeMap::new(),
            phase_pending: BTreeMap::new(),
            visits: BTreeMap::new(),
            local_visits: BTreeMap::new(),
            terminal: None,
            terminal_reason: None,
            stack: vec![],
            calls: vec![],
            skipped: vec![],
            root_flow: None,
            prefix: vec![],
            inherited_scope: Map::new(),
            return_value: None,
            group: None,
            entered: vec![],
            gate: None,
        })
    }
    pub fn call_path(&self) -> Vec<String> {
        self.prefix
            .iter()
            .cloned()
            .chain(self.stack.iter().map(|f| f.instance_id.clone()))
            .collect()
    }
    fn current_scope(&self) -> Map<String, Value> {
        let mut scope = self.inherited_scope.clone();
        for frame in &self.stack {
            if let Some(values) = self
                .calls
                .iter()
                .find(|r| r.id == frame.instance_id)
                .and_then(|r| r.scope.as_object())
            {
                scope.extend(values.clone());
            }
        }
        scope
    }
    /// Runtime projection includes instances created at every nesting level.
    pub fn all_calls(&self) -> Vec<CallRecord> {
        let mut calls = self.calls.clone();
        for child in self.phase_calls.values() {
            calls.extend(child.all_calls());
        }
        if let Some(group) = &self.group {
            for child in &group.children {
                calls.extend(child.run.all_calls());
            }
        }
        calls
    }
    pub fn all_skipped(&self) -> Vec<SkippedRecord> {
        let mut skipped = self.skipped.clone();
        for child in self.phase_calls.values() {
            skipped.extend(child.all_skipped());
        }
        if let Some(group) = &self.group {
            for child in &group.children {
                skipped.extend(child.run.all_skipped());
            }
        }
        skipped
    }
    fn flow_output(&self, flow_id: &str) -> Result<Value, String> {
        let flow = self
            .definition
            .flows
            .get(flow_id)
            .ok_or("UNKNOWN_SUBFLOW")?;
        let context = json!({"vars":self.vars,"latest":self.latest,"batch":self.batch});
        let output = flow
            .outputs
            .iter()
            .map(|(key, expr)| Ok((key.clone(), evaluate(expr, &context)?)))
            .collect::<Result<Map<String, Value>, String>>()?;
        Ok(Value::Object(output))
    }
    fn node_call_site(phase: &str, node: &str) -> String {
        serde_json::to_string(&["node", phase, node]).expect("string array serializes")
    }
    fn edge_key(from: &str, to: &str) -> String {
        serde_json::to_string(&[from, to]).expect("string array serializes")
    }
    fn save_phase_context(&mut self, id: &str) {
        self.phase_contexts.insert(
            id.into(),
            json!({"vars":self.vars,"latest":self.latest,"batch":self.batch}),
        );
    }
    /// Resolve each edge against the snapshot recorded when its source finished.
    fn resolve_skips(
        &mut self,
        phase: &Phase,
        ordinals: &mut BTreeMap<String, u32>,
    ) -> Result<(), String> {
        loop {
            for edge in &phase.edges {
                let key = Self::edge_key(&edge.from, &edge.to);
                if self.phase_edges.contains_key(&key) {
                    continue;
                }
                match self.phase_nodes.get(&edge.from).map(String::as_str) {
                    Some("completed") => {
                        let context = self
                            .phase_contexts
                            .get(&edge.from)
                            .ok_or("MISSING_PHASE_CONTEXT")?;
                        let active = match &edge.when {
                            Some(expr) => evaluate(expr, context)?
                                .as_bool()
                                .ok_or("CONDITION_NOT_BOOLEAN")?,
                            None => true,
                        };
                        self.phase_edges.insert(key, active);
                    }
                    Some("skipped") => {
                        self.phase_edges.insert(key, false);
                    }
                    _ => {}
                }
            }
            let mut newly_skipped = Vec::new();
            for id in &phase.run {
                if self
                    .phase_nodes
                    .get(id)
                    .is_none_or(|state| state != "pending")
                {
                    continue;
                }
                let incoming = phase
                    .edges
                    .iter()
                    .filter(|edge| edge.to == *id)
                    .collect::<Vec<_>>();
                if incoming.is_empty()
                    || incoming.iter().any(|edge| {
                        !self
                            .phase_edges
                            .contains_key(&Self::edge_key(&edge.from, &edge.to))
                    })
                {
                    continue;
                }
                let any_active = incoming
                    .iter()
                    .any(|edge| self.phase_edges[&Self::edge_key(&edge.from, &edge.to)]);
                let mandatory_missing = incoming.iter().any(|edge| {
                    !edge.optional && !self.phase_edges[&Self::edge_key(&edge.from, &edge.to)]
                });
                if !any_active || mandatory_missing {
                    newly_skipped.push(id.clone());
                }
            }
            if newly_skipped.is_empty() {
                return Ok(());
            }
            for id in newly_skipped {
                let ordinal = ordinals.entry(id.clone()).or_default();
                *ordinal = ordinal.checked_add(1).ok_or("VISIT_COUNTER_OVERFLOW")?;
                let actor = self
                    .definition
                    .nodes
                    .get(&id)
                    .map(|node| {
                        if node.actor.is_empty() {
                            id.clone()
                        } else {
                            node.actor.clone()
                        }
                    })
                    .ok_or("UNKNOWN_NODE")?;
                self.skipped.push(SkippedRecord {
                    site: id.clone(),
                    ordinal: *ordinal,
                    phase: self.phase.clone(),
                    actor,
                    scope: Value::Object(self.current_scope()),
                    call_path: self.call_path(),
                });
                // A skipped execution cannot expose an earlier iteration's
                // output as if it belonged to the current branch.
                self.latest.remove(&id);
                self.phase_nodes.insert(id, "skipped".into());
            }
        }
    }
    fn start_phase_call(
        &mut self,
        id: &str,
        ordinals: &mut BTreeMap<String, u32>,
    ) -> Result<(), String> {
        let node = self.definition.nodes.get(id).ok_or("UNKNOWN_NODE")?.clone();
        let flow_id = node.call.as_ref().ok_or("MISSING_SUBFLOW")?;
        let target = self
            .definition
            .flows
            .get(flow_id)
            .ok_or("UNKNOWN_SUBFLOW")?;
        let context = json!({"vars":self.vars,"latest":self.latest,"batch":self.batch});
        let input = match &node.inputs {
            Some(expr) => evaluate(expr, &context)?,
            None => json!({}),
        };
        let vars = input
            .as_object()
            .cloned()
            .ok_or("SUBFLOW_INPUT_MUST_BE_OBJECT")?;
        let scope = node
            .scope
            .iter()
            .map(|(key, expr)| Ok((key.clone(), evaluate(expr, &context)?)))
            .collect::<Result<Map<String, Value>, String>>()?;
        let path = self.call_path();
        let site = Self::node_call_site(&self.phase, id);
        let count = ordinals.entry(id.into()).or_default();
        *count = count.checked_add(1).ok_or("VISIT_COUNTER_OVERFLOW")?;
        let ordinal = *count;
        let short_id = format!("{site}@{ordinal}");
        let instance_id = path
            .last()
            .map_or_else(|| short_id.clone(), |parent| format!("{parent}/{short_id}"));
        self.calls.push(CallRecord {
            id: instance_id.clone(),
            phase: site,
            flow: flow_id.clone(),
            ordinal,
            parent: path.last().cloned(),
            scope: Value::Object(scope.clone()),
            input,
            output: None,
            status: "running".into(),
        });
        let mut child_path = path;
        child_path.push(instance_id);
        let mut inherited = self.current_scope();
        inherited.extend(scope);
        let mut definition = self.definition.clone();
        definition.embedded = true;
        let child = Run {
            definition,
            phase: node.call_entry.unwrap_or_else(|| target.entry.clone()),
            vars,
            latest: BTreeMap::new(),
            batch: BTreeMap::new(),
            phase_active: false,
            phase_nodes: BTreeMap::new(),
            phase_edges: BTreeMap::new(),
            phase_contexts: BTreeMap::new(),
            phase_calls: BTreeMap::new(),
            phase_pending: BTreeMap::new(),
            visits: BTreeMap::new(),
            local_visits: BTreeMap::new(),
            terminal: None,
            terminal_reason: None,
            stack: vec![],
            calls: vec![],
            skipped: vec![],
            root_flow: Some(flow_id.clone()),
            prefix: child_path,
            inherited_scope: inherited,
            return_value: None,
            group: None,
            entered: vec![],
            gate: None,
        };
        self.phase_calls.insert(id.into(), Box::new(child));
        self.phase_nodes.insert(id.into(), "running".into());
        Ok(())
    }
    fn update_phase_call(&mut self, id: &str, child: &Run) -> Result<(), String> {
        let instance_id = child.prefix.last().ok_or("SUBFLOW_INSTANCE_MISSING")?;
        if child.terminal.as_deref() == Some("completed") {
            let value = child.return_value.clone().ok_or("SUBFLOW_OUTPUT_MISSING")?;
            let record = self
                .calls
                .iter_mut()
                .find(|r| r.id == *instance_id)
                .ok_or("SUBFLOW_INSTANCE_MISSING")?;
            record.status = "completed".into();
            record.output = Some(value.clone());
            self.latest.insert(id.into(), value.clone());
            self.batch.insert(id.into(), value);
            self.phase_nodes.insert(id.into(), "completed".into());
            self.save_phase_context(id);
        } else if child.terminal.as_deref() == Some("blocked") {
            self.calls
                .iter_mut()
                .find(|r| r.id == *instance_id)
                .ok_or("SUBFLOW_INSTANCE_MISSING")?
                .status = "failed".into();
            self.terminal = Some("blocked".into());
            self.terminal_reason = child.terminal_reason.clone();
        }
        Ok(())
    }
    /// Return as soon as one child releases work, so no undispatched sibling
    /// can be mistaken for an already issued action on a later preflight error.
    fn poll_phase_calls(
        &mut self,
        ordinals: &mut BTreeMap<String, u32>,
    ) -> Result<Vec<Action>, String> {
        let ids = self.phase_calls.keys().cloned().collect::<Vec<_>>();
        for id in ids {
            let mut child = self
                .phase_calls
                .remove(&id)
                .ok_or("SUBFLOW_INSTANCE_MISSING")?;
            if child.terminal.is_none() {
                let actions = child.dispatch(ordinals)?;
                self.update_phase_call(&id, &child)?;
                for action in &actions {
                    self.phase_pending
                        .insert(Action::key(&action.site, action.ordinal), id.clone());
                }
                self.phase_calls.insert(id, child);
                if self.terminal.is_some() || !actions.is_empty() {
                    return Ok(actions);
                }
            } else {
                self.phase_calls.insert(id, child);
            }
        }
        Ok(vec![])
    }
    fn start_group(&mut self) -> Result<(), String> {
        let phase = self
            .definition
            .phases
            .get(&self.phase)
            .ok_or("UNKNOWN_PHASE")?
            .clone();
        let each = phase.foreach.as_ref().ok_or("MISSING_FOREACH")?;
        let flow_id = phase.call.as_ref().ok_or("MISSING_SUBFLOW")?;
        let target = self
            .definition
            .flows
            .get(flow_id)
            .ok_or("UNKNOWN_SUBFLOW")?;
        let context = json!({"vars":self.vars,"latest":self.latest});
        let values = evaluate(&each.items, &context)?;
        let items = values.as_array().ok_or("FOREACH_ITEMS_MUST_BE_ARRAY")?;
        let local_key = serde_json::to_string(&(self.call_path().last(), &self.phase))
            .map_err(|_| "INVALID_VISIT_SCOPE")?;
        let local_count = self.local_visits.entry(local_key).or_default();
        if *local_count >= phase.max_visits.unwrap_or(1000) {
            self.terminal = Some("blocked".into());
            self.terminal_reason = Some("子流程调用超过执行次数上限".into());
            return Ok(());
        }
        *local_count += 1;
        let path = self.call_path();
        let inherited = self.current_scope();
        let mut children = Vec::with_capacity(items.len());
        for (index, item) in items.iter().enumerate() {
            let context = json!({"vars":self.vars,"latest":self.latest,"item":item,"index":index});
            let scope = phase
                .scope
                .iter()
                .map(|(key, expr)| {
                    Ok((
                        key.clone(),
                        if uses_previous(expr) {
                            Value::Null
                        } else {
                            evaluate(expr, &context)?
                        },
                    ))
                })
                .collect::<Result<Map<String, Value>, String>>()?;
            let count = self.visits.entry(self.phase.clone()).or_default();
            *count = count.checked_add(1).ok_or("VISIT_COUNTER_OVERFLOW")?;
            let short_id = format!("{}@{}", self.phase, count);
            let id = path
                .last()
                .map_or_else(|| short_id.clone(), |parent| format!("{parent}/{short_id}"));
            self.calls.push(CallRecord {
                id: id.clone(),
                phase: self.phase.clone(),
                flow: flow_id.clone(),
                ordinal: *count,
                parent: path.last().cloned(),
                scope: Value::Object(scope.clone()),
                input: Value::Null,
                output: None,
                status: "pending".into(),
            });
            let mut child_path = path.clone();
            child_path.push(id.clone());
            let mut child_scope = inherited.clone();
            child_scope.extend(scope);
            let mut child_definition = self.definition.clone();
            child_definition.embedded = true;
            let run = Run {
                definition: child_definition,
                phase: phase
                    .call_entry
                    .clone()
                    .unwrap_or_else(|| target.entry.clone()),
                vars: Map::new(),
                latest: BTreeMap::new(),
                batch: BTreeMap::new(),
                phase_active: false,
                phase_nodes: BTreeMap::new(),
                phase_edges: BTreeMap::new(),
                phase_contexts: BTreeMap::new(),
                phase_calls: BTreeMap::new(),
                phase_pending: BTreeMap::new(),
                visits: BTreeMap::new(),
                local_visits: BTreeMap::new(),
                terminal: None,
                terminal_reason: None,
                stack: vec![],
                calls: vec![],
                skipped: vec![],
                root_flow: Some(flow_id.clone()),
                prefix: child_path,
                inherited_scope: child_scope,
                return_value: None,
                group: None,
                entered: vec![],
                gate: None,
            };
            children.push(CallChild {
                instance_id: id,
                item: item.clone(),
                index,
                started: false,
                run: Box::new(run),
            });
        }
        self.group = Some(Box::new(CallGroup {
            phase: self.phase.clone(),
            limit: each.max_concurrency,
            children,
            pending: BTreeMap::new(),
        }));
        Ok(())
    }
    fn finish_group_if_ready(&mut self, group: &CallGroup) -> Result<bool, String> {
        if group
            .children
            .iter()
            .any(|c| c.run.terminal.as_deref() != Some("completed"))
        {
            return Ok(false);
        }
        let results = group
            .children
            .iter()
            .map(|c| json!({"item":c.item,"index":c.index,"output":c.run.return_value}))
            .collect::<Vec<_>>();
        for child in &group.children {
            self.calls.extend(child.run.all_calls());
            self.skipped.extend(child.run.all_skipped());
        }
        self.latest
            .insert(group.phase.clone(), Value::Array(results));
        self.batch.clear();
        self.advance_routes()?;
        Ok(true)
    }
    fn dispatch_group(
        &mut self,
        ordinals: &mut BTreeMap<String, u32>,
    ) -> Result<Vec<Action>, String> {
        let mut group = self.group.take().ok_or("MISSING_CALL_GROUP")?;
        // Dispatch is one transaction: a later child's failed precondition must
        // not leave earlier, never-issued actions appearing to be in flight.
        let before = group.clone();
        let calls_before = self.calls.clone();
        let ordinals_before = ordinals.clone();
        let phase = self
            .definition
            .phases
            .get(&group.phase)
            .ok_or("UNKNOWN_PHASE")?
            .clone();
        let inherited = self.current_scope();
        let mut previous: Vec<Value> = group
            .children
            .iter()
            .map(|child| {
                if child.run.terminal.as_deref() == Some("completed") {
                    json!({"item":child.item,"index":child.index,"output":child.run.return_value})
                } else {
                    Value::Null
                }
            })
            .collect();
        let mut active = group
            .children
            .iter()
            .filter(|c| c.started && c.run.terminal.is_none())
            .count();
        let mut actions = Vec::new();
        for (index, child) in group.children.iter_mut().enumerate() {
            if child.run.terminal.is_some() {
                continue;
            }
            if !child.started {
                if active >= group.limit {
                    continue;
                }
                let prior = index
                    .checked_sub(1)
                    .map(|i| previous[i].clone())
                    .unwrap_or(Value::Null);
                let context = json!({"vars":self.vars,"latest":self.latest,"item":child.item,"index":child.index,"previous":prior});
                let input = match &phase.inputs {
                    Some(expr) => evaluate(expr, &context)?,
                    None => json!({"item":child.item,"index":child.index}),
                };
                child.run.vars = input
                    .as_object()
                    .cloned()
                    .ok_or("SUBFLOW_INPUT_MUST_BE_OBJECT")?;
                let scope = phase
                    .scope
                    .iter()
                    .map(|(key, expr)| Ok((key.clone(), evaluate(expr, &context)?)))
                    .collect::<Result<Map<String, Value>, String>>()?;
                child.run.inherited_scope = inherited.clone();
                child.run.inherited_scope.extend(scope.clone());
                child.started = true;
                active += 1;
                let record = self
                    .calls
                    .iter_mut()
                    .find(|r| r.id == child.instance_id)
                    .ok_or("SUBFLOW_INSTANCE_MISSING")?;
                record.status = "running".into();
                record.scope = Value::Object(scope);
                record.input = input;
            }
            let dispatched = child.run.dispatch(ordinals)?;
            if child.run.terminal.as_deref() == Some("completed") {
                let record = self
                    .calls
                    .iter_mut()
                    .find(|r| r.id == child.instance_id)
                    .ok_or("SUBFLOW_INSTANCE_MISSING")?;
                record.status = "completed".into();
                record.output = child.run.return_value.clone();
                previous[index] =
                    json!({"item":child.item,"index":child.index,"output":child.run.return_value});
                active = active.saturating_sub(1);
            }
            if child.run.terminal.as_deref() == Some("blocked") {
                let failed_run = child.run.clone();
                let reason = child.run.terminal_reason.clone();
                let failed_id = child.instance_id.clone();
                let mut restored = before;
                restored.children[index].run = failed_run;
                restored.children[index].started = true;
                self.calls = calls_before;
                self.calls
                    .iter_mut()
                    .find(|r| r.id == failed_id)
                    .ok_or("SUBFLOW_INSTANCE_MISSING")?
                    .status = "failed".into();
                *ordinals = ordinals_before;
                self.terminal = Some("blocked".into());
                self.terminal_reason = reason;
                self.group = Some(restored);
                return Ok(vec![]);
            }
            for action in dispatched {
                group
                    .pending
                    .insert(Action::key(&action.site, action.ordinal), index);
                actions.push(action);
            }
        }
        if actions.is_empty() && group.pending.is_empty() && self.finish_group_if_ready(&group)? {
            return self.dispatch(ordinals);
        }
        self.group = Some(group);
        Ok(actions)
    }
    pub fn dispatch(
        &mut self,
        ordinals: &mut BTreeMap<String, u32>,
    ) -> Result<Vec<Action>, String> {
        if self.terminal.is_some() {
            return Ok(vec![]);
        }
        if let Some(gate) = &self.gate {
            if !gate.approved {
                return Ok(vec![]);
            }
            let route = gate.route;
            self.gate = None;
            self.follow_routes(Some(route))?;
            if self.terminal.is_some() {
                return Ok(vec![]);
            }
        }
        if self.group.is_some() {
            return self.dispatch_group(ordinals);
        }
        loop {
            let phase = self
                .definition
                .phases
                .get(&self.phase)
                .ok_or("UNKNOWN_PHASE")?;
            let Some(call) = phase.call.as_ref() else {
                break;
            };
            if phase.foreach.is_some() {
                self.capture_entry();
                self.start_group()?;
                if self.terminal.is_some() {
                    return Ok(vec![]);
                }
                return self.dispatch_group(ordinals);
            }
            let target = self.definition.flows.get(call).ok_or("UNKNOWN_SUBFLOW")?;
            if self.stack.len() >= 64 || self.stack.iter().any(|frame| frame.flow == *call) {
                return Err("RECURSIVE_SUBFLOW".into());
            }
            let local_key = serde_json::to_string(&(
                self.stack.last().map(|f| f.instance_id.as_str()),
                &self.phase,
            ))
            .map_err(|_| "INVALID_VISIT_SCOPE")?;
            let local_count = self.local_visits.entry(local_key).or_default();
            if *local_count >= phase.max_visits.unwrap_or(1000) {
                self.terminal = Some("blocked".into());
                self.terminal_reason = Some("子流程调用超过执行次数上限".into());
                return Ok(vec![]);
            }
            *local_count += 1;
            let count = self.visits.entry(self.phase.clone()).or_default();
            *count = count.checked_add(1).ok_or("VISIT_COUNTER_OVERFLOW")?;
            let count = *count;
            let short_id = format!("{}@{}", self.phase, count);
            let path = self.call_path();
            let instance_id = path
                .last()
                .map_or_else(|| short_id.clone(), |parent| format!("{parent}/{short_id}"));
            let context = json!({"vars":self.vars,"latest":self.latest});
            let scope = phase
                .scope
                .iter()
                .map(|(key, expr)| Ok((key.clone(), evaluate(expr, &context)?)))
                .collect::<Result<Map<String, Value>, String>>()?;
            let input = match &phase.inputs {
                Some(expr) => evaluate(expr, &context)?,
                None => json!({}),
            };
            let child_vars = input
                .as_object()
                .cloned()
                .ok_or("SUBFLOW_INPUT_MUST_BE_OBJECT")?;
            self.calls.push(CallRecord {
                id: instance_id.clone(),
                phase: self.phase.clone(),
                flow: call.clone(),
                ordinal: count,
                parent: path.last().cloned(),
                scope: Value::Object(scope),
                input,
                output: None,
                status: "running".into(),
            });
            self.stack.push(CallFrame {
                phase: self.phase.clone(),
                flow: call.clone(),
                instance_id,
                parent_vars: std::mem::replace(&mut self.vars, child_vars),
                parent_latest: std::mem::take(&mut self.latest),
            });
            self.phase = phase
                .call_entry
                .clone()
                .unwrap_or_else(|| target.entry.clone());
        }
        let phase = self
            .definition
            .phases
            .get(&self.phase)
            .ok_or("UNKNOWN_PHASE")?
            .clone();
        if !self.phase_active {
            self.capture_entry();
            let local_key = serde_json::to_string(&(
                self.stack.last().map(|f| f.instance_id.as_str()),
                &self.phase,
            ))
            .map_err(|_| "INVALID_VISIT_SCOPE")?;
            let local_count = self.local_visits.entry(local_key).or_default();
            if *local_count >= phase.max_visits.unwrap_or(1000) {
                self.terminal = Some("blocked".into());
                self.terminal_reason = Some("流程阶段超过执行次数上限".into());
                return Ok(vec![]);
            }
            *local_count += 1;
            let count = self.visits.entry(self.phase.clone()).or_default();
            *count = count.checked_add(1).ok_or("VISIT_COUNTER_OVERFLOW")?;
            self.batch.clear();
            self.phase_edges.clear();
            self.phase_contexts.clear();
            self.phase_nodes = phase
                .run
                .iter()
                .map(|id| (id.clone(), "pending".into()))
                .collect();
            self.phase_active = true;
        }
        let child_actions = self.poll_phase_calls(ordinals)?;
        if self.terminal.is_some() || !child_actions.is_empty() {
            return Ok(child_actions);
        }
        self.resolve_skips(&phase, ordinals)?;
        if self
            .phase_nodes
            .values()
            .all(|state| state == "completed" || state == "skipped")
        {
            self.advance_routes()?;
            return self.dispatch(ordinals);
        }
        let count = *self.visits.get(&self.phase).ok_or("MISSING_PHASE_VISIT")?;
        let ready: Vec<&String> = phase
            .run
            .iter()
            .filter(|id| {
                self.phase_nodes
                    .get(*id)
                    .is_some_and(|status| status == "pending")
                    && phase
                        .edges
                        .iter()
                        .filter(|edge| edge.to == **id)
                        .all(|edge| {
                            self.phase_edges
                                .contains_key(&Self::edge_key(&edge.from, &edge.to))
                        })
            })
            .collect();
        let context = json!({"vars":self.vars,"latest":self.latest});
        for id in &ready {
            for requirement in &self.definition.nodes[*id].requires {
                if evaluate(&requirement.condition, &context)? != true {
                    self.terminal = Some("blocked".into());
                    self.terminal_reason = Some(format!("节点 {id}：{}", requirement.message));
                    return Ok(vec![]);
                }
            }
        }
        if let Some(id) = ready
            .iter()
            .find(|id| self.definition.nodes[**id].kind == "flow")
        {
            self.start_phase_call(id, ordinals)?;
            return self.dispatch(ordinals);
        }
        let mut actions = Vec::new();
        for id in ready {
            let node = self.definition.nodes.get(id).ok_or("UNKNOWN_NODE")?;
            let ordinal = ordinals.entry(id.clone()).or_default();
            *ordinal += 1;
            let scope = node
                .session_scope
                .iter()
                .map(|path| {
                    context
                        .pointer(path)
                        .and_then(Value::as_str)
                        .filter(|s| !s.trim().is_empty())
                        .ok_or("MISSING_SESSION_SCOPE")
                })
                .collect::<Result<Vec<_>, _>>()?;
            let mut actor = if scope.is_empty() {
                node.actor.clone()
            } else {
                format!(
                    "{} · {}",
                    node.actor,
                    serde_json::to_string(&scope).map_err(|_| "INVALID_SESSION_SCOPE")?
                )
            };
            // A logical actor may be reused within an invocation, but two
            // different subflow instances must never share an ACP session.
            let path = self.call_path();
            if !path.is_empty() {
                actor = format!(
                    "{} · {}",
                    actor,
                    serde_json::to_string(&path).map_err(|_| "INVALID_CALL_PATH")?
                );
            }
            let scope = self.current_scope();
            actions.push(Action { site: id.clone(), ordinal: *ordinal, actor, input: json!({"vars":self.vars,"latest":self.latest,"__node":node,"__phase":self.phase,"__scope":scope,"__callPath":path,"__initial":self.prefix.is_empty() && self.phase == self.definition.entry && count == 1}) });
            self.phase_nodes.insert(id.clone(), "running".into());
        }
        Ok(actions)
    }
    pub fn complete(&mut self, site: &str, ordinal: u32, result: Value) -> Result<(), String> {
        if let Some(mut group) = self.group.take() {
            let key = Action::key(site, ordinal);
            let index = *group.pending.get(&key).ok_or("UNEXPECTED_NODE_RESULT")?;
            let child = &mut group.children[index];
            child.run.complete(site, ordinal, result)?;
            group.pending.remove(&key);
            if child.run.terminal.as_deref() == Some("completed") {
                let record = self
                    .calls
                    .iter_mut()
                    .find(|r| r.id == child.instance_id)
                    .ok_or("SUBFLOW_INSTANCE_MISSING")?;
                record.status = "completed".into();
                record.output = child.run.return_value.clone();
            } else if child.run.terminal.as_deref() == Some("blocked") {
                let record = self
                    .calls
                    .iter_mut()
                    .find(|r| r.id == child.instance_id)
                    .ok_or("SUBFLOW_INSTANCE_MISSING")?;
                record.status = "failed".into();
                self.terminal = Some("blocked".into());
                self.terminal_reason = child.run.terminal_reason.clone();
            }
            if self.terminal.is_none() && group.pending.is_empty() {
                // A successful child must remain completed even if the
                // subsequent group transition is invalid. Retry that
                // transition during dispatch, where it is reported as a
                // scheduler error rather than as the child's failure.
                let before_transition = self.clone();
                match self.finish_group_if_ready(&group) {
                    Ok(true) => return Ok(()),
                    Ok(false) => {}
                    Err(_) => *self = before_transition,
                }
            }
            self.group = Some(group);
            return Ok(());
        }
        let key = Action::key(site, ordinal);
        if let Some(node_id) = self.phase_pending.get(&key).cloned() {
            let mut child = self
                .phase_calls
                .remove(&node_id)
                .ok_or("SUBFLOW_INSTANCE_MISSING")?;
            child.complete(site, ordinal, result)?;
            self.phase_pending.remove(&key);
            self.update_phase_call(&node_id, &child)?;
            self.phase_calls.insert(node_id, child);
            if self.terminal.is_none()
                && self
                    .phase_nodes
                    .values()
                    .all(|state| state == "completed" || state == "skipped")
            {
                self.advance_after_completion();
            }
            return Ok(());
        }
        let phase = self
            .definition
            .phases
            .get(&self.phase)
            .ok_or("UNKNOWN_PHASE")?;
        if !phase.run.iter().any(|id| id == site)
            || self
                .phase_nodes
                .get(site)
                .is_none_or(|status| status != "running")
        {
            return Err("UNEXPECTED_NODE_RESULT".into());
        }
        if !result.is_object() {
            return Err("NODE_RESULT_MUST_BE_OBJECT".into());
        }
        if self.definition.nodes[site]
            .schema
            .as_ref()
            .is_some_and(|schema| !crate::result_channel::validate(&result, schema))
        {
            return Err("NODE_RESULT_INVALID".into());
        }
        self.batch.insert(site.into(), result.clone());
        self.latest.insert(site.into(), result);
        self.phase_nodes.insert(site.into(), "completed".into());
        self.save_phase_context(site);
        if self.terminal.is_some() {
            return Ok(());
        }
        if self
            .phase_nodes
            .values()
            .any(|state| state != "completed" && state != "skipped")
        {
            return Ok(());
        }
        self.advance_after_completion();
        Ok(())
    }
    /// Keep completed action results if a later routing/output expression
    /// fails. Dispatch retries the untouched transition and reports the
    /// scheduler failure independently from the action's recorded outcome.
    fn advance_after_completion(&mut self) {
        let before_transition = self.clone();
        if self.advance_routes().is_err() {
            *self = before_transition;
        }
    }
    fn advance_routes(&mut self) -> Result<(), String> {
        for child in self.phase_calls.values() {
            self.calls.extend(child.all_calls());
            self.skipped.extend(child.all_skipped());
        }
        self.phase_calls.clear();
        self.phase_pending.clear();
        self.phase_active = false;
        self.phase_nodes.clear();
        self.phase_edges.clear();
        self.phase_contexts.clear();
        self.follow_routes(None)
    }
    /// 按去向前进；`forced` 是已批准关卡的去向，跳过匹配与确认。
    fn follow_routes(&mut self, mut forced: Option<usize>) -> Result<(), String> {
        loop {
            let phase = self
                .definition
                .phases
                .get(&self.phase)
                .ok_or("UNKNOWN_PHASE")?;
            let context = json!({"vars":self.vars,"latest":self.latest,"batch":self.batch});
            let approved = forced.take();
            let mut matched = None;
            if let Some(index) = approved {
                matched = Some((index, phase.routes.get(index).ok_or("UNKNOWN_ROUTE")?.clone()));
            } else {
                for (index, route) in phase.routes.iter().enumerate() {
                    if match &route.when {
                        Some(expr) => evaluate(expr, &context)?
                            .as_bool()
                            .ok_or("CONDITION_NOT_BOOLEAN")?,
                        None => true,
                    } {
                        matched = Some((index, route.clone()));
                        break;
                    }
                }
            }
            let (index, route) = matched.ok_or("NO_MATCHING_ROUTE")?;
            if approved.is_none() {
                if let Some(confirm) = &route.confirm {
                    self.gate = Some(Gate {
                        phase: self.phase.clone(),
                        route: index,
                        next: route.next.clone(),
                        label: route.label.clone(),
                        confirm: confirm.clone(),
                        approved: false,
                    });
                    return Ok(());
                }
            }
            let mut new_vars = self.vars.clone();
            for (key, expr) in &route.set {
                new_vars.insert(key.clone(), evaluate(expr, &context)?);
            }
            self.vars = new_vars;
            match route.next.as_str() {
                "$complete" => self.terminal = Some("completed".into()),
                "$blocked" => {
                    self.terminal = Some("blocked".into());
                    self.terminal_reason = route.reason;
                }
                "$return" => {
                    if self.stack.is_empty() {
                        let flow = self
                            .root_flow
                            .as_deref()
                            .ok_or("SUBFLOW_RETURN_WITHOUT_CALL")?;
                        self.return_value = Some(self.flow_output(flow)?);
                        self.terminal = Some("completed".into());
                        break;
                    }
                    let caller = self.stack.pop().ok_or("SUBFLOW_RETURN_WITHOUT_CALL")?;
                    let flow = self
                        .definition
                        .flows
                        .get(&caller.flow)
                        .ok_or("UNKNOWN_SUBFLOW")?;
                    let child_context =
                        json!({"vars":self.vars,"latest":self.latest,"batch":self.batch});
                    let outputs = flow
                        .outputs
                        .iter()
                        .map(|(key, expr)| Ok((key.clone(), evaluate(expr, &child_context)?)))
                        .collect::<Result<Map<String, Value>, String>>()?;
                    let record = self
                        .calls
                        .iter_mut()
                        .rev()
                        .find(|c| c.id == caller.instance_id)
                        .ok_or("SUBFLOW_INSTANCE_MISSING")?;
                    record.status = "completed".into();
                    record.output = Some(Value::Object(outputs.clone()));
                    self.vars = caller.parent_vars;
                    self.latest = caller.parent_latest;
                    self.latest.extend(outputs);
                    self.phase = caller.phase;
                    continue;
                }
                _ => self.phase = route.next,
            }
            break;
        }
        Ok(())
    }

    // ── 检查点与人工干预（ADR 031） ──────────────────────────────────────

    fn capture_entry(&mut self) {
        let mut snapshot = self.clone();
        snapshot.entered.clear();
        self.entered.push(snapshot);
    }
    /// 取走本次调度中各实例记下的步骤入口状态。
    pub fn drain_entered(&mut self) -> Vec<Run> {
        let mut out = std::mem::take(&mut self.entered);
        for child in self.phase_calls.values_mut() {
            out.extend(child.drain_entered());
        }
        if let Some(group) = &mut self.group {
            for child in &mut group.children {
                out.extend(child.run.drain_entered());
            }
        }
        out
    }
    /// 检查点内容：不含定义（定义随运行只存一份）。
    pub fn checkpoint_value(&self) -> Result<Value, String> {
        let mut copy = self.clone();
        copy.entered.clear();
        copy.definition.embedded = true;
        serde_json::to_value(&copy).map_err(|_| "CHECKPOINT_SERIALIZE_FAILED".to_string())
    }
    /// 当前仍在执行树上的所有流程实例（含自身）。
    pub fn live_runs(&self) -> Vec<&Run> {
        let mut out = vec![self];
        for child in self.phase_calls.values() {
            out.extend(child.live_runs());
        }
        if let Some(group) = &self.group {
            for child in &group.children {
                out.extend(child.run.live_runs());
            }
        }
        out
    }
    pub fn find(&self, prefix: &[String]) -> Option<&Run> {
        self.live_runs().into_iter().find(|run| run.prefix.as_slice() == prefix)
    }
    pub fn find_mut(&mut self, prefix: &[String]) -> Option<&mut Run> {
        if self.prefix.as_slice() == prefix {
            return Some(self);
        }
        for child in self.phase_calls.values_mut() {
            if prefix.starts_with(&child.prefix) {
                return child.find_mut(prefix);
            }
        }
        if let Some(group) = &mut self.group {
            for child in &mut group.children {
                if prefix.starts_with(&child.run.prefix) {
                    return child.run.find_mut(prefix);
                }
            }
        }
        None
    }
    pub fn blocked_anywhere(&self) -> bool {
        self.live_runs()
            .iter()
            .any(|run| run.terminal.as_deref() == Some("blocked"))
    }
    /// 去掉作废动作在各层的待回收登记。
    pub fn forget_pending(&mut self, keys: &BTreeSet<String>) {
        self.phase_pending.retain(|key, _| !keys.contains(key));
        for child in self.phase_calls.values_mut() {
            child.forget_pending(keys);
        }
        if let Some(group) = &mut self.group {
            group.pending.retain(|key, _| !keys.contains(key));
            for child in &mut group.children {
                child.run.forget_pending(keys);
            }
        }
    }
    /// 解除从根到目标实例（不含）一路上的阻塞：阻塞来自目标实例内部，干预后由它重新决定去向。
    pub fn release_block_toward(&mut self, prefix: &[String]) {
        if self.prefix.as_slice() == prefix {
            return;
        }
        if self.terminal.as_deref() == Some("blocked") {
            self.terminal = None;
            self.terminal_reason = None;
        }
        let mut instance = None;
        for child in self.phase_calls.values_mut() {
            if prefix.starts_with(&child.prefix) {
                instance = child.prefix.last().cloned();
                child.release_block_toward(prefix);
            }
        }
        if let Some(group) = &mut self.group {
            for child in &mut group.children {
                if prefix.starts_with(&child.run.prefix) {
                    instance = Some(child.instance_id.clone());
                    child.run.release_block_toward(prefix);
                }
            }
        }
        if let Some(id) = instance {
            for record in self.calls.iter_mut().filter(|r| r.id == id && r.status == "failed") {
                record.status = "running".into();
            }
        }
    }
    /// 用检查点替换目标实例。访问计数取较大值，新建的子流程实例不会与作废的同名。
    pub fn restore_at(&mut self, prefix: &[String], state: Value) -> Result<(), String> {
        let root = self.definition.clone();
        let mut restored: Run =
            serde_json::from_value(state).map_err(|_| "CHECKPOINT_INVALID".to_string())?;
        restored.definition = root.clone();
        restored.definition.embedded = !prefix.is_empty();
        restored.restore_child_definitions(&root);
        restored.entered.clear();
        let target = self.find_mut(prefix).ok_or("STEP_NOT_AVAILABLE")?;
        if restored.prefix != target.prefix {
            return Err("CHECKPOINT_INVALID".into());
        }
        for (key, count) in &target.visits {
            let entry = restored.visits.entry(key.clone()).or_default();
            *entry = (*entry).max(*count);
        }
        *target = restored;
        Ok(())
    }
    /// 放弃当前步骤，下一步改为同一流程里的 `step`。
    pub fn redirect(&mut self, step: &str) -> Result<(), String> {
        let current = self.definition.phases.get(&self.phase).ok_or("UNKNOWN_PHASE")?;
        let target = self.definition.phases.get(step).ok_or("UNKNOWN_STEP")?;
        if self.definition.phase_flow(current) != self.definition.phase_flow(target) {
            return Err("STEP_NOT_IN_CURRENT_FLOW".into());
        }
        let mut abandoned_calls = Vec::new();
        let mut abandoned_skips = Vec::new();
        for child in self.phase_calls.values() {
            abandoned_calls.extend(child.all_calls());
            abandoned_skips.extend(child.all_skipped());
        }
        if let Some(group) = self.group.take() {
            for child in group.children {
                abandoned_calls.extend(child.run.all_calls());
                abandoned_skips.extend(child.run.all_skipped());
            }
        }
        self.calls.extend(abandoned_calls);
        self.skipped.extend(abandoned_skips);
        let frames: BTreeSet<&str> = self.stack.iter().map(|f| f.instance_id.as_str()).collect();
        let own = self.call_path();
        for record in self.calls.iter_mut() {
            let open = record.status == "running" || record.status == "pending" || record.status == "failed";
            if open && !frames.contains(record.id.as_str()) && !own.contains(&record.id) {
                record.status = "abandoned".into();
            }
        }
        self.phase = step.into();
        self.phase_active = false;
        self.phase_nodes.clear();
        self.phase_edges.clear();
        self.phase_contexts.clear();
        self.phase_calls.clear();
        self.phase_pending.clear();
        self.batch.clear();
        self.terminal = None;
        self.terminal_reason = None;
        self.return_value = None;
        self.gate = None;
        Ok(())
    }
    /// 所有等待确认的关卡：`(实例路径, 调用路径, 关卡)`。
    pub fn gates(&self) -> Vec<(Vec<String>, Vec<String>, Gate)> {
        self.live_runs()
            .into_iter()
            .filter_map(|run| {
                run.gate
                    .as_ref()
                    .filter(|g| !g.approved)
                    .map(|g| (run.prefix.clone(), run.call_path(), g.clone()))
            })
            .collect()
    }
    /// 批准实例 `prefix` 上的关卡；`only_ask` 时只批准可以自动放行的。返回批准的个数。
    pub fn approve_gates(&mut self, prefix: Option<&[String]>, only_ask: bool) -> usize {
        let mut count = 0;
        if prefix.is_none_or(|p| p == self.prefix.as_slice()) {
            if let Some(gate) = &mut self.gate {
                if !gate.approved && (!only_ask || gate.confirm == "ask") {
                    gate.approved = true;
                    count += 1;
                }
            }
        }
        for child in self.phase_calls.values_mut() {
            count += child.approve_gates(prefix, only_ask);
        }
        if let Some(group) = &mut self.group {
            for child in &mut group.children {
                count += child.run.approve_gates(prefix, only_ask);
            }
        }
        count
    }
}

/// Expressions are deliberately small and deterministic; missing paths remain null.
pub fn evaluate(expr: &Value, context: &Value) -> Result<Value, String> {
    if let Some(path) = expr.get("path").and_then(Value::as_str) {
        return Ok(context.pointer(path).cloned().unwrap_or(Value::Null));
    }
    if let Some(value) = expr.get("literal") {
        return Ok(value.clone());
    }
    if let Some(spec) = expr.get("if") {
        let condition = evaluate(
            spec.get("condition").ok_or("IF_CONDITION_REQUIRED")?,
            context,
        )?
        .as_bool()
        .ok_or("CONDITION_NOT_BOOLEAN")?;
        return evaluate(
            spec.get(if condition { "then" } else { "else" })
                .ok_or("IF_BRANCH_REQUIRED")?,
            context,
        );
    }
    if let Some(values) = expr.get("object") {
        let values = values.as_object().ok_or("INVALID_OBJECT_EXPRESSION")?;
        return values
            .iter()
            .map(|(key, value)| Ok((key.clone(), evaluate(value, context)?)))
            .collect::<Result<Map<String, Value>, String>>()
            .map(Value::Object);
    }
    if let Some(parts) = expr.get("merge") {
        let parts = parts.as_array().ok_or("INVALID_MERGE_EXPRESSION")?;
        let mut merged = Map::new();
        for part in parts {
            let value = evaluate(part, context)?;
            merged.extend(
                value
                    .as_object()
                    .ok_or("MERGE_PART_MUST_BE_OBJECT")?
                    .clone(),
            );
        }
        return Ok(Value::Object(merged));
    }
    if let Some(spec) = expr.get("every") {
        let values = evaluate(spec.get("items").ok_or("EVERY_ITEMS_REQUIRED")?, context)?;
        let items = values.as_array().ok_or("EVERY_ITEMS_MUST_BE_ARRAY")?;
        let predicate = spec.get("predicate").ok_or("EVERY_PREDICATE_REQUIRED")?;
        for (index, item) in items.iter().enumerate() {
            let mut nested = context
                .as_object()
                .cloned()
                .ok_or("INVALID_EXPRESSION_CONTEXT")?;
            nested.insert("item".into(), item.clone());
            nested.insert("index".into(), json!(index));
            if !evaluate(predicate, &Value::Object(nested))?
                .as_bool()
                .ok_or("CONDITION_NOT_BOOLEAN")?
            {
                return Ok(json!(false));
            }
        }
        return Ok(json!(true));
    }
    if let Some(args) = expr.get("all").and_then(Value::as_array) {
        for a in args {
            if evaluate(a, context)? != true {
                return Ok(json!(false));
            }
        }
        return Ok(json!(true));
    }
    if let Some(args) = expr.get("any").and_then(Value::as_array) {
        for a in args {
            if evaluate(a, context)? == true {
                return Ok(json!(true));
            }
        }
        return Ok(json!(false));
    }
    if let Some(arg) = expr.get("not") {
        return Ok(json!(evaluate(arg, context)? != true));
    }
    for op in ["eq", "ne", "lt", "add", "index", "get"] {
        if let Some(args) = expr.get(op).and_then(Value::as_array) {
            if args.len() != 2 {
                return Err("INVALID_EXPRESSION".into());
            }
            let a = evaluate(&args[0], context)?;
            let b = evaluate(&args[1], context)?;
            return match op {
                "eq" => Ok(json!(a == b)),
                "ne" => Ok(json!(a != b)),
                "lt" => Ok(json!(
                    a.as_i64().ok_or("INVALID_NUMBER")? < b.as_i64().ok_or("INVALID_NUMBER")?
                )),
                "add" => Ok(json!(
                    a.as_i64()
                        .ok_or("INVALID_NUMBER")?
                        .checked_add(b.as_i64().ok_or("INVALID_NUMBER")?)
                        .ok_or("NUMBER_OVERFLOW")?
                )),
                "index" => Ok(a
                    .as_array()
                    .and_then(|v| b.as_u64().and_then(|i| v.get(i as usize)))
                    .cloned()
                    .unwrap_or(Value::Null)),
                "get" => Ok(b
                    .as_str()
                    .and_then(|key| a.get(key))
                    .cloned()
                    .unwrap_or(Value::Null)),
                _ => unreachable!(),
            };
        }
    }
    if let Some(arg) = expr.get("len") {
        let value = evaluate(arg, context)?;
        return Ok(json!(
            value
                .as_array()
                .map(Vec::len)
                .or_else(|| value.as_str().map(str::len))
                .ok_or("INVALID_LENGTH")?
        ));
    }
    if let Some(arg) = expr.get("nonempty") {
        let v = evaluate(arg, context)?;
        return Ok(json!(
            v.as_str().is_some_and(|s| !s.trim().is_empty())
                || v.as_array().is_some_and(|a| !a.is_empty())
        ));
    }
    if let Some(spec) = expr.get("itemsValid") {
        let items = evaluate(&spec["items"], context)?;
        let items = items.as_array().ok_or("INVALID_ITEMS")?;
        let fields = spec["fields"].as_array().ok_or("INVALID_FIELDS")?;
        let unique = spec["unique"].as_str().ok_or("INVALID_UNIQUE_FIELD")?;
        let mut seen = BTreeSet::new();
        for item in items {
            for field in fields {
                let field = field.as_str().ok_or("INVALID_FIELDS")?;
                if item[field].as_str().is_none_or(|s| s.trim().is_empty()) {
                    return Ok(json!(false));
                }
            }
            let Some(id) = item[unique].as_str() else {
                return Ok(json!(false));
            };
            if !seen.insert(id) {
                return Ok(json!(false));
            }
        }
        return Ok(json!(true));
    }
    if expr.is_object() {
        return Err("INVALID_EXPRESSION".into());
    }
    Ok(expr.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn staged(stages: Value, stage: Value) -> Result<Definition, String> {
        let definition: Definition = serde_json::from_value(json!({"id":"staged","name":"staged","entry":"work",
          "stages":stages,
          "nodes":{"a":{"kind":"agent","actor":"a","prompt":"work"}},
          "phases":{"work":{"stage":stage,"run":["a"],"routes":[{"next":"$complete"}]}}}))
        .map_err(|e| e.to_string())?;
        definition.validate().map(|()| definition)
    }
    #[test]
    fn stages_are_validated_and_projected_into_the_catalog() {
        let definition = staged(
            json!([{"id":"design","label":"需求与设计"},{"id":"task","label":"任务"}]),
            json!("task"),
        )
        .unwrap();
        let catalog = definition.catalog();
        assert_eq!(catalog["stages"][0]["id"], "design");
        assert_eq!(catalog["stages"][1]["label"], "任务");
        let flows = catalog["structure"]["flows"].as_object().unwrap();
        let phase = &flows.values().next().unwrap()["phases"][0];
        assert_eq!(phase["stage"], "task");
    }
    #[test]
    fn a_phase_may_not_reference_an_undeclared_stage() {
        assert_eq!(
            staged(json!([{"id":"design","label":"需求与设计"}]), json!("ghost")).unwrap_err(),
            "INVALID_PHASE_STAGE:work"
        );
        assert_eq!(
            staged(
                json!([{"id":"design","label":"A"},{"id":"design","label":"B"}]),
                json!(null)
            )
            .unwrap_err(),
            "INVALID_STAGE:design"
        );
    }
    #[test]
    fn definitions_without_stages_keep_working() {
        let definition = staged(json!([]), json!(null)).unwrap();
        let catalog = definition.catalog();
        assert_eq!(catalog["stages"], json!([]));
    }
    #[test]
    fn dynamic_instances_share_definition_before_and_after_checkpoint_restore() {
        let definition:Definition=serde_json::from_value(json!({"id":"shared","name":"shared","entry":"call",
          "flows":{"main":{"label":"main","entry":"call"},"child":{"label":"child","entry":"work"}},
          "nodes":{"a":{"kind":"agent","actor":"a","prompt":"work"}},
          "phases":{"call":{"flow":"main","call":"child","foreach":{"items":{"literal":[1,2]},"maxConcurrency":2},"routes":[{"next":"$complete"}]},"work":{"flow":"child","run":["a"],"routes":[{"next":"$return"}]}}})).unwrap();
        let mut workflow = crate::Workflow::from_definition(definition, json!({})).unwrap();
        workflow.dispatch().unwrap();
        for child in &workflow.graph.group.as_ref().unwrap().children {
            assert!(Arc::ptr_eq(
                &workflow.graph.definition.inner,
                &child.run.definition.inner
            ));
        }
        let checkpoint = serde_json::to_string(&workflow).unwrap();
        let restored: crate::Workflow = serde_json::from_str(&checkpoint).unwrap();
        for child in &restored.graph.group.as_ref().unwrap().children {
            assert!(Arc::ptr_eq(
                &restored.graph.definition.inner,
                &child.run.definition.inner
            ));
        }
    }
    fn definition() -> Definition {
        serde_json::from_value(json!({
            "id":"example","name":"Example","entry":"implementation",
            "nodes": {
                "implement":{"kind":"agent","actor":"writer","prompt":"Implement"},
                "reviewA":{"kind":"agent","actor":"a","prompt":"Review correctness"},
                "reviewB":{"kind":"agent","actor":"b","prompt":"Review design"},
                "scan":{"kind":"python","actor":"scan","script":"check.py"}
            },
            "phases":{
                "implementation":{"run":["implement"],"routes":[{"next":"reviews"}]},
                "reviews":{"run":["reviewA","reviewB"],"routes":[
                    {"when":{"all":[{"eq":[{"path":"/latest/reviewA/decision"},"pass"]},{"eq":[{"path":"/latest/reviewB/decision"},"pass"]}]},"next":"check"},
                    {"next":"$blocked"}]},
                "check":{"run":["scan"],"routes":[{"when":{"eq":[{"path":"/latest/scan/status"},"ok"]},"next":"$complete"},{"next":"$blocked"}]}
            }
        })).unwrap()
    }
    #[test]
    fn definition_drives_parallel_join_and_custom_outputs() {
        let mut run = Run::new(definition(), json!({"text":"task"})).unwrap();
        let mut ordinals = BTreeMap::new();
        assert_eq!(run.dispatch(&mut ordinals).unwrap()[0].site, "implement");
        run.complete("implement", 1, json!({"files":{"values":["result.md"]}}))
            .unwrap();
        let reviewers = run.dispatch(&mut ordinals).unwrap();
        assert_eq!(
            reviewers
                .iter()
                .map(|a| a.site.as_str())
                .collect::<Vec<_>>(),
            vec!["reviewA", "reviewB"]
        );
        run.complete("reviewB", 1, json!({"decision":"pass"}))
            .unwrap();
        assert_eq!(run.phase, "reviews");
        run.complete("reviewA", 1, json!({"decision":"pass"}))
            .unwrap();
        assert_eq!(run.dispatch(&mut ordinals).unwrap()[0].site, "scan");
        run.complete("scan", 1, json!({"status":"ok"})).unwrap();
        assert_eq!(run.terminal.as_deref(), Some("completed"));
        assert_eq!(run.latest["implement"]["files"]["values"][0], "result.md");
    }

    #[test]
    fn sessions_can_be_scoped_to_the_current_workflow_iteration() {
        let definition: Definition = serde_json::from_value(json!({
            "id":"scoped","name":"Scoped","entry":"work",
            "nodes":{"a":{"kind":"agent","actor":"reviewer","sessionScope":["/vars/task/id"],"prompt":"review"}},
            "phases":{"work":{"run":["a"],"routes":[{"next":"work"}]}}
        })).unwrap();
        let mut run = Run::new(definition, json!({})).unwrap();
        run.vars.insert("task".into(), json!({"id":"T1"}));
        let mut ordinals = BTreeMap::new();
        let first = run.dispatch(&mut ordinals).unwrap().remove(0);
        run.complete("a", 1, json!({})).unwrap();
        let same = run.dispatch(&mut ordinals).unwrap().remove(0);
        assert_eq!(first.actor, same.actor);
        run.complete("a", same.ordinal, json!({})).unwrap();
        run.vars.insert("task".into(), json!({"id":"T2"}));
        let other = run.dispatch(&mut ordinals).unwrap().remove(0);
        assert_ne!(same.actor, other.actor);
        assert!(other.actor.starts_with("reviewer"));
    }
    #[test]
    fn editing_definition_changes_execution_without_engine_changes() {
        let mut flow = definition();
        flow.phases.get_mut("implementation").unwrap().routes[0].next = "check".into();
        let mut run = Run::new(flow, json!({})).unwrap();
        let mut ordinals = BTreeMap::new();
        run.dispatch(&mut ordinals).unwrap();
        run.complete("implement", 1, json!({})).unwrap();
        assert_eq!(run.dispatch(&mut ordinals).unwrap()[0].site, "scan");
    }
    #[test]
    fn rejects_invalid_or_unhandled_decisions() {
        let mut flow = definition();
        flow.phases.get_mut("implementation").unwrap().routes[0].next = "missing".into();
        assert!(Run::new(flow, json!({})).is_err());
        let mut run = Run::new(definition(), json!({})).unwrap();
        let mut ordinals = BTreeMap::new();
        run.dispatch(&mut ordinals).unwrap();
        assert!(run.complete("reviewA", 1, json!({})).is_err());
    }
    #[test]
    fn optional_explicit_input_requirement_blocks_before_dispatch() {
        let mut flow = definition();
        flow.nodes
            .get_mut("scan")
            .unwrap()
            .requires
            .push(Requirement {
                condition: json!({"nonempty":{"path":"/latest/implement/files/values"}}),
                message: "缺少上游文件".into(),
            });
        flow.phases.get_mut("implementation").unwrap().routes[0].next = "check".into();
        let mut run = Run::new(flow, json!({})).unwrap();
        let mut ordinals = BTreeMap::new();
        run.dispatch(&mut ordinals).unwrap();
        run.complete("implement", 1, json!({"files":{"values":[]}}))
            .unwrap();
        assert!(run.dispatch(&mut ordinals).unwrap().is_empty());
        assert_eq!(run.terminal.as_deref(), Some("blocked"));
        assert!(run.terminal_reason.unwrap().contains("缺少上游文件"));
    }
}
