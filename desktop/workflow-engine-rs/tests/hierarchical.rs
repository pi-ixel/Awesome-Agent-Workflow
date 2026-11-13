use aaw_workflow_core::{Workflow, graph::Definition, journal::Journal};
use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};

fn definition() -> Definition {
    serde_json::from_value(json!({
        "id":"hierarchical", "name":"Hierarchical", "entry":"review-call",
        "flows":{"main":{"label":"Main","entry":"review-call"},"review":{"label":"Review","entry":"reviews"}},
        "nodes":{"a":{"kind":"agent","actor":"A","prompt":"Review"},"b":{"kind":"agent","actor":"B","prompt":"Review"},"done":{"kind":"agent","actor":"D","prompt":"Finish"}},
        "phases":{
            "review-call":{"flow":"main","call":"review","scope":{"对象":{"path":"/vars/input/item"}},"routes":[{"next":"finish"}]},
            "reviews":{"flow":"review","run":["a","b"],"routes":[{"next":"$return"}]},
            "finish":{"flow":"main","run":["done"],"routes":[{"next":"$complete"}]}
        }
    })).unwrap()
}
#[test]
fn nested_call_and_action_paths_survive_a_journal_reopen() {
    let path = std::env::temp_dir().join(format!(
        "workflow-hierarchy-{}-{}.sqlite",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let mut db = Journal::open(&path).unwrap();
    let workflow = Workflow::from_definition(definition(), json!({"item":"alpha"})).unwrap();
    db.create("run", "project", &workflow).unwrap();
    db.claim("run", "project", "owner").unwrap();
    let actions = db.dispatch("run", "project", "owner").unwrap();
    assert_eq!(actions.len(), 2);
    assert_eq!(actions[0].input["__callPath"], json!(["review-call@1"]));
    db.complete(
        "run",
        "project",
        "owner",
        "a",
        actions[0].ordinal,
        json!({}),
    )
    .unwrap();
    drop(db);
    let mut db = Journal::open(&path).unwrap();
    let (_, saved) = db.load("run", "project").unwrap();
    assert_eq!(saved.graph.stack[0].instance_id, "review-call@1");
    assert_eq!(saved.graph.calls[0].status, "running");
    assert!(
        db.nodes("run", "project")
            .unwrap()
            .iter()
            .all(|n| n.call_path == ["review-call@1"]
                && n.phase_id.as_deref() == Some("reviews")
                && n.scope["对象"] == "alpha")
    );
    db.complete(
        "run",
        "project",
        "owner",
        "b",
        actions[1].ordinal,
        json!({}),
    )
    .unwrap();
    let (_, saved) = db.load("run", "project").unwrap();
    assert!(saved.graph.stack.is_empty());
    assert_eq!(saved.graph.calls[0].status, "completed");
    assert_eq!(
        db.dispatch("run", "project", "owner").unwrap()[0].site,
        "done"
    );
    drop(db);
    std::fs::remove_file(path).unwrap();
}
#[test]
fn rejects_cross_flow_jumps_and_recursive_calls() {
    let mut d = definition();
    d.phases.get_mut("reviews").unwrap().routes[0].next = "finish".into();
    assert!(d.validate().unwrap_err().starts_with("CROSS_FLOW_ROUTE"));
    let mut d = definition();
    let phase = d.phases.get_mut("reviews").unwrap();
    phase.run.clear();
    phase.call = Some("main".into());
    assert_eq!(d.validate().unwrap_err(), "RECURSIVE_SUBFLOW");
}

#[test]
fn actor_contracts_are_checked_within_each_flow_session_scope() {
    let mut d = definition();
    let a = d.nodes.get_mut("a").unwrap();
    a.actor = "D".into();
    a.schema = Some(json!({"type":"object","properties":{"x":{"type":"string"}},"required":["x"]}));
    // The caller's D and child's D have distinct sessions.
    d.validate().unwrap();
    let mut later = d.phases["reviews"].clone();
    later.run = vec!["b".into()];
    d.phases.get_mut("reviews").unwrap().run = vec!["a".into()];
    d.phases.get_mut("reviews").unwrap().routes[0].next = "later".into();
    d.phases.insert("later".into(), later);
    let b = d.nodes.get_mut("b").unwrap();
    b.actor = "D".into();
    assert!(
        d.validate()
            .unwrap_err()
            .starts_with("ACTOR_SCHEMA_CONFLICT:")
    );
}

#[test]
fn visit_limit_is_scoped_to_each_subflow_instance() {
    let d:Definition=serde_json::from_value(json!({"id":"iterations","name":"iterations","entry":"call","initialVars":{"count":0},
      "flows":{"main":{"label":"main","entry":"call"},"worker":{"label":"worker","entry":"work"}},
      "nodes":{"work":{"kind":"agent","actor":"worker","prompt":"work"}},
      "phases":{"call":{"flow":"main","call":"worker","routes":[{"when":{"lt":[{"path":"/vars/count"},1]},"set":{"count":{"add":[{"path":"/vars/count"},1]}},"next":"call"},{"next":"$complete"}]},
      "work":{"flow":"worker","run":["work"],"maxVisits":1,"routes":[{"next":"$return"}]}}})).unwrap();
    let mut w = Workflow::from_definition(d, json!({})).unwrap();
    let mut actors = Vec::new();
    for _ in 0..2 {
        let a = w.dispatch().unwrap().pop().unwrap();
        actors.push(a.actor.clone());
        w.complete(&a.site, a.ordinal, json!({"ok":true})).unwrap();
    }
    assert_eq!(w.stage, aaw_workflow_core::Stage::Completed);
    assert_eq!(w.graph.calls.len(), 2);
    assert_ne!(
        actors[0], actors[1],
        "separate child invocations must not share an ACP session"
    );
}

#[test]
fn subflow_input_and_output_are_isolated_across_checkpoint() {
    let d: Definition = serde_json::from_value(json!({
        "id":"isolated", "name":"isolated", "entry":"call",
        "initialVars":{"private":"parent"},
        "flows":{
            "main":{"label":"main","entry":"call"},
            "child":{"label":"child","entry":"work", "outputs":{"report":{"path":"/latest/work/report"}}}
        },
        "nodes":{
            "work":{"kind":"agent","actor":"work","prompt":"work"},
            "finish":{"kind":"agent","actor":"finish","prompt":"finish"}
        },
        "phases":{
            "call":{"flow":"main","call":"child","inputs":{"object":{"private":{"path":"/vars/private"},"input":{"path":"/vars/input"}}},"routes":[{"set":{"received":{"path":"/latest/report"}},"next":"finish"}]},
            "work":{"flow":"child","run":["work"],"routes":[{"set":{"private":"child"},"next":"$return"}]},
            "finish":{"flow":"main","run":["finish"],"routes":[{"next":"$complete"}]}
        }
    })).unwrap();
    let mut w = Workflow::from_definition(d, json!({"value":"input"})).unwrap();
    w.graph
        .latest
        .insert("previous".into(), json!({"value":"parent-result"}));
    let action = w.dispatch().unwrap().pop().unwrap();
    assert_eq!(action.input["vars"]["private"], "parent");
    assert_eq!(action.input["vars"]["input"]["value"], "input");
    assert!(action.input["latest"].get("previous").is_none());
    // A checkpoint must preserve both sides of the call boundary.
    let checkpoint = serde_json::to_string(&w).unwrap();
    let mut w: Workflow = serde_json::from_str(&checkpoint).unwrap();
    w.complete(
        "work",
        action.ordinal,
        json!({"report":"done","secret":"local"}),
    )
    .unwrap();
    assert_eq!(w.graph.vars["private"], "parent");
    assert_eq!(w.graph.vars["received"], "done");
    assert!(!w.graph.latest.contains_key("work"));
    assert_eq!(w.graph.latest["previous"]["value"], "parent-result");
    assert_eq!(w.graph.calls[0].output, Some(json!({"report":"done"})));
    let finish = w.dispatch().unwrap().pop().unwrap();
    assert_eq!(finish.input["latest"]["report"], "done");
    assert!(finish.input["latest"].get("work").is_none());
}
