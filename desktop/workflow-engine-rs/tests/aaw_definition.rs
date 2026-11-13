use aaw_workflow_core::{Stage, Workflow, graph::Definition};
use serde_json::{Value, json};
fn workflow(_codecheck: bool) -> Workflow {
    let def: Definition =
        aaw_workflow_core::source::compile_dir(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("workflows/aaw-dev")).unwrap().definition;
    Workflow::from_definition(def, json!({"requirement":"test"})).unwrap()
}
fn phase(w: &Workflow) -> &str {
    &active_graph(&w.graph).phase
}
fn active_graph(run: &aaw_workflow_core::graph::Run) -> &aaw_workflow_core::graph::Run {
    match run.group.as_ref().and_then(|group| {
        group
            .children
            .iter()
            .find(|child| child.started && child.run.terminal.is_none())
    }) {
        Some(child) => active_graph(&child.run),
        None => run,
    }
}
fn run(w: &mut Workflow, id: &str, v: Value) {
    let actions = w.dispatch().unwrap();
    assert_eq!(actions.len(), 1);
    assert_eq!(actions[0].site, id);
    if actions[0].input["__node"]["kind"] == "python" {
        w.complete_python(
            id,
            actions[0].ordinal,
            aaw_workflow_core::ProcessOutput {
                exit_code: 0,
                stdout: v.to_string(),
                stderr: String::new(),
            },
        )
        .unwrap();
    } else {
        w.complete(id, actions[0].ordinal, v).unwrap();
    }
}
fn artifact() -> Value {
    json!({"status":"ready","reference":"ref","evidence":"evidence"})
}
fn gate(decision: &str, safe: bool) -> Value {
    json!({"decision":decision,"safe":safe,"report":"report","issues":""})
}
fn plan() -> Value {
    json!({"status":"ready","plan":"p","tests":"t","evidence":"e","tasks":[{"id":"1","goal":"g","scope":"s","tests":"t"},{"id":"2","goal":"g","scope":"s","tests":"t"}]})
}
fn to_plan(w: &mut Workflow) {
    run(w, "requirement", artifact());
    run(w, "design", artifact());
    run(w, "design_review", gate("pass", false));
    run(w, "tests", artifact());
    run(w, "gate", gate("pass", false));
}
fn reviews(w: &mut Workflow, a: &str, b: &str) {
    let pending = w.dispatch().unwrap();
    assert_eq!(pending.len(), 2);
    w.complete(
        "reviewer_b",
        pending[1].ordinal,
        json!({"decision":b,"report":"b report"}),
    )
    .unwrap();
    assert_eq!(phase(w), "reviews");
    w.complete(
        "reviewer_a",
        pending[0].ordinal,
        json!({"decision":a,"report":"a report"}),
    )
    .unwrap();
}
#[test]
fn two_tasks_and_parallel_reviews_follow_definition() {
    let mut w = workflow(true);
    to_plan(&mut w);
    run(&mut w, "plan", plan());
    for (index, next) in [(0, "2"), (1, "")] {
        let action = w.dispatch().unwrap().pop().unwrap();
        assert_eq!(action.site, "implementation");
        if index == 1 {
            assert_eq!(action.input["vars"]["task"]["id"], "2");
            assert_eq!(action.input["vars"]["planVersion"], "p2");
            assert_eq!(action.input["vars"]["testVersion"], "t2");
            assert_eq!(action.input["vars"]["previousDelivery"]["nextTaskId"], "2");
        }
        w.complete("implementation", action.ordinal, artifact()).unwrap();
        reviews(&mut w, "pass", "pass");
        run(
            &mut w,
            "scan",
            json!({"decision":"pass","evidence":"scan","safe":false,"method":"自行审读"}),
        );
        run(
            &mut w,
            "delivery",
            json!({"status":"ready","plan":"p2","tests":"t2","done":index==1,"nextTaskId":next,"evidence":"done"}),
        );
    }
    run(&mut w, "final", artifact());
    assert_eq!(w.stage, Stage::Completed);
    assert_eq!(w.ordinals["implementation"], 2);
}

#[test]
fn task_handoff_never_starts_a_different_task_from_the_one_authorized() {
    let mut w = workflow(true);
    to_plan(&mut w);
    run(&mut w, "plan", plan());
    run(&mut w, "implementation", artifact());
    reviews(&mut w, "pass", "pass");
    run(
        &mut w,
        "scan",
        json!({"decision":"pass","evidence":"scan","safe":false,"method":"自行审读"}),
    );
    run(
        &mut w,
        "delivery",
        json!({"status":"ready","plan":"p2","tests":"t2","done":false,"nextTaskId":"unexpected","evidence":"done"}),
    );
    assert!(w.dispatch().unwrap().is_empty());
    assert_eq!(w.stage, Stage::Blocked);
    assert_eq!(w.ordinals["implementation"], 1);
    assert!(
        w.graph
            .all_calls()
            .iter()
            .any(|call| call.phase == "task_call" && call.status == "failed")
    );
}
#[test]
fn independent_findings_follow_requested_rechecks() {
    let mut w = workflow(true);
    to_plan(&mut w);
    run(&mut w, "plan", plan());
    run(&mut w, "implementation", artifact());
    reviews(&mut w, "findings", "findings");
    run(
        &mut w,
        "resolution",
        json!({"status":"ready","evidence":"fix","needA":true,"needB":true}),
    );
    run(&mut w, "recheck_a", json!({"decision":"pass","report":"a"}));
    run(&mut w, "recheck_b", json!({"decision":"pass","report":"b"}));
    assert_eq!(phase(&w), "scan");
}

#[test]
fn recheck_findings_return_to_resolution_and_require_original_reviewer() {
    for (reviewer, recheck) in [("A", "recheck_a"), ("B", "recheck_b")] {
        let mut w = workflow(true);
        to_plan(&mut w);
        run(&mut w, "plan", plan());
        run(&mut w, "implementation", artifact());
        reviews(&mut w, "findings", "findings");
        run(
            &mut w,
            "resolution",
            json!({"status":"ready","evidence":"fix","needA":reviewer=="A","needB":reviewer=="B"}),
        );
        run(
            &mut w,
            recheck,
            json!({"decision":"findings","report":"still broken"}),
        );
        assert_eq!(phase(&w), "resolution");
        assert_eq!(active_graph(&w.graph).vars["reviewRepairs"], 1);
        // The resolver cannot accidentally waive the original reviewer's remaining finding.
        run(
            &mut w,
            "resolution",
            json!({"status":"ready","evidence":"fixed again","needA":false,"needB":false}),
        );
        assert_eq!(
            phase(&w),
            if reviewer == "A" {
                "recheck_a"
            } else {
                "recheck_b"
            }
        );
        run(
            &mut w,
            recheck,
            json!({"decision":"pass","report":"verified"}),
        );
        assert_eq!(phase(&w), "scan");
    }
}

#[test]
fn recheck_repair_loop_stops_with_reason_after_limit() {
    let mut w = workflow(true);
    to_plan(&mut w);
    run(&mut w, "plan", plan());
    run(&mut w, "implementation", artifact());
    reviews(&mut w, "findings", "pass");
    for attempt in 0..3 {
        run(
            &mut w,
            "resolution",
            json!({"status":"ready","evidence":"fix","needA":true,"needB":false}),
        );
        run(
            &mut w,
            "recheck_a",
            json!({"decision":"findings","report":"still broken"}),
        );
        if attempt < 2 {
            assert_eq!(phase(&w), "resolution");
        }
    }
    assert_eq!(w.stage, Stage::Blocked);
    assert!(
        w.outcome.as_ref().unwrap()["reason"]
            .as_str()
            .unwrap()
            .contains("次数上限")
    );
}

#[test]
fn recheck_a_cannot_skip_unresolved_b_after_another_repair() {
    let mut w = workflow(true);
    to_plan(&mut w);
    run(&mut w, "plan", plan());
    run(&mut w, "implementation", artifact());
    reviews(&mut w, "findings", "findings");
    run(
        &mut w,
        "resolution",
        json!({"status":"ready","evidence":"fix","needA":false,"needB":true}),
    );
    run(
        &mut w,
        "recheck_b",
        json!({"decision":"findings","report":"b still broken"}),
    );
    run(
        &mut w,
        "resolution",
        json!({"status":"ready","evidence":"fix both","needA":true,"needB":false}),
    );
    run(
        &mut w,
        "recheck_a",
        json!({"decision":"pass","report":"a verified"}),
    );
    assert_eq!(phase(&w), "recheck_b");
    run(
        &mut w,
        "recheck_b",
        json!({"decision":"pass","report":"b verified"}),
    );
    assert_eq!(phase(&w), "scan");
}
#[test]
fn repair_limit_and_unsafe_results_block() {
    let mut w = workflow(true);
    run(&mut w, "requirement", artifact());
    run(&mut w, "design", artifact());
    run(&mut w, "design_review", gate("pass", false));
    run(&mut w, "tests", artifact());
    run(&mut w, "gate", gate("revise", true));
    for _ in 0..2 {
        run(
            &mut w,
            "gate_repair",
            json!({"status":"ready","design":"d","tests":"t","evidence":"e"}),
        );
        run(&mut w, "gate_recheck", gate("revise", true));
    }
    assert_eq!(w.stage, Stage::Blocked);
}

#[test]
fn duplicate_task_ids_do_not_pass_planning() {
    let mut w = workflow(true);
    to_plan(&mut w);
    let mut p = plan();
    p["tasks"][1]["id"] = json!("1");
    run(&mut w, "plan", p);
    assert_eq!(w.stage, Stage::Blocked);
}

#[test]
fn design_can_publish_files_without_legacy_artifact_fields() {
    let mut w = workflow(true);
    run(&mut w, "requirement", artifact());
    run(
        &mut w,
        "design",
        json!({"files":{"comment":"交付的文件","values":["aaa.md","bbb.md"]}}),
    );
    assert_eq!(phase(&w), "design_review");
    assert_eq!(w.graph.vars["design"]["files"]["values"][1], "bbb.md");
}

#[test]
fn python_failure_in_parallel_cannot_be_overridden_by_later_agent_completion() {
    let def: Definition =
        serde_json::from_value(json!({"id":"mixed","name":"Mixed","entry":"both","nodes":{
      "agent":{"kind":"agent","actor":"a","prompt":"work"},
      "script":{"kind":"python","actor":"p","script":"check.py"}},
      "phases":{"both":{"run":["agent","script"],"routes":[{"next":"$complete"}]}}}))
        .unwrap();
    let mut w = Workflow::from_definition(def, json!({"requirement":"test"})).unwrap();
    let pending = w.dispatch().unwrap();
    let python = pending.iter().find(|a| a.site == "script").unwrap();
    let agent = pending.iter().find(|a| a.site == "agent").unwrap();
    assert!(
        w.complete_python(
            "script",
            python.ordinal,
            aaw_workflow_core::ProcessOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "failed".into(),
            },
        )
        .is_err()
    );
    w.complete("agent", agent.ordinal, json!({"result":"done"}))
        .unwrap();
    assert_eq!(w.stage, Stage::Running);
    assert!(w.action("script", 1).is_some());
    assert!(w.outcome.is_none());
}
#[test]
fn phase_visit_limit_stops_and_reports_the_reason() {
    let def:Definition=serde_json::from_value(json!({"id":"loop","name":"Loop","entry":"work","nodes":{"worker":{"kind":"agent","actor":"a","prompt":"work"}},"phases":{"work":{"run":["worker"],"maxVisits":1,"routes":[{"next":"work"}]}}})).unwrap();
    let mut w = Workflow::from_definition(def, json!({"requirement":"test"})).unwrap();
    run(&mut w, "worker", json!({}));
    assert!(w.dispatch().unwrap().is_empty());
    assert_eq!(w.stage, Stage::Blocked);
    assert!(
        w.outcome.unwrap()["reason"]
            .as_str()
            .unwrap()
            .contains("上限")
    );
}
