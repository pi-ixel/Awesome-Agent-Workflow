use aaw_workflow_core::{Stage, Workflow, graph::Definition, journal::Journal};
use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};

fn definition() -> Definition {
    serde_json::from_value(json!({"id":"conditional","name":"conditional","entry":"work",
  "nodes":{"a":{"kind":"agent","actor":"a","prompt":"a"},"yes":{"kind":"agent","actor":"yes","prompt":"yes"},"no":{"kind":"agent","actor":"no","prompt":"no"},"join":{"kind":"agent","actor":"join","prompt":"join"},"strict":{"kind":"agent","actor":"strict","prompt":"strict"}},
  "phases":{"work":{"run":["a","yes","no","join","strict"],"edges":[
   {"from":"a","to":"yes","when":{"eq":[{"path":"/latest/a/choice"},"yes"]},"label":"yes"},
   {"from":"a","to":"no","when":{"eq":[{"path":"/latest/a/choice"},"no"]},"label":"no"},
   {"from":"yes","to":"join","optional":true},{"from":"no","to":"join","optional":true},
   {"from":"yes","to":"strict"},{"from":"no","to":"strict"}],"routes":[{"next":"$complete"}]}}})).unwrap()
}

#[test]
fn completed_result_is_durable_before_a_route_error() {
    let mut definition = definition();
    let phase = definition.phases.get_mut("work").unwrap();
    phase.run = vec!["a".into()];
    phase.edges.clear();
    phase.routes =
        serde_json::from_value(json!([{"when":"bad-condition","next":"$complete"}])).unwrap();
    let path = std::env::temp_dir().join(format!(
        "workflow-route-{}-{}.sqlite",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let mut db = Journal::open(&path).unwrap();
    let workflow = Workflow::from_definition(definition, json!({})).unwrap();
    db.create("run", "project", &workflow).unwrap();
    db.claim("run", "project", "owner").unwrap();
    let action = db
        .dispatch("run", "project", "owner")
        .unwrap()
        .pop()
        .unwrap();
    db.complete(
        "run",
        "project",
        "owner",
        "a",
        action.ordinal,
        json!({"value":"saved"}),
    )
    .unwrap();
    assert_eq!(
        db.dispatch("run", "project", "owner").unwrap_err(),
        "CONDITION_NOT_BOOLEAN"
    );
    drop(db);
    let db = Journal::open(&path).unwrap();
    let nodes = db.nodes("run", "project").unwrap();
    assert_eq!(nodes[0].status, "completed");
    assert_eq!(nodes[0].result.as_ref().unwrap()["value"], "saved");
    assert!(db.load("run", "project").unwrap().1.inflight.is_empty());
    drop(db);
    std::fs::remove_file(path).unwrap();
}
#[test]
fn optional_merge_runs_but_a_missing_mandatory_predecessor_is_skipped() {
    let mut w = Workflow::from_definition(definition(), json!({})).unwrap();
    let a = w.dispatch().unwrap().pop().unwrap();
    w.complete("a", a.ordinal, json!({"choice":"yes"})).unwrap();
    let yes = w.dispatch().unwrap();
    assert_eq!(yes.len(), 1);
    assert_eq!(yes[0].site, "yes");
    assert_eq!(
        w.graph
            .all_skipped()
            .iter()
            .map(|r| r.site.as_str())
            .collect::<Vec<_>>(),
        vec!["no"]
    );
    w.complete("yes", yes[0].ordinal, json!({"value":"ok"}))
        .unwrap();
    let join = w.dispatch().unwrap();
    assert_eq!(join.len(), 1);
    assert_eq!(join[0].site, "join");
    assert_eq!(
        w.graph
            .all_skipped()
            .iter()
            .map(|r| r.site.as_str())
            .collect::<Vec<_>>(),
        vec!["no", "strict"]
    );
    w.complete("join", join[0].ordinal, json!({})).unwrap();
    assert_eq!(w.stage, Stage::Completed);
}
#[test]
fn a_skipped_branch_and_its_call_path_are_durable() {
    let path = std::env::temp_dir().join(format!(
        "workflow-edges-{}-{}.sqlite",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let mut db = Journal::open(&path).unwrap();
    let w = Workflow::from_definition(definition(), json!({})).unwrap();
    db.create("run", "project", &w).unwrap();
    db.claim("run", "project", "owner").unwrap();
    let a = db
        .dispatch("run", "project", "owner")
        .unwrap()
        .pop()
        .unwrap();
    db.complete(
        "run",
        "project",
        "owner",
        "a",
        a.ordinal,
        json!({"choice":"yes"}),
    )
    .unwrap();
    let yes = db
        .dispatch("run", "project", "owner")
        .unwrap()
        .pop()
        .unwrap();
    let no = db
        .nodes("run", "project")
        .unwrap()
        .into_iter()
        .find(|n| n.site_id == "no")
        .unwrap();
    assert_eq!(no.status, "skipped");
    assert_eq!(no.phase_id.as_deref(), Some("work"));
    assert!(no.call_path.is_empty());
    db.complete("run", "project", "owner", "yes", yes.ordinal, json!({}))
        .unwrap();
    let join = db
        .dispatch("run", "project", "owner")
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(join.site, "join");
    drop(db);
    let mut db = Journal::open(&path).unwrap();
    let strict = db
        .nodes("run", "project")
        .unwrap()
        .into_iter()
        .find(|n| n.site_id == "strict")
        .unwrap();
    assert_eq!(strict.status, "skipped");
    db.complete("run", "project", "owner", "join", join.ordinal, json!({}))
        .unwrap();
    assert_eq!(db.load("run", "project").unwrap().1.stage, Stage::Completed);
    drop(db);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn skipped_nodes_do_not_leak_results_from_an_earlier_loop_iteration() {
    let mut d = definition();
    d.initial_vars.insert("iteration".into(), json!(0));
    let p = d.phases.get_mut("work").unwrap();
    p.routes=serde_json::from_value(json!([{"when":{"lt":[{"path":"/vars/iteration"},1]},"set":{"iteration":{"add":[{"path":"/vars/iteration"},1]}},"next":"work"},{"next":"$complete"}])).unwrap();
    let mut w = Workflow::from_definition(d, json!({})).unwrap();
    let a = w.dispatch().unwrap().pop().unwrap();
    w.complete("a", a.ordinal, json!({"choice":"yes"})).unwrap();
    let yes = w.dispatch().unwrap().pop().unwrap();
    w.complete("yes", yes.ordinal, json!({"value":"old"}))
        .unwrap();
    let join = w.dispatch().unwrap().pop().unwrap();
    w.complete("join", join.ordinal, json!({})).unwrap();
    let a = w.dispatch().unwrap().pop().unwrap();
    w.complete("a", a.ordinal, json!({"choice":"no"})).unwrap();
    let no = w.dispatch().unwrap().pop().unwrap();
    assert_eq!(no.site, "no");
    w.complete("no", no.ordinal, json!({"value":"current"}))
        .unwrap();
    let join = w.dispatch().unwrap().pop().unwrap();
    assert_eq!(join.site, "join");
    assert!(join.input["latest"].get("yes").is_none());
    assert_eq!(join.input["latest"]["no"]["value"], "current");
    w.complete("join", join.ordinal, json!({})).unwrap();
    assert_eq!(w.stage, Stage::Completed);
}

#[test]
fn skipped_nodes_inside_a_subflow_keep_their_parent_path_after_completion() {
    let mut raw = serde_json::to_value(definition()).unwrap();
    raw["entry"] = json!("root");
    raw["flows"] =
        json!({"main":{"label":"main","entry":"root"},"child":{"label":"child","entry":"work"}});
    raw["nodes"]["sub"] = json!({"kind":"flow","call":"child"});
    raw["phases"]["root"] = json!({"flow":"main","run":["sub"],"routes":[{"next":"$complete"}]});
    raw["phases"]["work"]["flow"] = json!("child");
    raw["phases"]["work"]["routes"] = json!([{"next":"$return"}]);
    let d: Definition = serde_json::from_value(raw).unwrap();
    let path = std::env::temp_dir().join(format!(
        "workflow-child-skips-{}-{}.sqlite",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let mut db = Journal::open(&path).unwrap();
    let w = Workflow::from_definition(d, json!({})).unwrap();
    db.create("run", "project", &w).unwrap();
    db.claim("run", "project", "owner").unwrap();
    let a = db
        .dispatch("run", "project", "owner")
        .unwrap()
        .pop()
        .unwrap();
    let parent = a.input["__callPath"][0].as_str().unwrap().to_string();
    db.complete(
        "run",
        "project",
        "owner",
        "a",
        a.ordinal,
        json!({"choice":"yes"}),
    )
    .unwrap();
    let yes = db
        .dispatch("run", "project", "owner")
        .unwrap()
        .pop()
        .unwrap();
    db.complete("run", "project", "owner", "yes", yes.ordinal, json!({}))
        .unwrap();
    let join = db
        .dispatch("run", "project", "owner")
        .unwrap()
        .pop()
        .unwrap();
    db.complete("run", "project", "owner", "join", join.ordinal, json!({}))
        .unwrap();
    let (_, w) = db.load("run", "project").unwrap();
    assert_eq!(w.stage, Stage::Completed);
    let skips = w.graph.all_skipped();
    assert_eq!(skips.len(), 2);
    assert!(skips.iter().all(|r| r.call_path == [parent.clone()]));
    let records = db.nodes("run", "project").unwrap();
    assert_eq!(
        records
            .iter()
            .filter(|n| n.status == "skipped" && n.call_path == [parent.clone()])
            .count(),
        2
    );
    drop(db);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn an_invalid_edge_condition_does_not_reclassify_the_completed_source_as_failed() {
    let mut d = definition();
    d.phases.get_mut("work").unwrap().edges[0].when = Some(json!("not-a-boolean"));
    let path = std::env::temp_dir().join(format!(
        "workflow-invalid-edge-{}-{}.sqlite",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let mut db = Journal::open(&path).unwrap();
    let w = Workflow::from_definition(d, json!({})).unwrap();
    db.create("run", "project", &w).unwrap();
    db.claim("run", "project", "owner").unwrap();
    let a = db
        .dispatch("run", "project", "owner")
        .unwrap()
        .pop()
        .unwrap();
    db.complete(
        "run",
        "project",
        "owner",
        "a",
        a.ordinal,
        json!({"choice":"yes"}),
    )
    .unwrap();
    assert_eq!(
        db.dispatch("run", "project", "owner").unwrap_err(),
        "CONDITION_NOT_BOOLEAN"
    );
    let records = db.nodes("run", "project").unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].status, "completed");
    drop(db);
    std::fs::remove_file(path).unwrap();
}
