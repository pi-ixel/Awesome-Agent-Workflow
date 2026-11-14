use aaw_workflow_core::{ProcessOutput, Stage, Workflow, graph::Definition};
use serde_json::{Value, json};

fn flow(entry: &str) -> Workflow {
    let mut def: Definition =
        aaw_workflow_core::source::compile_dir(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("workflows/aaw-enterprise")).unwrap().definition;
    def.entry = entry.into();
    Workflow::from_definition(def, json!({"requirement":"example"})).unwrap()
}
/// 预置流程里的确认关卡在这些测试中一律放行（关卡本身的行为见 tests/intervention.rs）。
fn dispatch(w: &mut Workflow) -> Vec<aaw_workflow_core::Action> {
    let mut actions = w.dispatch().unwrap();
    while actions.is_empty() && w.stage == Stage::Waiting {
        for gate in w.gates() {
            let instance: Vec<String> = serde_json::from_value(gate["instance"].clone()).unwrap();
            w.approve(&instance).unwrap();
        }
        actions = w.dispatch().unwrap();
    }
    actions
}
fn ready() -> Value {
    json!({"status":"ready","reference":"artifact","evidence":"verified"})
}
fn run(w: &mut Workflow, site: &str, result: Value) -> String {
    let actions = dispatch(w);
    assert_eq!(actions.len(), 1, "phase {}", w.graph.phase);
    let a = &actions[0];
    assert_eq!(a.site, site);
    if a.input["__node"]["kind"] == "python" {
        w.complete_python(
            site,
            a.ordinal,
            ProcessOutput {
                exit_code: 0,
                stdout: result.to_string(),
                stderr: String::new(),
            },
        )
        .unwrap();
    } else {
        w.complete(site, a.ordinal, result).unwrap();
    }
    a.actor.clone()
}
fn gate(w: &mut Workflow, site: &str) {
    run(
        w,
        site,
        json!({"decision":"pass","report":"checked","issues":"","safe":false}),
    );
}
fn module(w: &mut Workflow, modules: bool) -> String {
    module_with_delivery(w, modules, ready())
}
fn module_with_delivery(w: &mut Workflow, modules: bool, delivery: Value) -> String {
    let actor = run(w, "module_design", ready());
    run(w, "module_tests", ready());
    gate(w, "module_gate");
    run(
        w,
        "plan",
        json!({"status":"ready","plan":"plan","tests":"test","evidence":"reviewed","tasks":[{"id":"T1","goal":"goal","scope":"scope","tests":"test"}]}),
    );
    run(w, "implementation", ready());
    let actions = dispatch(w);
    assert_eq!(actions.len(), 2);
    for a in actions {
        w.complete(
            &a.site,
            a.ordinal,
            json!({"decision":"pass","report":"review"}),
        )
        .unwrap();
    }
    run(
        w,
        "scan",
        json!({"decision":"pass","evidence":"scan","safe":false,"method":"自行审读"}),
    );
    run(
        w,
        "delivery",
        json!({"status":"ready","plan":"p","tests":"t","done":true,"nextTaskId":"","evidence":"done"}),
    );
    run(w, "final", delivery);
    if modules {
        assert!(
            w.graph
                .all_calls()
                .iter()
                .any(|c| c.phase == "module_call" && c.status == "pending")
        );
    }
    actor
}
#[test]
fn sr_and_ar_use_the_same_nested_definition_and_iterate_instances() {
    let mut w = flow("sr_init");
    run(&mut w, "sr_init", ready());
    run(&mut w, "sr_design", ready());
    gate(&mut w, "sr_gate");
    run(
        &mut w,
        "ar_split",
        json!({"status":"ready","confirmed":true,"mode":"split","ars":[{"id":"AR1","title":"one"},{"id":"AR2","title":"two"}],"evidence":"confirmed"}),
    );
    let mut ar = ready();
    ar["confirmed"] = json!(true);
    run(&mut w, "ar_clarify", ar.clone());
    let mut b = ready();
    b["confirmed"] = json!(true);
    b["groups"] = json!([{"id":"M1","title":"one"},{"id":"M2","title":"two"}]);
    run(&mut w, "module_boundary", b);
    let first = module(&mut w, true);
    assert!(w.graph.vars.get("task").is_none_or(Value::is_null));
    assert_eq!(w.graph.vars["design"], w.graph.vars["srDesign"]);
    assert_eq!(w.graph.vars["srDesign"]["reference"], "artifact");
    let second = module(&mut w, false);
    assert_ne!(first, second);
    assert_eq!(w.graph.phase, "sr_ar_call");
    assert!(w.graph.vars.get("currentModule").is_none_or(Value::is_null));
    assert!(w.graph.vars.get("task").is_none_or(Value::is_null));
    run(&mut w, "ar_clarify", ar);
    let mut b2 = ready();
    b2["confirmed"] = json!(true);
    b2["groups"] = json!([{"id":"M1","title":"same id, different AR"}]);
    run(&mut w, "module_boundary", b2);
    let third = module(&mut w, false);
    assert_ne!(first, third);
    assert_eq!(w.graph.phase, "overall_delivery");
    run(&mut w, "overall_delivery", ready());
    assert!(dispatch(&mut w).is_empty());
    assert_eq!(w.stage, Stage::Completed);
    let calls = w.graph.all_calls();
    assert_eq!(
        calls
            .iter()
            .filter(|c| c.phase == "sr_ar_call" && c.status == "completed")
            .count(),
        2
    );
    assert_eq!(
        calls
            .iter()
            .filter(|c| c.phase == "module_call" && c.status == "completed")
            .count(),
        3
    );
}

#[test]
fn an_incomplete_module_delivery_stops_the_parent_flow() {
    let mut w = flow("ar_init");
    run(
        &mut w,
        "ar_init",
        json!({"status":"ready","confirmed":true,"mode":"split","ars":[{"id":"AR1","title":"one"}],"evidence":"confirmed"}),
    );
    let mut ar = ready();
    ar["confirmed"] = json!(true);
    run(&mut w, "ar_clarify", ar);
    let mut boundary = ready();
    boundary["confirmed"] = json!(true);
    boundary["groups"] = json!([{"id":"M1","title":"one"}]);
    run(&mut w, "module_boundary", boundary);
    module_with_delivery(
        &mut w,
        false,
        json!({"status":"ready","reference":"","evidence":"missing reference"}),
    );
    assert_eq!(w.stage, Stage::Blocked);
    assert!(
        w.outcome.as_ref().unwrap()["reason"]
            .as_str()
            .is_some_and(|reason| !reason.is_empty())
    );
    assert!(
        w.graph
            .all_calls()
            .iter()
            .any(|call| call.phase == "module_call" && call.status == "failed")
    );
}
#[test]
fn no_split_bypasses_ar_clarification_and_direct_ar_requires_confirmation() {
    let mut w = flow("sr_init");
    run(&mut w, "sr_init", ready());
    run(&mut w, "sr_design", ready());
    gate(&mut w, "sr_gate");
    run(
        &mut w,
        "ar_split",
        json!({"status":"ready","confirmed":true,"mode":"no_split","ars":[],"evidence":"confirmed"}),
    );
    assert_eq!(w.graph.phase, "sr_ar_whole_call");
    assert_eq!(w.graph.vars["currentAr"]["id"], "ALL");
    let mut direct = flow("ar_init");
    run(
        &mut direct,
        "ar_init",
        json!({"status":"ready","confirmed":false,"mode":"split","ars":[{"id":"AR1","title":"one"}],"evidence":"unconfirmed"}),
    );
    assert_eq!(direct.stage, Stage::Blocked);
}

#[test]
fn catalog_uses_the_same_ar_scope_for_both_entries_without_showing_unreachable_sr_actions() {
    let sr = flow("sr_init").graph.definition.catalog();
    let ar = flow("ar_init").graph.definition.catalog();
    assert_eq!(sr["structure"]["rootFlow"], "main");
    assert_eq!(ar["structure"]["rootFlow"], "main");
    assert_eq!(
        sr["structure"]["flows"]["ar"],
        ar["structure"]["flows"]["ar"]
    );
    assert!(
        ar["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["id"] == "ar_clarify")
    );
    assert!(
        !ar["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["id"] == "sr_design")
    );
}
