//! ADR 031：步骤检查点与人工干预（回退、重跑、改道）。
use aaw_workflow_core::{
    Action, Stage, Workflow,
    graph::Definition,
    intervention::{InterventionRequest, apply_cleanup},
    journal::Journal,
};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static COUNTER: AtomicU64 = AtomicU64::new(0);
fn unique(tag: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "aaw-intervention-{tag}-{}-{stamp}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}

struct Fixture {
    db: Journal,
    file: PathBuf,
    project: PathBuf,
}
impl Fixture {
    fn new(definition: Definition, input: Value) -> Self {
        let file = unique("db").with_extension("sqlite");
        let project = unique("project");
        std::fs::create_dir_all(&project).unwrap();
        let mut db = Journal::open(&file).unwrap();
        let workflow = Workflow::from_definition(definition, input).unwrap();
        db.create("run", project.to_str().unwrap(), &workflow).unwrap();
        db.claim("run", project.to_str().unwrap(), "owner").unwrap();
        Self { db, file, project }
    }
    fn p(&self) -> String {
        self.project.to_str().unwrap().to_owned()
    }
    fn dispatch(&mut self) -> Vec<Action> {
        let p = self.p();
        self.db.dispatch_ready("run", &p, "owner").unwrap()
    }
    fn complete(&mut self, action: &Action, result: Value) {
        let p = self.p();
        self.db
            .complete("run", &p, "owner", &action.site, action.ordinal, result)
            .unwrap();
    }
    fn state(&self) -> Workflow {
        self.db.load("run", &self.p()).unwrap().1
    }
    fn request(&self, value: Value) -> InterventionRequest {
        serde_json::from_value(value).unwrap()
    }
    fn intervene(&mut self, value: Value) -> Result<aaw_workflow_core::intervention::InterventionPlan, String> {
        let p = self.p();
        let request = self.request(value);
        self.db.intervene("run", &p, "owner", &request)
    }
    fn preview(&self, value: Value) -> Result<aaw_workflow_core::intervention::InterventionPlan, String> {
        self.db.plan_intervention("run", &self.p(), &self.request(value))
    }
    fn mark(&self, site: &str, ordinal: u32) -> Option<String> {
        self.db
            .nodes("run", &self.p())
            .unwrap()
            .into_iter()
            .find(|n| n.site_id == site && n.ordinal == ordinal)
            .and_then(|n| n.mark)
    }
    fn status(&self, site: &str, ordinal: u32) -> String {
        self.db
            .nodes("run", &self.p())
            .unwrap()
            .into_iter()
            .find(|n| n.site_id == site && n.ordinal == ordinal)
            .unwrap()
            .status
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.project);
        let _ = std::fs::remove_file(&self.file);
    }
}

/// 设计 → 评审（不通过就阻塞）→ 发布。设计声明清理它报告的文件，发布撤不回。
fn linear() -> Definition {
    serde_json::from_value(json!({
        "id":"linear","name":"Linear","entry":"design",
        "nodes":{
            "design":{"kind":"agent","actor":"Designer","prompt":"design","ui":{"label":"设计"},"cleanup":[{"path":"/result/files"}]},
            "review":{"kind":"agent","actor":"Reviewer","prompt":"review","ui":{"label":"评审"}},
            "publish":{"kind":"agent","actor":"Publisher","prompt":"publish","ui":{"label":"发布"},"irreversible":"会通知外部系统"}
        },
        "phases":{
            "design":{"run":["design"],"routes":[{"next":"review"}]},
            "review":{"run":["review"],"routes":[
                {"when":{"eq":[{"path":"/latest/review/decision"},{"literal":"pass"}]},"next":"publish"},
                {"next":"$blocked","reason":"评审不通过"}
            ]},
            "publish":{"run":["publish"],"routes":[{"next":"$complete"}]}
        }
    }))
    .unwrap()
}

fn link(f: &mut Fixture, action: &Action, session: &str) {
    let p = f.p();
    f.db
        .link_session("run", &p, "owner", &action.site, action.ordinal, session)
        .unwrap();
}

#[test]
fn every_step_entry_is_checkpointed_and_nodes_point_at_their_step() {
    let mut f = Fixture::new(linear(), json!({}));
    let design = f.dispatch().pop().unwrap();
    f.complete(&design, json!({"files":["docs/design.md"]}));
    let review = f.dispatch().pop().unwrap();
    let checkpoints = f.db.checkpoints("run", &f.p()).unwrap();
    assert_eq!(
        checkpoints.iter().map(|c| c.info.phase.as_str()).collect::<Vec<_>>(),
        ["design", "review"]
    );
    assert!(checkpoints.iter().all(|c| c.available));
    assert!(!checkpoints[0].current && checkpoints[1].current);
    let nodes = f.db.nodes("run", &f.p()).unwrap();
    assert_eq!(nodes[0].checkpoint, Some(checkpoints[0].info.seq));
    assert_eq!(nodes[1].checkpoint, Some(checkpoints[1].info.seq));
    assert_eq!(review.site, "review");
}

#[test]
fn discarding_rewinds_the_state_deletes_declared_files_and_opens_new_sessions() {
    let mut f = Fixture::new(linear(), json!({}));
    let design = f.dispatch().pop().unwrap();
    link(&mut f, &design, "s-design");
    std::fs::create_dir_all(f.project.join("docs")).unwrap();
    std::fs::write(f.project.join("docs/design.md"), "v1").unwrap();
    f.complete(&design, json!({"files":["docs/design.md","docs/missing.md","../outside.md"]}));
    let review = f.dispatch().pop().unwrap();
    link(&mut f, &review, "s-review");
    f.complete(&review, json!({"decision":"revise"}));
    assert_eq!(f.state().stage, Stage::Blocked);

    let target = json!({"kind":"rewind","siteId":"design","ordinal":design.ordinal,"mode":"discard","note":"改用事件驱动"});
    let preview = f.preview(target.clone()).unwrap();
    // 预览不改任何东西。
    assert_eq!(f.state().stage, Stage::Blocked);
    assert_eq!(preview.superseded.len(), 2);
    assert_eq!(preview.superseded[0].label, "设计");
    assert_eq!(
        preview.cleanup.iter().map(|c| (c.path.as_str(), c.kind.as_str())).collect::<Vec<_>>(),
        [("docs/design.md", "file"), ("docs/missing.md", "missing")]
    );
    assert_eq!(preview.cleanup_problems.len(), 1, "越出项目目录的条目只报告、不删除");
    assert_eq!(preview.sessions, ["Designer", "Reviewer"]);

    let plan = f.intervene(target).unwrap();
    assert!(plan.intervention.is_some());
    assert!(apply_cleanup(&f.project, &plan.cleanup).is_empty());
    assert!(!f.project.join("docs/design.md").exists());

    let state = f.state();
    assert_eq!(state.stage, Stage::Running);
    assert!(state.outcome.is_none());
    assert_eq!(f.mark("design", design.ordinal).as_deref(), Some("superseded"));
    assert_eq!(f.mark("review", review.ordinal).as_deref(), Some("superseded"));
    // 原记录保留原状态，可以回看。
    assert_eq!(f.status("review", review.ordinal), "completed");
    assert!(f.db.actor_session("run", &f.p(), "Designer").unwrap().is_none());

    let again = f.dispatch().pop().unwrap();
    assert_eq!(again.site, "design");
    assert!(again.ordinal > design.ordinal, "编号单调递增，不复用作废记录的");
    let note = again.input["__note"].as_str().unwrap();
    assert!(note.contains("已被丢弃") && note.contains("改用事件驱动"));
    // 新会话：旧动作仍指向原会话。
    link(&mut f, &again, "s-design-2");
    let links = f.db.session_links("run", &f.p()).unwrap();
    assert!(links.iter().any(|l| l.site == "design" && l.ordinal == design.ordinal && l.session_id == "s-design"));
    assert_eq!(f.db.actor_session("run", &f.p(), "Designer").unwrap().as_deref(), Some("s-design-2"));

    // 被越过的检查点不能再当目标；审计留了一条。
    let checkpoints = f.db.checkpoints("run", &f.p()).unwrap();
    assert_eq!(checkpoints.len(), 1);
    assert_eq!(
        f.preview(json!({"kind":"rewind","checkpoint":plan.checkpoint.seq,"mode":"keep"})).unwrap_err(),
        "CHECKPOINT_SUPERSEDED"
    );
    let audit = f.db.interventions("run", &f.p()).unwrap();
    assert_eq!(audit.len(), 1);
    assert_eq!(audit[0]["request"]["note"], "改用事件驱动");
}

#[test]
fn rerunning_the_current_step_keeps_earlier_work_and_sessions() {
    let mut f = Fixture::new(linear(), json!({}));
    let design = f.dispatch().pop().unwrap();
    f.complete(&design, json!({"files":[]}));
    let review = f.dispatch().pop().unwrap();
    link(&mut f, &review, "s-review");
    f.complete(&review, json!({"decision":"revise"}));

    let plan = f
        .intervene(json!({"kind":"rewind","siteId":"review","ordinal":review.ordinal,"mode":"keep"}))
        .unwrap();
    assert!(plan.cleanup.is_empty() && plan.sessions.is_empty());
    assert_eq!(plan.superseded.len(), 1);
    assert!(f.mark("design", design.ordinal).is_none());
    assert_eq!(f.db.actor_session("run", &f.p(), "Reviewer").unwrap().as_deref(), Some("s-review"));

    let again = f.dispatch().pop().unwrap();
    assert_eq!(again.site, "review");
    assert!(again.input["__note"].as_str().unwrap().contains("基础上修改"));
    // 上游结果仍在，重跑的评审看得到。
    assert_eq!(again.input["latest"]["design"], json!({"files":[]}));
    f.complete(&again, json!({"decision":"pass"}));
    let publish = f.dispatch().pop().unwrap();
    assert_eq!(publish.site, "publish");
    // 备注只给一次。
    assert!(publish.input.get("__note").is_none());
}

#[test]
fn rewinding_past_an_irreversible_node_is_called_out_and_a_completed_run_can_be_reopened() {
    let mut f = Fixture::new(linear(), json!({}));
    let design = f.dispatch().pop().unwrap();
    f.complete(&design, json!({"files":[]}));
    let review = f.dispatch().pop().unwrap();
    f.complete(&review, json!({"decision":"pass"}));
    let publish = f.dispatch().pop().unwrap();
    f.complete(&publish, json!({}));
    assert!(f.dispatch().is_empty());
    assert_eq!(f.state().stage, Stage::Completed);

    let plan = f
        .intervene(json!({"kind":"rewind","siteId":"review","ordinal":review.ordinal,"mode":"keep"}))
        .unwrap();
    assert_eq!(plan.irreversible.len(), 1);
    assert_eq!(plan.irreversible[0].reason, "会通知外部系统");
    assert_eq!(f.state().stage, Stage::Running);
    assert_eq!(f.dispatch().pop().unwrap().site, "review");
}

#[test]
fn redirecting_skips_the_running_step_and_continues_where_chosen() {
    let mut f = Fixture::new(linear(), json!({}));
    let design = f.dispatch().pop().unwrap();
    f.complete(&design, json!({"files":[]}));
    let review = f.dispatch().pop().unwrap();
    let current = f
        .db
        .checkpoints("run", &f.p())
        .unwrap()
        .into_iter()
        .find(|c| c.current)
        .unwrap();

    assert_eq!(
        f.preview(json!({"kind":"goto","checkpoint":current.info.seq,"step":"nope"})).unwrap_err(),
        "UNKNOWN_STEP"
    );
    let plan = f
        .intervene(json!({"kind":"goto","checkpoint":current.info.seq,"step":"publish","note":"评审线下做过了"}))
        .unwrap();
    assert_eq!(plan.skipped.len(), 1);
    assert_eq!(f.mark("review", review.ordinal).as_deref(), Some("skipped"));
    assert_eq!(f.status("review", review.ordinal), "skipped");
    assert!(f.state().inflight.is_empty());
    let publish = f.dispatch().pop().unwrap();
    assert_eq!(publish.site, "publish");
    assert!(publish.input["__note"].as_str().unwrap().contains("评审线下做过了"));
    // 当前步骤已经变了，旧检查点不能再用来改道。
    assert_eq!(
        f.preview(json!({"kind":"goto","checkpoint":current.info.seq,"step":"design"})).unwrap_err(),
        "STEP_NO_LONGER_CURRENT"
    );
}

/// 对每一项并行执行 w1 → w2；w2 不通过就阻塞。
fn parallel() -> Definition {
    serde_json::from_value(json!({
        "id":"parallel","name":"Parallel","entry":"expand",
        "flows":{"main":{"label":"Main","entry":"expand"},"worker":{"label":"Worker","entry":"first"}},
        "nodes":{
            "w1":{"kind":"agent","actor":"W1","prompt":"one"},
            "w2":{"kind":"agent","actor":"W2","prompt":"two"},
            "done":{"kind":"agent","actor":"D","prompt":"done"}
        },
        "phases":{
            "expand":{"flow":"main","call":"worker","foreach":{"items":{"path":"/vars/input/items"},"maxConcurrency":2},"scope":{"item":{"path":"/item"}},"routes":[{"next":"finish"}]},
            "first":{"flow":"worker","run":["w1"],"routes":[{"next":"second"}]},
            "second":{"flow":"worker","run":["w2"],"routes":[
                {"when":{"eq":[{"path":"/latest/w2/ok"},{"literal":true}]},"next":"$return"},
                {"next":"$blocked","reason":"w2 失败"}
            ]},
            "finish":{"flow":"main","run":["done"],"routes":[{"next":"$complete"}]}
        }
    }))
    .unwrap()
}

fn path_of(action: &Action) -> Value {
    action.input["__callPath"].clone()
}

#[test]
fn rewinding_one_parallel_instance_leaves_its_sibling_running() {
    let mut f = Fixture::new(parallel(), json!({"items":["x","y"]}));
    let firsts = f.dispatch();
    assert_eq!(firsts.len(), 2);
    let (x1, y1) = (&firsts[0], &firsts[1]);
    f.complete(x1, json!({}));
    let x2 = f.dispatch().pop().unwrap();
    f.complete(y1, json!({}));
    let y2 = f.dispatch().pop().unwrap();
    assert_eq!(x2.site, "w2");
    assert_ne!(path_of(&x2), path_of(&y2));

    // 只把 x 实例退回它的第一步；y 的 w2 继续执行。
    let plan = f
        .intervene(json!({"kind":"rewind","siteId":"w1","ordinal":x1.ordinal,"mode":"keep"}))
        .unwrap();
    let mut superseded: Vec<_> = plan.superseded.iter().map(|n| n.site_id.as_str()).collect();
    superseded.sort();
    assert_eq!(superseded, ["w1", "w2"]);
    assert!(plan.superseded.iter().all(|n| json!(n.call_path) == path_of(x1)));
    assert_eq!(f.status("w2", x2.ordinal), "cancelled");
    assert_eq!(f.status("w2", y2.ordinal), "running");
    let state = f.state();
    assert_eq!(state.inflight.len(), 1);
    assert!(state.action("w2", y2.ordinal).is_some());

    let again = f.dispatch().pop().unwrap();
    assert_eq!(again.site, "w1");
    assert_eq!(path_of(&again), path_of(x1), "同一个实例在原位置重来");
    // 作废的动作结果到达也不会被接受。
    let p = f.p();
    assert_eq!(
        f.db.complete("run", &p, "owner", "w2", x2.ordinal, json!({"ok":true})).unwrap_err(),
        "ACTION_NOT_IN_FLIGHT"
    );
    f.complete(&again, json!({}));
    let x2b = f.dispatch().pop().unwrap();
    f.complete(&x2b, json!({"ok":true}));
    f.complete(&y2, json!({"ok":true}));
    let done = f.dispatch().pop().unwrap();
    assert_eq!(done.site, "done");
    let state = f.state();
    let instances: Vec<_> = state.graph.all_calls().into_iter().map(|c| c.status).collect();
    assert!(instances.iter().all(|s| s == "completed"), "{instances:?}");
}

#[test]
fn a_blocked_instance_can_be_rerun_but_not_while_a_sibling_is_still_blocked() {
    let mut f = Fixture::new(parallel(), json!({"items":["x","y"]}));
    let firsts = f.dispatch();
    f.complete(&firsts[0], json!({}));
    f.complete(&firsts[1], json!({}));
    let seconds = f.dispatch();
    assert_eq!(seconds.len(), 2);
    let (x2, y2) = (&seconds[0], &seconds[1]);
    f.complete(x2, json!({"ok":false}));
    assert_eq!(f.state().stage, Stage::Blocked);
    f.complete(y2, json!({"ok":false}));

    // x、y 都阻塞：只处理 x 不够，运行不能就此继续。
    assert_eq!(
        f.preview(json!({"kind":"rewind","siteId":"w2","ordinal":x2.ordinal,"mode":"keep"})).unwrap_err(),
        "ANOTHER_INSTANCE_BLOCKED"
    );
    // 在外层退到循环之前：整个循环重来。
    let outer = f
        .db
        .checkpoints("run", &f.p())
        .unwrap()
        .into_iter()
        .find(|c| c.info.phase == "expand")
        .unwrap();
    let plan = f
        .intervene(json!({"kind":"rewind","checkpoint":outer.info.seq,"mode":"keep"}))
        .unwrap();
    assert_eq!(plan.superseded.len(), 4);
    assert_eq!(f.state().stage, Stage::Running);
    let restarted = f.dispatch();
    assert_eq!(restarted.len(), 2);
    assert!(restarted.iter().all(|a| a.site == "w1"));
    assert_ne!(path_of(&restarted[0]), path_of(&firsts[0]), "新实例不与作废实例同名");
}

#[test]
fn a_single_blocked_instance_reruns_in_place() {
    let mut f = Fixture::new(parallel(), json!({"items":["x","y"]}));
    let firsts = f.dispatch();
    f.complete(&firsts[0], json!({}));
    f.complete(&firsts[1], json!({}));
    let seconds = f.dispatch();
    let (x2, y2) = (&seconds[0], &seconds[1]);
    f.complete(y2, json!({"ok":true}));
    f.complete(x2, json!({"ok":false}));
    assert_eq!(f.state().stage, Stage::Blocked);

    f.intervene(json!({"kind":"rewind","siteId":"w2","ordinal":x2.ordinal,"mode":"keep"}))
        .unwrap();
    let state = f.state();
    assert_eq!(state.stage, Stage::Running);
    assert!(state.graph.all_calls().iter().all(|c| c.status != "failed"));
    let again = f.dispatch().pop().unwrap();
    assert_eq!((again.site.as_str(), path_of(&again)), ("w2", path_of(x2)));
    f.complete(&again, json!({"ok":true}));
    assert_eq!(f.dispatch().pop().unwrap().site, "done");
}

#[test]
fn rewinding_inside_a_called_flow_restarts_its_parallel_step_as_a_whole() {
    let definition: Definition = serde_json::from_value(json!({
        "id":"called","name":"Called","entry":"review_call",
        "flows":{"main":{"label":"Main","entry":"review_call"},"review":{"label":"Review","entry":"reviews"}},
        "nodes":{"a":{"kind":"agent","actor":"A","prompt":"a"},"b":{"kind":"agent","actor":"B","prompt":"b"},"done":{"kind":"agent","actor":"D","prompt":"d"}},
        "phases":{
            "review_call":{"flow":"main","call":"review","routes":[{"next":"finish"}]},
            "reviews":{"flow":"review","run":["a","b"],"routes":[{"next":"$return"}]},
            "finish":{"flow":"main","run":["done"],"routes":[{"next":"$complete"}]}
        }
    }))
    .unwrap();
    let mut f = Fixture::new(definition, json!({}));
    let actions = f.dispatch();
    f.complete(&actions[0], json!({}));
    // b 还在执行时回到这个并行步骤：a、b 一起重跑。
    let plan = f
        .intervene(json!({"kind":"rewind","siteId":"a","ordinal":actions[0].ordinal,"mode":"keep"}))
        .unwrap();
    assert_eq!(plan.superseded.len(), 2);
    let again = f.dispatch();
    assert_eq!(again.iter().map(|a| a.site.as_str()).collect::<Vec<_>>(), ["a", "b"]);
    assert_eq!(again[0].input["__callPath"], actions[0].input["__callPath"]);
    f.complete(&again[0], json!({}));
    f.complete(&again[1], json!({}));
    assert_eq!(f.dispatch().pop().unwrap().site, "done");
}

#[test]
fn interventions_require_the_lease_and_a_valid_request() {
    let mut f = Fixture::new(linear(), json!({}));
    let design = f.dispatch().pop().unwrap();
    let p = f.p();
    let request = f.request(json!({"kind":"rewind","siteId":"design","ordinal":design.ordinal,"mode":"keep"}));
    assert_eq!(f.db.intervene("run", &p, "intruder", &request).unwrap_err(), "RUN_LEASE_MISMATCH");
    assert_eq!(
        f.preview(json!({"kind":"rewind","siteId":"design","ordinal":design.ordinal})).unwrap_err(),
        "INTERVENTION_MODE_REQUIRED"
    );
    assert_eq!(
        f.preview(json!({"kind":"rewind","siteId":"design","ordinal":99,"mode":"keep"})).unwrap_err(),
        "INTERVENTION_TARGET_NOT_FOUND"
    );
    assert_eq!(f.preview(json!({"kind":"undo","checkpoint":1})).unwrap_err(), "UNKNOWN_INTERVENTION");
}

#[cfg(windows)]
#[test]
fn service_start_releases_runs_whose_owner_process_exited() {
    use std::process::{Command, Stdio};
    let file = unique("db").with_extension("sqlite");
    let mut db = Journal::open(&file).unwrap();
    let workflow = Workflow::from_definition(linear(), json!({})).unwrap();
    db.create("dead", "p", &workflow).unwrap();
    db.create("alive", "p", &workflow).unwrap();
    let mut child = Command::new("cmd")
        .args(["/c", "ping -n 30 127.0.0.1 >nul"])
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    db.claim_process("dead", "p", "o1", child.id()).unwrap();
    db.claim_process("alive", "p", "o2", std::process::id()).unwrap();
    db.dispatch("dead", "p", "o1").unwrap();
    child.kill().unwrap();
    child.wait().unwrap();

    assert_eq!(db.recover_dead_owners().unwrap(), ["dead"]);
    assert!(!db.has_lease("dead", "p").unwrap());
    assert!(db.has_lease("alive", "p").unwrap());
    let (_, state) = db.load("dead", "p").unwrap();
    assert_eq!(state.failure.as_deref(), Some("OWNER_PROCESS_EXITED"));
    // 中断时在执行的动作仍要核对或授权重试后才能继续，不会被悄悄重跑。
    assert_eq!(state.inflight.len(), 1);
    drop(db);
    let _ = std::fs::remove_file(file);
}

/// 计划 →（确认）→ 并行的每项 →（ask 确认）→ 完成。
fn gated(auto: bool) -> Workflow {
    let definition: Definition = serde_json::from_value(json!({
        "id":"gated","name":"Gated","entry":"plan",
        "flows":{"main":{"label":"Main","entry":"plan"},"item":{"label":"Item","entry":"work"}},
        "nodes":{
            "plan":{"kind":"agent","actor":"P","prompt":"plan"},
            "work":{"kind":"agent","actor":"W","prompt":"work"},
            "check":{"kind":"agent","actor":"C","prompt":"check"},
            "final":{"kind":"agent","actor":"F","prompt":"final"}
        },
        "phases":{
            "plan":{"flow":"main","run":["plan"],"routes":[{"next":"each","confirm":"must","label":"确认计划"}]},
            "each":{"flow":"main","call":"item","foreach":{"items":{"path":"/vars/input/items"},"maxConcurrency":2},"routes":[{"next":"final"}]},
            "work":{"flow":"item","run":["work"],"routes":[{"next":"check","confirm":"must"}]},
            "check":{"flow":"item","run":["check"],"routes":[{"next":"$return"}]},
            "final":{"flow":"main","run":["final"],"routes":[{"next":"$complete","confirm":"ask"}]}
        }
    }))
    .unwrap();
    let mut w = Workflow::from_definition(definition, json!({"items":["x","y"]})).unwrap();
    w.auto_confirm = auto;
    w
}

fn instance(gate: &Value) -> Vec<String> {
    serde_json::from_value(gate["instance"].clone()).unwrap()
}

#[test]
fn a_must_gate_stops_the_run_until_confirmed() {
    let mut w = gated(false);
    let plan = w.dispatch().unwrap().pop().unwrap();
    w.complete("plan", plan.ordinal, json!({})).unwrap();
    assert!(w.dispatch().unwrap().is_empty());
    assert_eq!(w.stage, Stage::Waiting);
    let gates = w.gates();
    assert_eq!(gates.len(), 1);
    assert_eq!((gates[0]["next"].as_str(), gates[0]["label"].as_str()), (Some("each"), Some("确认计划")));
    assert_eq!(w.outcome.as_ref().unwrap()["status"], "waiting");
    // 等确认时再调度也不会越过关卡。
    assert!(w.dispatch().unwrap().is_empty());
    assert_eq!(w.approve(&["nope".into()]).unwrap_err(), "NO_PENDING_CONFIRMATION");
    w.approve(&instance(&gates[0])).unwrap();
    assert_eq!(w.stage, Stage::Running);
    let works = w.dispatch().unwrap();
    assert_eq!(works.len(), 2);
    assert!(works.iter().all(|a| a.site == "work"));
}

#[test]
fn a_gate_inside_one_instance_does_not_hold_back_its_sibling() {
    let mut w = gated(false);
    let plan = w.dispatch().unwrap().pop().unwrap();
    w.complete("plan", plan.ordinal, json!({})).unwrap();
    w.dispatch().unwrap();
    w.approve(&[]).unwrap();
    let works = w.dispatch().unwrap();
    let (x, y) = (&works[0], &works[1]);
    w.complete("work", x.ordinal, json!({})).unwrap();
    // x 停在关卡上，y 还在执行：运行不算「等确认」。
    assert!(w.dispatch_ready().unwrap().is_empty());
    assert_eq!(w.stage, Stage::Running);
    w.complete("work", y.ordinal, json!({})).unwrap();
    assert!(w.dispatch_ready().unwrap().is_empty());
    assert_eq!(w.stage, Stage::Waiting);
    assert_eq!(w.gates().len(), 2);
    let first = instance(&w.gates()[0]);
    w.approve(&first).unwrap();
    let checks = w.dispatch().unwrap();
    assert_eq!(checks.len(), 1);
    assert_eq!(checks[0].input["__callPath"], json!(first));
    w.complete("check", checks[0].ordinal, json!({})).unwrap();
    assert!(w.dispatch().unwrap().is_empty());
    assert_eq!(w.stage, Stage::Waiting);
    let second = instance(&w.gates()[0]);
    w.approve(&second).unwrap();
    let check = w.dispatch().unwrap().pop().unwrap();
    w.complete("check", check.ordinal, json!({})).unwrap();
    let last = w.dispatch().unwrap().pop().unwrap();
    assert_eq!(last.site, "final");
    assert!(w.graph.all_calls().iter().all(|c| c.status == "completed"));
}

#[test]
fn auto_confirm_passes_ask_gates_but_not_must_gates() {
    let mut w = gated(true);
    let plan = w.dispatch().unwrap().pop().unwrap();
    w.complete("plan", plan.ordinal, json!({})).unwrap();
    assert!(w.dispatch().unwrap().is_empty());
    assert_eq!(w.stage, Stage::Waiting, "must 仍然要确认");
    w.approve(&[]).unwrap();
    for _ in 0..2 {
        let work = w.dispatch_ready().unwrap();
        for a in work {
            w.complete("work", a.ordinal, json!({})).unwrap();
        }
    }
    for gate in w.gates() {
        w.approve(&instance(&gate)).unwrap();
    }
    for a in w.dispatch_ready().unwrap() {
        w.complete("check", a.ordinal, json!({})).unwrap();
    }
    let last = w.dispatch_ready().unwrap().pop().unwrap();
    assert_eq!(last.site, "final");
    w.complete("final", last.ordinal, json!({})).unwrap();
    assert!(w.dispatch().unwrap().is_empty());
    assert_eq!(w.stage, Stage::Completed, "ask 关卡自动放行");
}

#[test]
fn going_back_from_a_gate_is_a_rewind_and_the_gate_is_audited_when_passed() {
    let definition = linear_gated();
    let mut f = Fixture::new(definition, json!({}));
    let design = f.dispatch().pop().unwrap();
    f.complete(&design, json!({"files":[]}));
    assert!(f.dispatch().is_empty());
    assert_eq!(f.state().stage, Stage::Waiting);
    // 退回：重做设计，关卡随之消失。
    f.intervene(json!({"kind":"rewind","siteId":"design","ordinal":design.ordinal,"mode":"keep","note":"补上错误处理"}))
        .unwrap();
    assert!(f.state().gates().is_empty());
    let again = f.dispatch().pop().unwrap();
    f.complete(&again, json!({"files":[]}));
    assert!(f.dispatch().is_empty());
    let p = f.p();
    f.db.confirm_gate("run", &p, "owner", &[]).unwrap();
    assert_eq!(f.dispatch().pop().unwrap().site, "review");
    let audit = f.db.interventions("run", &p).unwrap();
    assert_eq!(audit.iter().map(|a| a["kind"].as_str().unwrap()).collect::<Vec<_>>(), ["rewind", "confirm"]);
    assert_eq!(f.db.confirm_gate("run", &p, "owner", &[]).unwrap_err(), "NO_PENDING_CONFIRMATION");
}

fn linear_gated() -> Definition {
    let mut definition = linear();
    definition.phases.get_mut("design").unwrap().routes[0].confirm = Some("must".into());
    definition
}
