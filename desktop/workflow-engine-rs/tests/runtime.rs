use aaw_workflow_core::{
    Stage, Workflow,
    headless_host::HeadlessHost,
    journal::{Journal, RunSnapshot},
    runtime::{Host, Runtime, RuntimeConfig},
};
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

struct ControlledHost;
impl Host for ControlledHost {}

#[test]
#[ignore = "requires Python; run explicitly for supervised engine integration"]
fn controlled_run_uses_supervised_agents_and_real_scanner_process() {
    let name = format!(
        "aaw-runtime-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let project = std::env::temp_dir().join(name);
    std::fs::create_dir(&project).unwrap();
    let scan = project.join("scanner.py");
    std::fs::write(&scan,"import json\nprint(json.dumps({'decision':'pass','evidence':'fixture','safe':True,'simulated':False}))\n").unwrap();
    let db_path = project.join("journal.sqlite");
    let project_str = project.to_str().unwrap().to_string();
    let mut journal = Journal::open(&db_path).unwrap();
    let fake = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/dev-fake-acp.py");
    let config = RuntimeConfig {
        cwd: project.clone(),
        command: vec!["python".into(), fake.to_str().unwrap().into()],
        profile: None,
        mcp_servers: json!([]),
        python: "python".into(),
    };
    let snapshot = RunSnapshot {
        execution_hash: Some(config.execution_hash("r")),
    };
    let defined_workflow = workflow("test fixture".into(), true);
    // scan is now an agent node (ADR 023): the scanner runs inside the
    // agent's turn, so the fixture script lives in the project for it to call.
    let _ = &scan;
    journal
        .create_with_snapshot("r", &project_str, &defined_workflow, &snapshot)
        .unwrap();
    let sink = Arc::new(|_: Value| Ok(()));
    let runtime = Runtime::start(
        journal,
        "r".into(),
        project_str.clone(),
        "owner".into(),
        config.clone(),
        Arc::new(ControlledHost),
        Arc::new(HeadlessHost::new("r".into(), sink.clone())),
    )
    .unwrap();
    // A single advance now drains all ready work instead of stopping after
    // one phase. Resume before scheduling, without assuming a phase count.
    assert_eq!(runtime.state().unwrap().stage, Stage::Running);
    drop(runtime);
    let mut changed = config.clone();
    changed.python = "other-python".into();
    assert!(
        matches!(Runtime::resume(Journal::open(&db_path).unwrap(),"r".into(),project_str.clone(),"resume-check".into(),changed,Arc::new(ControlledHost),Arc::new(HeadlessHost::new("r".into(),sink.clone()))), Err(ref e) if e=="RUNTIME_CONFIGURATION_CHANGED")
    );
    let mut runtime = Runtime::resume(
        Journal::open(&db_path).unwrap(),
        "r".into(),
        project_str.clone(),
        "resumed".into(),
        config,
        Arc::new(ControlledHost),
        Arc::new(HeadlessHost::new("r".into(), sink)),
    )
    .unwrap();
    for _ in 0..30 {
        let state = runtime.state().unwrap();
        if state.stage == Stage::Completed {
            break;
        }
        // 预置流程在开发前停下等确认任务计划：放行后继续。
        if state.stage == Stage::Waiting {
            for gate in state.gates() {
                let instance: Vec<String> = serde_json::from_value(gate["instance"].clone()).unwrap();
                runtime.confirm(&instance).unwrap();
            }
        }
        runtime.advance().unwrap();
    }
    assert_eq!(runtime.state().unwrap().stage, Stage::Completed);
    drop(runtime);
    let journal = Journal::open(&db_path).unwrap();
    let links = journal.session_links("r", &project_str).unwrap();
    let nodes = journal.nodes("r", &project_str).unwrap();
    assert!(
        nodes
            .iter()
            .any(|node| node.site_id == "reviewer_a" && node.status == "completed")
    );
    assert!(
        nodes
            .iter()
            .any(|node| node.site_id == "scan" && node.status == "completed")
    );
    assert!(links.iter().any(|link| link.site == "reviewer_a"));
    assert!(links.iter().any(|link| link.site == "reviewer_b"));
    // scan is an agent node now: its CodeCheck result arrives through
    // the agent's submit_workflow_result, not a python process output.
    let scan_node = nodes
        .iter()
        .find(|node| node.site_id == "scan")
        .unwrap();
    assert_eq!(scan_node.status, "completed");
    drop(journal);
    std::fs::remove_file(scan).unwrap();
    std::fs::remove_file(db_path).unwrap();
    std::fs::remove_dir(project).unwrap();
}

fn workflow(requirement: String, _scanner: bool) -> Workflow {
    let definition = aaw_workflow_core::source::compile_dir(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("workflows/aaw-dev")).unwrap().definition;
    Workflow::from_definition(definition, json!({"requirement":requirement})).unwrap()
}
