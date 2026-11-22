use aaw_workflow_core::{
    ProcessOutput, Workflow,
    session_host::{EndedTurn, SessionState, TurnOutcome},
    journal::{Journal, RunSnapshot, TurnFactKind},
};
use rusqlite::Connection;
use serde_json::json;

use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static COUNTER: AtomicU64 = AtomicU64::new(0);
fn path() -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "aaw-rust-journal-{}-{stamp}-{}.sqlite",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}

#[test]
fn input_and_result_candidates_survive_reopen_without_implicit_retry() {
    let file = path();
    let mut db = Journal::open(&file).unwrap();
    db.create("r", "project", &workflow("test".into(), false))
        .unwrap();
    db.claim("r", "project", "owner").unwrap();
    let action = db.dispatch("r", "project", "owner").unwrap().pop().unwrap();
    db.link_session(
        "r",
        "project",
        "owner",
        &action.site,
        action.ordinal,
        "session",
    )
    .unwrap();
    // ADR 023 P4：用户消息队列已归宿主（host_inputs 表），journal 不再有
    // workflow_inputs 状态机；此处只验证结果候选的持久化语义。
    let result = json!({"status":"ready","reference":"需求引用","evidence":"已确认"});
    db.record_result_candidate("r", "project", "owner", &action, "candidate", &result)
        .unwrap();
    drop(db);
    let mut db = Journal::open(&file).unwrap();
    assert_eq!(
        db.result_candidates("r", "project", &action.site, action.ordinal)
            .unwrap()[0]["result"],
        result
    );
    assert_eq!(
        db.prepare_resume("r", "project", "owner").unwrap_err(),
        "UNKNOWN_ACTION_REQUIRES_RECONCILIATION"
    );
    db.complete(
        "r",
        "project",
        "owner",
        &action.site,
        action.ordinal,
        result,
    )
    .unwrap();
    assert_eq!(
        db.result_candidates("r", "project", &action.site, action.ordinal)
            .unwrap()[0]["state"],
        "applied"
    );
    drop(db);
    std::fs::remove_file(file).unwrap();
}

#[test]
fn choosing_to_redo_a_step_discards_its_submitted_results() {
    let file = path();
    let mut db = Journal::open(&file).unwrap();
    db.create("r", "project", &workflow("test".into(), false)).unwrap();
    db.claim("r", "project", "owner").unwrap();
    let action = db.dispatch("r", "project", "owner").unwrap().pop().unwrap();
    db.link_session("r", "project", "owner", &action.site, action.ordinal, "session").unwrap();
    let result = json!({"status":"ready","reference":"r","evidence":"e"});
    db.record_result_candidate("r", "project", "owner", &action, "candidate", &result).unwrap();
    db.authorize_retry("r", "project", "owner", &action.site, action.ordinal, "用户选择重做").unwrap();
    db.supersede_candidates("r", "project", "owner", &action.site, action.ordinal).unwrap();
    // 重做时不会把旧结果当作已交：候选作废，但留着可查。
    assert_eq!(
        db.result_candidates("r", "project", &action.site, action.ordinal).unwrap()[0]["state"],
        "superseded"
    );
    assert_eq!(db.supersede_candidates("r", "project", "other", &action.site, action.ordinal).unwrap_err(), "RUN_LEASE_MISMATCH");
    drop(db);
    std::fs::remove_file(file).unwrap();
}

#[test]
fn rejected_agent_result_remains_failed_and_can_be_reconciled() {
    let file = path();
    let mut db = Journal::open(&file).unwrap();
    let mut w = workflow("test".into(), true);
    w.graph.phase = "resolution".into();
    db.create("r", "project", &w).unwrap();
    db.claim("r", "project", "owner").unwrap();
    let action = db.dispatch("r", "project", "owner").unwrap().pop().unwrap();
    assert!(
        db.complete(
            "r",
            "project",
            "owner",
            &action.site,
            action.ordinal,
            json!({"status":"blocked","evidence":"需要决定","needA":false,"needB":false})
        )
        .is_err()
    );
    assert_eq!(db.nodes("r", "project").unwrap()[0].status, "failed");
    db.reconcile(
        "r",
        "project",
        "owner",
        &action.site,
        action.ordinal,
        "已核实真实结果",
        json!({"status":"ready","evidence":"checked","needA":true,"needB":false}),
    )
    .unwrap();
    assert_eq!(db.nodes("r", "project").unwrap()[0].status, "completed");
    drop(db);
    std::fs::remove_file(file).unwrap();
}

#[test]
fn codecheck_output_and_checkpoint_are_committed_together() {
    let file = path();
    let mut db = Journal::open(&file).unwrap();
    let mut workflow = workflow("test".into(), true);
    workflow.graph.phase = "scan".into();
    db.create("run-1", "project", &workflow).unwrap();
    db.claim("run-1", "project", "owner").unwrap();
    let action = db
        .dispatch("run-1", "project", "owner")
        .unwrap()
        .pop()
        .unwrap();
    let output = ProcessOutput {
        exit_code: 0,
        stdout: r#"{"decision":"pass","evidence":"actual evidence","safe":true,"simulated":false}"#
            .into(),
        stderr: "scan warning".into(),
    };
    assert!(
        db.complete_python(
            "run-1",
            "project",
            "owner",
            &action.site,
            action.ordinal + 1,
            output.clone()
        )
        .is_err()
    );
    assert!(
        db.process_output("run-1", "project", &action.site, action.ordinal + 1)
            .is_err()
    );
    db.complete_python(
        "run-1",
        "project",
        "owner",
        &action.site,
        action.ordinal,
        output,
    )
    .unwrap();
    drop(db);
    let db = Journal::open(&file).unwrap();
    assert_eq!(
        db.load("run-1", "project").unwrap().1.graph.phase,
        "delivery"
    );
    assert_eq!(
        db.process_output("run-1", "project", &action.site, action.ordinal)
            .unwrap()
            .stderr,
        "scan warning"
    );
    assert!(
        db.process_output("run-1", "another-project", &action.site, action.ordinal)
            .is_err()
    );
    drop(db);
    std::fs::remove_file(file).unwrap();
}

#[test]
fn checkpoint_and_one_shot_retry_are_durable_and_project_scoped() {
    let file = path();
    let mut first = Journal::open(&file).unwrap();
    let mut second = Journal::open(&file).unwrap();
    first
        .create("r1", "project-a", &workflow("需求".into(), false))
        .unwrap();
    first.claim("r1", "project-a", "owner-a").unwrap();
    assert!(second.claim("r1", "project-a", "owner-b").is_err());
    assert!(second.load("r1", "project-b").is_err());
    let actions = first.dispatch("r1", "project-a", "owner-a").unwrap();
    assert_eq!(actions[0].site, "requirement");
    first.release("r1", "project-a", "owner-a").unwrap();
    second.claim("r1", "project-a", "owner-b").unwrap();
    assert!(
        second
            .dispatch("r1", "project-a", "owner-b")
            .unwrap_err()
            .contains("RECONCILIATION")
    );
    second
        .authorize_retry("r1", "project-a", "owner-b", "requirement", 1, "独立核查")
        .unwrap();
    second
        .consume_retry("r1", "project-a", "owner-b", "requirement", 1)
        .unwrap();
    drop(second);
    // A restart cannot reuse an already-consumed permission.
    let mut restored = Journal::open(&file).unwrap();
    assert!(
        restored
            .consume_retry("r1", "project-a", "owner-b", "requirement", 1)
            .is_err()
    );
    restored
        .reconcile(
            "r1",
            "project-a",
            "owner-b",
            "requirement",
            1,
            "已完成的证据",
            json!({"status":"ready","reference":"r","evidence":"e"}),
        )
        .unwrap();
    let (revision, state) = restored.load("r1", "project-a").unwrap();
    assert_eq!(revision, 4);
    assert_eq!(state.graph.phase, "design");
    assert!(state.inflight.is_empty());
    assert_eq!(state.recovery_audit.len(), 3);
    drop(restored);
    drop(first);
    std::fs::remove_file(file).unwrap();
}

#[test]
fn existing_unrelated_database_is_not_repurposed() {
    let file = path();
    let db = Connection::open(&file).unwrap();
    db.execute("CREATE TABLE user_data (value TEXT)", [])
        .unwrap();
    db.execute("INSERT INTO user_data VALUES ('keep')", [])
        .unwrap();
    drop(db);
    assert!(
        matches!(Journal::open(&file),Err(ref message) if message=="DATABASE_NOT_RUST_WORKFLOW")
    );
    let db = Connection::open(&file).unwrap();
    assert_eq!(
        db.query_row("SELECT value FROM user_data", [], |row| row
            .get::<_, String>(0))
            .unwrap(),
        "keep"
    );
    drop(db);
    std::fs::remove_file(file).unwrap();
}

#[test]
fn run_snapshot_is_atomic_immutable_and_project_scoped() {
    let file = path();
    let mut db = Journal::open(&file).unwrap();
    let mut workflow = workflow("需求".into(), true);
    workflow
        .graph
        .definition
        .nodes
        .get_mut("design")
        .unwrap()
        .knowledge = "初始知识".into();
    let snapshot = RunSnapshot {
        execution_hash: None,
    };
    let mut invalid = snapshot.clone();
    invalid.execution_hash = Some("invalid".into());
    assert!(
        db.create_with_snapshot("run-1", "project", &workflow, &invalid)
            .is_err()
    );
    assert!(db.load("run-1", "project").is_err());
    db.create_with_snapshot("run-1", "project", &workflow, &snapshot)
        .unwrap();
    workflow
        .graph
        .definition
        .nodes
        .get_mut("design")
        .unwrap()
        .knowledge = "已修改".into();
    assert_eq!(
        db.load("run-1", "project")
            .unwrap()
            .1
            .graph
            .definition
            .nodes["design"]
            .knowledge,
        "初始知识"
    );
    assert_eq!(db.load_snapshot("run-1", "project").unwrap(), snapshot);
    assert!(db.load_snapshot("run-1", "other-project").is_err());
    drop(db);
    let db = Journal::open(&file).unwrap();
    assert_eq!(db.load_snapshot("run-1", "project").unwrap(), snapshot);
    drop(db);
    std::fs::remove_file(file).unwrap();
}

#[test]
fn session_links_keep_actor_identity_across_design_repair() {
    let file = path();
    let mut db = Journal::open(&file).unwrap();
    db.create("r", "project", &workflow("test".into(), false))
        .unwrap();
    db.claim("r", "project", "owner").unwrap();
    let requirement = db.dispatch("r", "project", "owner").unwrap().pop().unwrap();
    db.link_session(
        "r",
        "project",
        "owner",
        &requirement.site,
        requirement.ordinal,
        "s-requirement",
    )
    .unwrap();
    db.complete(
        "r",
        "project",
        "owner",
        &requirement.site,
        requirement.ordinal,
        json!({"status":"ready","reference":"r","evidence":"e"}),
    )
    .unwrap();
    let design = db.dispatch("r", "project", "owner").unwrap().pop().unwrap();
    db.link_session(
        "r",
        "project",
        "owner",
        &design.site,
        design.ordinal,
        "s-design",
    )
    .unwrap();
    assert!(
        db.link_session(
            "r",
            "project",
            "owner",
            &design.site,
            design.ordinal,
            "other"
        )
        .is_err()
    );
    db.complete(
        "r",
        "project",
        "owner",
        &design.site,
        design.ordinal,
        json!({"status":"ready","reference":"r","evidence":"e"}),
    )
    .unwrap();
    let review = db.dispatch("r", "project", "owner").unwrap().pop().unwrap();
    db.link_session(
        "r",
        "project",
        "owner",
        &review.site,
        review.ordinal,
        "s-review",
    )
    .unwrap();
    db.complete(
        "r",
        "project",
        "owner",
        &review.site,
        review.ordinal,
        json!({"decision":"revise","issues":"issue","report":"report","safe":true}),
    )
    .unwrap();
    let repair = db.dispatch("r", "project", "owner").unwrap().pop().unwrap();
    assert_eq!(repair.site, "design_repair");
    assert!(
        db.link_session(
            "r",
            "project",
            "owner",
            &repair.site,
            repair.ordinal,
            "other"
        )
        .is_err()
    );
    db.link_session(
        "r",
        "project",
        "owner",
        &repair.site,
        repair.ordinal,
        "s-design",
    )
    .unwrap();
    let links = db.session_links("r", "project").unwrap();
    assert_eq!(links.len(), 4);
    assert_eq!(links[1].session_id, links[3].session_id);
    assert!(db.session_links("r", "different-project").is_err());
    drop(db);
    let db = Journal::open(&file).unwrap();
    // ADR 023 P4：session_events 缓冲已归宿主，journal 只保留会话关联
    // （actor_sessions / action_sessions）这份合同类数据。
    let links = db.session_links("r", "project").unwrap();
    assert_eq!(links[0].session_id, "s-requirement");
    drop(db);
    std::fs::remove_file(file).unwrap();
}

#[test]
#[ignore = "requires Python; checks owner process liveness"]
fn abandoned_lease_does_not_automatically_retry_inflight_action() {
    use std::process::{Command, Stdio};
    let file = path();
    let mut db = Journal::open(&file).unwrap();
    db.create("r", "project", &workflow("test".into(), false))
        .unwrap();
    let mut child = Command::new("python")
        .args(["-c", "import time;time.sleep(30)"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    db.claim_process("r", "project", "owner", child.id())
        .unwrap();
    db.dispatch("r", "project", "owner").unwrap();
    assert_eq!(
        db.recover_abandoned("r", "project", "test").unwrap_err(),
        "OWNER_PROCESS_STILL_ALIVE"
    );
    child.kill().unwrap();
    child.wait().unwrap();
    db.recover_abandoned("r", "project", "confirmed dead")
        .unwrap();
    db.claim_process("r", "project", "next-owner", std::process::id())
        .unwrap();
    assert!(
        db.dispatch("r", "project", "next-owner")
            .unwrap_err()
            .contains("RECONCILIATION")
    );
    db.release("r", "project", "next-owner").unwrap();
    drop(db);
    std::fs::remove_file(file).unwrap();
}

#[test]
fn parallel_retry_permissions_are_consumed_together() {
    let file = path();
    let mut db = Journal::open(&file).unwrap();
    let mut workflow = workflow("test".into(), false);
    workflow.graph.phase = "reviews".into();
    db.create("r", "project", &workflow).unwrap();
    db.claim("r", "project", "owner").unwrap();
    let actions = db.dispatch("r", "project", "owner").unwrap();
    assert_eq!(actions.len(), 2);
    db.authorize_retry("r", "project", "owner", "reviewer_a", 1, "confirmed not run")
        .unwrap();
    assert_eq!(
        db.prepare_resume("r", "project", "owner").unwrap_err(),
        "UNKNOWN_ACTION_REQUIRES_RECONCILIATION"
    );
    assert!(
        db.load("r", "project")
            .unwrap()
            .1
            .retry_approvals
            .contains(&aaw_workflow_core::Action::key("reviewer_a", 1))
    );
    db.authorize_retry("r", "project", "owner", "reviewer_b", 1, "confirmed not run")
        .unwrap();
    assert_eq!(db.prepare_resume("r", "project", "owner").unwrap().len(), 2);
    assert!(db.prepare_resume("r", "project", "owner").is_err());
    db.release("r", "project", "owner").unwrap();
    drop(db);
    std::fs::remove_file(file).unwrap();
}

fn workflow(requirement: String, _scanner: bool) -> Workflow {
    let mut definition = serde_json::to_value(aaw_workflow_core::source::compile_dir(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("workflows/aaw-dev")).unwrap().definition).unwrap();
    // scan is an agent node now (ADR 023). These tests exercise the
    // python-completion machinery, so give the graph a python node in its place.
    definition["nodes"]["scan"] = json!({
        "kind":"python","actor":"CodeCheck","script":"$input:scanner","safeToRetry":true
    });
    let definition = serde_json::from_value(definition).unwrap();
    Workflow::from_definition(definition, json!({"requirement":requirement})).unwrap()
}

#[test]
fn rejected_python_result_is_retained_for_reconciliation() {
    let file = path();
    let mut db = Journal::open(&file).unwrap();
    let mut w = workflow("test".into(), true);
    w.graph.phase = "scan".into();
    w.graph
        .definition
        .nodes
        .get_mut("scan")
        .unwrap()
        .schema = Some(
        json!({"type":"object","properties":{"decision":{"type":"string"}},"required":["decision"]}),
    );
    db.create("r", "project", &w).unwrap();
    db.claim("r", "project", "owner").unwrap();
    let action = db.dispatch("r", "project", "owner").unwrap().pop().unwrap();
    let output = ProcessOutput {
        exit_code: 0,
        stdout: "{\"unexpected\":true}".into(),
        stderr: String::new(),
    };
    assert!(
        db.complete_python(
            "r",
            "project",
            "owner",
            &action.site,
            action.ordinal,
            output
        )
        .is_err()
    );
    let candidates = db
        .result_candidates("r", "project", &action.site, action.ordinal)
        .unwrap();
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0]["result"]["stdout"], "{\"unexpected\":true}");
    assert_eq!(db.nodes("r", "project").unwrap()[0].status, "failed");
    assert!(
        db.load("r", "project")
            .unwrap()
            .1
            .action(&action.site, action.ordinal)
            .is_some()
    );
    db.authorize_retry(
        "r",
        "project",
        "owner",
        &action.site,
        action.ordinal,
        "确认可重试",
    )
    .unwrap();
    assert_eq!(db.prepare_resume("r", "project", "owner").unwrap().len(), 1);
    assert_eq!(db.nodes("r", "project").unwrap()[0].status, "running");
    db.complete_python(
        "r",
        "project",
        "owner",
        &action.site,
        action.ordinal,
        ProcessOutput {
            exit_code: 0,
            stdout: json!({"decision":"pass","evidence":"checked","simulated":false}).to_string(),
            stderr: String::new(),
        },
    )
    .unwrap();
    assert_eq!(db.nodes("r", "project").unwrap()[0].status, "completed");
    drop(db);
    std::fs::remove_file(file).unwrap();
}
#[test]
fn automatic_script_retry_is_durable_and_reserved_only_once() {
    let file = path();
    let mut db = Journal::open(&file).unwrap();
    let mut w = workflow("test".into(), true);
    w.graph.phase = "scan".into();
    w.graph
        .definition
        .nodes
        .get_mut("scan")
        .unwrap()
        .safe_to_retry = true;
    db.create("r", "project", &w).unwrap();
    db.claim("r", "project", "owner").unwrap();
    let action = db.dispatch("r", "project", "owner").unwrap().pop().unwrap();
    assert!(
        db.record_automatic_retry(
            "r",
            "project",
            "owner",
            &action,
            &json!({"error":"timeout"})
        )
        .unwrap()
    );
    drop(db);
    let mut db = Journal::open(&file).unwrap();
    assert!(
        !db.record_automatic_retry(
            "r",
            "project",
            "owner",
            &action,
            &json!({"error":"second failure"})
        )
        .unwrap()
    );
    drop(db);
    std::fs::remove_file(file).unwrap();
}

#[test]
fn runtime_failure_detail_is_sanitized_and_cleared_with_the_code() {
    let file = path();
    let mut db = Journal::open(&file).unwrap();
    db.create("r", "project", &workflow("test".into(), false))
        .unwrap();
    db.claim("r", "project", "owner").unwrap();
    db.record_runtime_failure(
        "r",
        "project",
        "owner",
        "ACTION_OUTCOME_REQUIRES_RECONCILIATION",
        "world-read#1#2: PYTHON_OUTCOME_UNKNOWN\ncontrol\u{0}chars",
    )
    .unwrap();
    let saved = db.load("r", "project").unwrap().1;
    assert_eq!(saved.failure.as_deref(), Some("ACTION_OUTCOME_REQUIRES_RECONCILIATION"));
    // Control characters are flattened and the action identity survives.
    let detail = saved.failure_detail.unwrap();
    assert!(detail.starts_with("world-read#1#2: PYTHON_OUTCOME_UNKNOWN"));
    assert!(!detail.contains('\u{0}') && !detail.contains('\n'));
    // Pathological detail is capped instead of bloating every checkpoint.
    db.record_runtime_failure(
        "r",
        "project",
        "owner",
        "ACTION_OUTCOME_REQUIRES_RECONCILIATION",
        &"x".repeat(50_000),
    )
    .unwrap();
    assert_eq!(
        db.load("r", "project").unwrap().1.failure_detail.unwrap().len(),
        2000
    );
    // Empty detail stores None, and clearing removes code and detail together.
    db.record_runtime_failure("r", "project", "owner", "RUN_CANCELLED", "  ")
        .unwrap();
    assert!(db.load("r", "project").unwrap().1.failure_detail.is_none());
    db.clear_runtime_failure("r", "project", "owner").unwrap();
    let cleared = db.load("r", "project").unwrap().1;
    assert!(cleared.failure.is_none() && cleared.failure_detail.is_none());
    db.release("r", "project", "owner").unwrap();
    drop(db);
    std::fs::remove_file(file).unwrap();
}

#[test]
fn inactive_startup_failure_does_not_overwrite_owned_or_existing_diagnostics() {
    let file = path();
    let mut db = Journal::open(&file).unwrap();
    db.create("r", "project", &workflow("test".into(), false))
        .unwrap();
    assert!(
        db.record_inactive_failure("r", "project", "QUESTION_POOL_UNAVAILABLE", "tracker 启动失败")
            .unwrap()
    );
    assert!(
        !db.record_inactive_failure("r", "project", "OTHER_ERROR", "重复失败不覆盖")
            .unwrap()
    );
    assert_eq!(
        db.load("r", "project").unwrap().1.failure.as_deref(),
        Some("QUESTION_POOL_UNAVAILABLE")
    );
    assert_eq!(
        db.load("r", "project").unwrap().1.failure_detail.as_deref(),
        Some("tracker 启动失败")
    );
    assert!(
        db.record_inactive_failure("r", "project", "TOKEN:secret", "detail")
            .is_err()
    );
    db.claim("r", "project", "owner").unwrap();
    db.clear_runtime_failure("r", "project", "owner").unwrap();
    assert!(
        !db.record_inactive_failure("r", "project", "OTHER_ERROR", "clear 后可再记")
            .unwrap()
    );
    assert!(db.load("r", "project").unwrap().1.failure.is_none());
    db.release("r", "project", "owner").unwrap();
    drop(db);
    std::fs::remove_file(file).unwrap();
}

fn state(seq: u64, running: Option<u64>, ended: Option<(u64, TurnOutcome)>) -> SessionState {
    SessionState { seq, running, ended: ended.map(|(turn, outcome)| EndedTurn { turn, outcome, error: None }) }
}

/// 轮次记录（ADR 040）：会话报告照实记进它挂着的那一步，运行停着也记；只算发过
/// 说明之后的轮次；这一步做完了就不再记。节点上看到的是最近一轮的情况。
#[test]
fn session_reports_are_recorded_on_the_step_whether_or_not_the_run_executes() {
    let file = path();
    let mut db = Journal::open(&file).unwrap();
    db.create("r", "project", &workflow("test".into(), false)).unwrap();
    db.claim("r", "project", "owner").unwrap();
    let action = db.dispatch("r", "project", "owner").unwrap().pop().unwrap();
    db.link_session("r", "project", "owner", &action.site, action.ordinal, "s").unwrap();
    let node = |db: &Journal| {
        db.nodes("r", "project")
            .unwrap()
            .into_iter()
            .find(|node| node.site_id == action.site && node.ordinal == action.ordinal)
            .unwrap()
    };
    // 还没发过说明：会话里之前聊的不算这一步的。
    assert!(db.record_session_state("s", &state(5, None, Some((4, TurnOutcome::Completed)))).unwrap().is_empty());
    assert_eq!(node(&db).turn, None);

    db.record_prompted("r", "project", "owner", &action, "s", 10).unwrap();
    assert_eq!(node(&db).turn.as_deref(), Some("working"));
    // 说明那一轮开始：发说明时已记下，不重复报事实。
    assert!(db.record_session_state("s", &state(10, Some(10), None)).unwrap().is_empty());
    let facts = db.record_session_state("s", &state(11, None, Some((10, TurnOutcome::Completed)))).unwrap();
    assert_eq!(facts.len(), 1);
    assert_eq!(facts[0].kind, TurnFactKind::Ended { turn: 10, outcome: TurnOutcome::Completed, awaiting: true });
    assert_eq!((facts[0].run_id.as_str(), facts[0].project.as_str()), ("r", "project"));
    assert_eq!(node(&db).turn.as_deref(), Some("completed"));
    // 同一份再来：不重复记。
    assert!(db.record_session_state("s", &state(11, None, Some((10, TurnOutcome::Completed)))).unwrap().is_empty());

    // 运行停下（释放占用）：你在会话里回复，照样记下。
    db.release("r", "project", "owner").unwrap();
    let started = db.record_session_state("s", &state(12, Some(12), Some((10, TurnOutcome::Completed)))).unwrap();
    assert_eq!(started.iter().map(|fact| fact.kind).collect::<Vec<_>>(), [TurnFactKind::Started { turn: 12 }]);
    assert_eq!(node(&db).turn.as_deref(), Some("working"));
    let ended = db.record_session_state("s", &state(13, None, Some((12, TurnOutcome::Cancelled)))).unwrap();
    assert_eq!(ended[0].kind, TurnFactKind::Ended { turn: 12, outcome: TurnOutcome::Cancelled, awaiting: false });
    let last = db.last_turn("r", "project", &action.site, action.ordinal).unwrap().unwrap();
    assert_eq!((last.turn, last.prompted, last.outcome), (12, false, Some(TurnOutcome::Cancelled)));
    assert!(node(&db).turn_ended_at.is_some());

    // 他人租约不能代记「发了说明」。
    assert_eq!(db.record_prompted("r", "project", "intruder", &action, "s", 20).unwrap_err(), "RUN_LEASE_MISMATCH");
    // 这一步做完了：会话里再聊不属于任何一步。
    db.claim("r", "project", "owner").unwrap();
    db.complete("r", "project", "owner", &action.site, action.ordinal, json!({"status":"ready","reference":"需求引用","evidence":"已确认"})).unwrap();
    assert!(db.record_session_state("s", &state(15, None, Some((14, TurnOutcome::Completed)))).unwrap().is_empty());
    assert_eq!(node(&db).turn, None, "做完的步骤不再报告轮次情况");
    drop(db);
    std::fs::remove_file(file).unwrap();
}

/// 节点用时（ADR 035）：派发时开始计时，两轮之间会话空着的时间算作等你，完成时记结束时间。
#[test]
fn node_times_follow_dispatch_waiting_and_completion() {
    let file = path();
    let mut db = Journal::open(&file).unwrap();
    db.create("r", "project", &workflow("test".into(), false))
        .unwrap();
    db.claim("r", "project", "owner").unwrap();
    let action = db.dispatch("r", "project", "owner").unwrap().pop().unwrap();
    let node = |db: &Journal| {
        db.nodes("r", "project")
            .unwrap()
            .into_iter()
            .find(|node| node.site_id == action.site && node.ordinal == action.ordinal)
            .unwrap()
    };
    let running = node(&db);
    let started = running.started_at.expect("派发后有开始时间");
    assert!(running.ended_at.is_none());
    assert_eq!(running.waited_ms, 0);
    assert!(serde_json::to_value(&running).unwrap().get("waitedMs").is_none(), "没有等待时不输出");

    db.link_session("r", "project", "owner", &action.site, action.ordinal, "s").unwrap();
    db.record_prompted("r", "project", "owner", &action, "s", 1).unwrap();
    db.record_session_state("s", &state(2, None, Some((1, TurnOutcome::Completed)))).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(30));
    db.record_session_state("s", &state(3, Some(3), Some((1, TurnOutcome::Completed)))).unwrap();
    let waited = node(&db).waited_ms;
    assert!(waited >= 20, "等待时长已累计：{waited}");

    db.complete(
        "r",
        "project",
        "owner",
        &action.site,
        action.ordinal,
        json!({"status":"ready","reference":"需求引用","evidence":"已确认"}),
    )
    .unwrap();
    let done = node(&db);
    assert_eq!(done.started_at, Some(started));
    assert!(done.ended_at.unwrap() >= started + waited);
    assert_eq!(done.waited_ms, waited);
    let json = serde_json::to_value(&done).unwrap();
    assert!(json["startedAt"].is_i64() && json["endedAt"].is_i64());
    drop(db);
    std::fs::remove_file(file).unwrap();
}

/// 运行停着的时间不算等你（执行时段由租约的取得与释放记下）。
#[test]
fn waiting_only_counts_while_the_run_is_executing() {
    let file = path();
    let mut db = Journal::open(&file).unwrap();
    db.create("r", "project", &workflow("test".into(), false)).unwrap();
    db.claim("r", "project", "owner").unwrap();
    let action = db.dispatch("r", "project", "owner").unwrap().pop().unwrap();
    let node = |db: &Journal| {
        db.nodes("r", "project").unwrap().into_iter()
            .find(|node| node.site_id == action.site && node.ordinal == action.ordinal).unwrap()
    };
    db.link_session("r", "project", "owner", &action.site, action.ordinal, "s").unwrap();
    db.record_prompted("r", "project", "owner", &action, "s", 1).unwrap();
    db.record_session_state("s", &state(2, None, Some((1, TurnOutcome::Completed)))).unwrap();
    let info = db.run_info("r").unwrap();
    assert!(info.active_since.is_some() && info.stopped_at.is_none(), "执行中：{info:?}");
    std::thread::sleep(std::time::Duration::from_millis(30));
    // 停下：这次等待在已结束的执行时段里的部分记进去，之后停着的时间不再长。
    db.release("r", "project", "owner").unwrap();
    let stopped = db.run_info("r").unwrap();
    assert!(stopped.active_since.is_none() && stopped.stopped_at.is_some(), "{stopped:?}");
    let before = node(&db).waited_ms;
    assert!(before >= 20, "停下前的等待已计入：{before}");
    std::thread::sleep(std::time::Duration::from_millis(80));
    assert_eq!(node(&db).waited_ms, before, "停着的时间不计");
    // 继续运行后，你接着说了：停着的那段不算进这次等待。
    db.claim("r", "project", "owner").unwrap();
    db.record_session_state("s", &state(3, Some(3), Some((1, TurnOutcome::Completed)))).unwrap();
    let waited = node(&db).waited_ms;
    assert!(waited >= before && waited < before + 60, "停着的 80ms 不算：{before} → {waited}");
    drop(db);
    std::fs::remove_file(file).unwrap();
}

/// 运行版本号（ADR 040）：任何会改变界面上样子的写入都让它变大，写入方不用记得；
/// 删除运行后版本号仍在，推送方能看到「删了」。
#[test]
fn every_visible_write_bumps_the_run_version() {
    let file = path();
    let mut db = Journal::open(&file).unwrap();
    db.create("r", "project", &workflow("test".into(), false)).unwrap();
    let mut last = db.run_version("r").unwrap();
    assert!(last > 0);
    fn bumped(db: &Journal, last: &mut i64, what: &str) {
        let now = db.run_version("r").unwrap();
        assert!(now > *last, "{what} 没让版本号变大");
        *last = now;
    }
    db.claim("r", "project", "owner").unwrap();
    bumped(&db, &mut last, "占用");
    let action = db.dispatch("r", "project", "owner").unwrap().pop().unwrap();
    bumped(&db, &mut last, "派发");
    db.record_prompted("r", "project", "owner", &action, "s", 1).unwrap();
    bumped(&db, &mut last, "发出说明");
    db.link_session("r", "project", "owner", &action.site, action.ordinal, "s").unwrap();
    bumped(&db, &mut last, "关联会话");
    db.record_session_state("s", &state(2, None, Some((1, TurnOutcome::Completed)))).unwrap();
    bumped(&db, &mut last, "一轮结束");
    db.rename_run("r", "project", "新标题").unwrap();
    bumped(&db, &mut last, "改标题");
    db.release("r", "project", "owner").unwrap();
    bumped(&db, &mut last, "释放");
    assert!(db.run_versions().unwrap().iter().any(|(run, version)| run == "r" && *version == last));
    db.delete_run("r", "project").unwrap();
    bumped(&db, &mut last, "删除");
    drop(db);
    std::fs::remove_file(file).unwrap();
}

/// 运行管理（ADR 036）：改标题、归档可恢复；删除只在没有占用时进行，并清掉所有表里这次运行的记录。
#[test]
fn runs_can_be_renamed_archived_and_deleted_without_touching_other_runs() {
    let file = path();
    let mut db = Journal::open(&file).unwrap();
    for id in ["r", "other"] {
        db.create(id, "project", &workflow("test".into(), false)).unwrap();
        db.claim(id, "project", "owner").unwrap();
        let action = db.dispatch(id, "project", "owner").unwrap().pop().unwrap();
        db.record_prompted(id, "project", "owner", &action, "s", 1).unwrap();
        db.complete(id, "project", "owner", &action.site, action.ordinal, json!({"status":"ready","reference":"需求引用","evidence":"已确认"})).unwrap();
    }

    assert_eq!(db.rename_run("r", "project", "  ").unwrap_err(), "RUN_TITLE_INVALID");
    db.rename_run("r", "project", "登录改造").unwrap();
    assert_eq!(db.run_info("r").unwrap().title, "登录改造");
    assert_eq!(db.rename_run("r", "elsewhere", "x").unwrap_err(), "RUN_NOT_FOUND");

    db.set_archived("r", "project", true).unwrap();
    assert!(db.run_info("r").unwrap().archived_at.is_some());
    db.set_archived("r", "project", false).unwrap();
    assert!(db.run_info("r").unwrap().archived_at.is_none());
    db.set_archived("r", "project", true).unwrap();

    assert_eq!(db.delete_run("r", "project").unwrap_err(), "RUN_ALREADY_CLAIMED");
    db.release("r", "project", "owner").unwrap();
    db.delete_run("r", "project").unwrap();
    assert!(db.load("r", "project").is_err());
    assert!(db.list_runs("project").unwrap().iter().all(|(id, _)| id != "r"));
    drop(db);

    let raw = rusqlite::Connection::open(&file).unwrap();
    let tables: Vec<String> = raw
        .prepare("SELECT m.name FROM sqlite_master m WHERE m.type='table' AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) c WHERE c.name='run_id')")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    for table in &tables {
        let left: i64 = raw.query_row(&format!("SELECT COUNT(*) FROM \"{table}\" WHERE run_id='r'"), [], |row| row.get(0)).unwrap();
        assert_eq!(left, 0, "{table} 里还有被删运行的记录");
    }
    let others: i64 = raw.query_row("SELECT COUNT(*) FROM action_records WHERE run_id='other'", [], |row| row.get(0)).unwrap();
    assert_eq!(others, 1, "另一个运行不受影响");
    drop(raw);
    std::fs::remove_file(file).unwrap();
}

/// 跨项目总览：列出所有项目的运行并带上项目；按项目列出时互不混入。
#[test]
fn lists_runs_across_projects_with_their_project() {
    let file = path();
    let mut db = Journal::open(&file).unwrap();
    db.create("a", "one", &workflow("test".into(), false)).unwrap();
    db.create("b", "two", &workflow("test".into(), false)).unwrap();
    let mut all: Vec<(String, String)> = db.list_all_runs().unwrap().into_iter().map(|(id, project, _)| (id, project)).collect();
    all.sort();
    assert_eq!(all, vec![("a".to_string(), "one".to_string()), ("b".to_string(), "two".to_string())]);
    assert_eq!(db.list_runs("one").unwrap().len(), 1);
    drop(db);
    std::fs::remove_file(file).unwrap();
}
