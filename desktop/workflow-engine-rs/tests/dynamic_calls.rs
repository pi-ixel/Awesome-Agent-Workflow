use aaw_workflow_core::{Stage, Workflow, graph::Definition, journal::Journal};
use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};

fn definition() -> Definition {
    serde_json::from_value(json!({
        "id":"generic-batch","name":"generic-batch","entry":"expand",
        "flows":{
            "main":{"label":"main","entry":"expand"},
            "worker":{"label":"worker","entry":"work","outputs":{"value":{"path":"/latest/work/value"}}}
        },
        "nodes":{
            "work":{"kind":"agent","actor":"worker","prompt":"do work"},
            "finish":{"kind":"agent","actor":"finish","prompt":"collect"}
        },
        "phases":{
            "expand":{"flow":"main","call":"worker","foreach":{"items":{"path":"/vars/input/items"},"maxConcurrency":2},
                "inputs":{"object":{"item":{"path":"/item"},"index":{"path":"/index"}}},
                "scope":{"workItem":{"path":"/item"}},"routes":[{"next":"finish"}]},
            "work":{"flow":"worker","run":["work"],"routes":[{"next":"$return"}]},
            "finish":{"flow":"main","run":["finish"],"routes":[{"next":"$complete"}]}
        }
    })).unwrap()
}
#[test]
fn dynamic_instances_keep_their_identity_and_collect_in_input_order() {
    let mut w =
        Workflow::from_definition(definition(), json!({"items":["one","two","three"]})).unwrap();
    let actions = w.dispatch().unwrap();
    assert_eq!(actions.len(), 2);
    assert_eq!(actions[0].input["vars"]["item"], "one");
    assert_eq!(actions[1].input["vars"]["item"], "two");
    assert_ne!(actions[0].ordinal, actions[1].ordinal);
    assert_ne!(actions[0].actor, actions[1].actor);
    assert_ne!(
        actions[0].input["__callPath"],
        actions[1].input["__callPath"]
    );
    w.complete("work", actions[1].ordinal, json!({"value":"B"}))
        .unwrap();
    let next = w.dispatch_ready().unwrap();
    assert_eq!(next.len(), 1);
    assert_eq!(next[0].input["vars"]["item"], "three");
    assert!(w.action("work", actions[0].ordinal).is_some());
    w.complete("work", next[0].ordinal, json!({"value":"C"}))
        .unwrap();
    w.complete("work", actions[0].ordinal, json!({"value":"A"}))
        .unwrap();
    let finish = w.dispatch().unwrap().pop().unwrap();
    assert_eq!(
        finish.input["latest"]["expand"],
        json!([
            {"item":"one","index":0,"output":{"value":"A"}},
            {"item":"two","index":1,"output":{"value":"B"}},
            {"item":"three","index":2,"output":{"value":"C"}}
        ])
    );
    assert_eq!(
        w.graph
            .all_calls()
            .iter()
            .filter(|c| c.status == "completed")
            .count(),
        3
    );
    w.complete("finish", finish.ordinal, json!({})).unwrap();
    assert_eq!(w.stage, Stage::Completed);
}
#[test]
fn empty_collection_completes_without_inventing_an_instance() {
    let mut w = Workflow::from_definition(definition(), json!({"items":[]})).unwrap();
    let finish = w.dispatch().unwrap().pop().unwrap();
    assert_eq!(finish.site, "finish");
    assert_eq!(finish.input["latest"]["expand"], json!([]));
    assert!(w.graph.all_calls().is_empty());
}
#[test]
fn group_checkpoint_recovers_the_exact_pending_instances() {
    let path = std::env::temp_dir().join(format!(
        "workflow-dynamic-{}-{}.sqlite",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let mut db = Journal::open(&path).unwrap();
    let w = Workflow::from_definition(definition(), json!({"items":["one","two"]})).unwrap();
    db.create("run", "project", &w).unwrap();
    db.claim("run", "project", "owner").unwrap();
    let actions = db.dispatch("run", "project", "owner").unwrap();
    db.complete(
        "run",
        "project",
        "owner",
        "work",
        actions[1].ordinal,
        json!({"value":"B"}),
    )
    .unwrap();
    // The test executor has stopped; the remaining result is unknown.
    db.release("run", "project", "owner").unwrap();
    drop(db);
    let mut db = Journal::open(&path).unwrap();
    let (_, w) = db.load("run", "project").unwrap();
    assert!(w.action("work", actions[0].ordinal).is_some());
    assert!(w.action("work", actions[1].ordinal).is_none());
    assert_eq!(
        w.graph
            .all_calls()
            .iter()
            .filter(|c| c.status == "completed")
            .count(),
        1
    );
    db.claim("run", "project", "recovery-owner").unwrap();
    assert!(
        db.prepare_resume("run", "project", "recovery-owner")
            .is_err()
    );
    db.authorize_retry(
        "run",
        "project",
        "recovery-owner",
        "work",
        actions[0].ordinal,
        "confirmed prior executor stopped",
    )
    .unwrap();
    let resumed = db
        .prepare_resume("run", "project", "recovery-owner")
        .unwrap();
    assert_eq!(resumed.len(), 1);
    assert_eq!(resumed[0].ordinal, actions[0].ordinal);
    db.complete(
        "run",
        "project",
        "recovery-owner",
        "work",
        actions[0].ordinal,
        json!({"value":"A"}),
    )
    .unwrap();
    let action = db
        .dispatch("run", "project", "recovery-owner")
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(action.input["latest"]["expand"][0]["output"]["value"], "A");
    drop(db);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn a_later_failed_precondition_does_not_create_phantom_inflight_actions() {
    let mut d = definition();
    d.nodes
        .get_mut("work")
        .unwrap()
        .requires
        .push(aaw_workflow_core::graph::Requirement {
            condition: json!({"ne":[{"path":"/vars/item"},"two"]}),
            message: "item is not eligible".into(),
        });
    let mut w = Workflow::from_definition(d, json!({"items":["one","two"]})).unwrap();
    assert!(w.dispatch().unwrap().is_empty());
    assert_eq!(w.stage, Stage::Blocked);
    assert!(w.inflight.is_empty());
    assert!(w.ordinals.is_empty());
    let calls = w.graph.all_calls();
    assert_eq!(calls[0].status, "pending");
    assert_eq!(calls[1].status, "failed");
}

#[test]
fn nested_dynamic_instances_have_unique_paths_and_retain_the_full_tree() {
    let d:Definition=serde_json::from_value(json!({"id":"tree","name":"tree","entry":"outer",
      "flows":{"main":{"label":"main","entry":"outer"},"group":{"label":"group","entry":"inner","outputs":{"results":{"path":"/latest/inner"}}},"leaf":{"label":"leaf","entry":"work","outputs":{"result":{"path":"/latest/work/value"}}}},
      "nodes":{"work":{"kind":"agent","actor":"worker","prompt":"work"}},
      "phases":{"outer":{"flow":"main","call":"group","foreach":{"items":{"path":"/vars/input/groups"},"maxConcurrency":2},"scope":{"group":{"path":"/index"}},"routes":[{"next":"$complete"}]},
       "inner":{"flow":"group","call":"leaf","foreach":{"items":{"path":"/vars/item"},"maxConcurrency":2},"scope":{"leaf":{"path":"/item"}},"routes":[{"next":"$return"}]},
       "work":{"flow":"leaf","run":["work"],"routes":[{"next":"$return"}]}}})).unwrap();
    let mut w = Workflow::from_definition(d, json!({"groups":[["a","b"],["c"]]})).unwrap();
    let actions = w.dispatch().unwrap();
    assert_eq!(actions.len(), 3);
    let checkpoint = serde_json::to_string(&w).unwrap();
    assert_eq!(checkpoint.matches("\"id\":\"tree\"").count(), 1);
    let mut w: Workflow = serde_json::from_str(&checkpoint).unwrap();
    for action in actions.iter().rev() {
        let value = action.input["vars"]["item"].clone();
        w.complete("work", action.ordinal, json!({"value":value}))
            .unwrap();
    }
    assert_eq!(w.stage, Stage::Completed);
    let calls = w.graph.all_calls();
    assert_eq!(calls.len(), 5);
    let mut ids = calls.iter().map(|c| c.id.clone()).collect::<Vec<_>>();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 5);
    for action in actions {
        let path = action.input["__callPath"].as_array().unwrap();
        assert_eq!(path.len(), 2);
        let child = calls
            .iter()
            .find(|c| c.id == path[1].as_str().unwrap())
            .unwrap();
        assert_eq!(child.parent.as_deref(), path[0].as_str());
    }
    assert!(calls.iter().all(|c| c.status == "completed"));
}

#[test]
fn sequential_instances_receive_explicit_previous_output_when_they_start() {
    let mut d = definition();
    let p = d.phases.get_mut("expand").unwrap();
    p.foreach.as_mut().unwrap().max_concurrency = 1;
    p.inputs = Some(
        json!({"object":{"item":{"path":"/item"},"prior":{"if":{"condition":{"eq":[{"path":"/index"},0]},"then":"seed","else":{"path":"/previous/output/value"}}}}}),
    );
    let mut w = Workflow::from_definition(d.clone(), json!({"items":["one","two"]})).unwrap();
    let a = w.dispatch().unwrap().pop().unwrap();
    assert_eq!(a.input["vars"]["prior"], "seed");
    assert_eq!(w.graph.all_calls()[1].input, serde_json::Value::Null);
    w.complete("work", a.ordinal, json!({"value":"first-result"}))
        .unwrap();
    let checkpoint = serde_json::to_string(&w).unwrap();
    let mut w: Workflow = serde_json::from_str(&checkpoint).unwrap();
    let b = w.dispatch().unwrap().pop().unwrap();
    assert_eq!(b.input["vars"]["prior"], "first-result");
    w.complete("work", b.ordinal, json!({"value":"second-result"}))
        .unwrap();
    assert_eq!(w.dispatch().unwrap()[0].site, "finish");
    d.phases
        .get_mut("expand")
        .unwrap()
        .foreach
        .as_mut()
        .unwrap()
        .max_concurrency = 2;
    assert!(
        d.validate()
            .unwrap_err()
            .starts_with("PREVIOUS_REQUIRES_SEQUENTIAL_FOREACH")
    );
}
