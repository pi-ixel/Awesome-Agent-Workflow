use aaw_workflow_core::{Stage, Workflow, graph::Definition};
use serde_json::json;

#[test]
fn routing_error_does_not_undo_a_completed_action() {
    let definition: Definition = serde_json::from_value(json!({
        "id":"bad-route", "name":"bad-route", "entry":"work",
        "nodes":{"a":{"kind":"agent","actor":"a","prompt":"a"}},
        "phases":{"work":{"run":["a"],"routes":[{"when":"not-a-boolean","next":"$complete"}]}}
    }))
    .unwrap();
    let mut workflow = Workflow::from_definition(definition, json!({})).unwrap();
    let action = workflow.dispatch().unwrap().pop().unwrap();
    workflow
        .complete("a", action.ordinal, json!({"value":"delivered"}))
        .unwrap();
    assert!(workflow.action("a", action.ordinal).is_none());
    assert_eq!(workflow.graph.latest["a"]["value"], "delivered");
    assert_eq!(workflow.dispatch().unwrap_err(), "CONDITION_NOT_BOOLEAN");
    assert_eq!(workflow.graph.latest["a"]["value"], "delivered");
}

#[test]
fn invalid_subflow_output_does_not_undo_its_completed_action() {
    let definition: Definition = serde_json::from_value(json!({
        "id":"bad-output", "name":"bad-output", "entry":"work",
        "flows":{"main":{"label":"main","entry":"work"},"child":{"label":"child","entry":"inside","outputs":{"invalid":{"object":"not-an-object"}}}},
        "nodes":{"sub":{"kind":"flow","call":"child"},"a":{"kind":"agent","actor":"a","prompt":"a"}},
        "phases":{"work":{"flow":"main","run":["sub"],"routes":[{"next":"$complete"}]},"inside":{"flow":"child","run":["a"],"routes":[{"next":"$return"}]}}
    })).unwrap();
    let mut workflow = Workflow::from_definition(definition, json!({})).unwrap();
    let action = workflow.dispatch().unwrap().pop().unwrap();
    workflow
        .complete("a", action.ordinal, json!({"value":"delivered"}))
        .unwrap();
    assert!(workflow.action("a", action.ordinal).is_none());
    let restored: Workflow =
        serde_json::from_str(&serde_json::to_string(&workflow).unwrap()).unwrap();
    let mut restored = restored;
    assert_eq!(
        restored.dispatch().unwrap_err(),
        "INVALID_OBJECT_EXPRESSION"
    );
    assert!(restored.action("a", action.ordinal).is_none());
}

fn definition() -> Definition {
    serde_json::from_value(json!({"id":"edges","name":"edges","entry":"work",
  "nodes":{"a":{"kind":"agent","actor":"a","prompt":"a"},"b":{"kind":"agent","actor":"b","prompt":"b"},"c":{"kind":"agent","actor":"c","prompt":"c"},"d":{"kind":"agent","actor":"d","prompt":"d"},"e":{"kind":"agent","actor":"e","prompt":"e"}},
  "phases":{"work":{"run":["a","b","c","d","e"],"edges":[{"from":"a","to":"b"},{"from":"a","to":"c"},{"from":"b","to":"d"},{"from":"d","to":"e"},{"from":"c","to":"e"}],"routes":[{"next":"$complete"}]}}})).unwrap()
}
#[test]
fn dependencies_enable_each_node_as_soon_as_its_own_upstream_is_ready() {
    let mut w = Workflow::from_definition(definition(), json!({})).unwrap();
    let a = w.dispatch().unwrap();
    assert_eq!(
        a.iter().map(|x| x.site.as_str()).collect::<Vec<_>>(),
        vec!["a"]
    );
    w.complete("a", a[0].ordinal, json!({"value":"input"}))
        .unwrap();
    let bc = w.dispatch().unwrap();
    assert_eq!(
        bc.iter().map(|x| x.site.as_str()).collect::<Vec<_>>(),
        vec!["b", "c"]
    );
    w.complete("b", bc[0].ordinal, json!({"value":"b"}))
        .unwrap();
    let d = w.dispatch_ready().unwrap();
    assert_eq!(d.len(), 1);
    assert_eq!(d[0].site, "d");
    assert!(w.action("c", bc[1].ordinal).is_some());
    w.complete("d", d[0].ordinal, json!({"value":"d"})).unwrap();
    assert!(w.dispatch_ready().unwrap().is_empty());
    w.complete("c", bc[1].ordinal, json!({"value":"c"}))
        .unwrap();
    let e = w.dispatch().unwrap();
    assert_eq!(e.len(), 1);
    assert_eq!(e[0].site, "e");
    assert_eq!(e[0].input["latest"]["c"]["value"], "c");
    assert_eq!(e[0].input["latest"]["d"]["value"], "d");
    w.complete("e", e[0].ordinal, json!({})).unwrap();
    assert_eq!(w.stage, Stage::Completed);
}
#[test]
fn invalid_or_cyclic_dependencies_are_rejected() {
    let mut d = definition();
    let p = d.phases.get_mut("work").unwrap();
    p.edges.push(aaw_workflow_core::graph::Dependency {
        from: "e".into(),
        to: "a".into(),
        when: None,
        optional: false,
        label: None,
    });
    assert!(d.validate().unwrap_err().starts_with("CYCLIC_DEPENDENCY"));
    let mut d = definition();
    let p = d.phases.get_mut("work").unwrap();
    p.edges.push(aaw_workflow_core::graph::Dependency {
        from: "missing".into(),
        to: "a".into(),
        when: None,
        optional: false,
        label: None,
    });
    assert!(d.validate().unwrap_err().starts_with("INVALID_DEPENDENCY"));
}

#[test]
fn an_unrelated_late_completion_is_not_blamed_for_a_blocked_dependency() {
    let mut d = definition();
    d.nodes
        .get_mut("d")
        .unwrap()
        .requires
        .push(aaw_workflow_core::graph::Requirement {
            condition: json!(false),
            message: "prerequisite missing".into(),
        });
    let mut w = Workflow::from_definition(d, json!({})).unwrap();
    let a = w.dispatch().unwrap();
    w.complete("a", a[0].ordinal, json!({})).unwrap();
    let bc = w.dispatch().unwrap();
    w.complete("b", bc[0].ordinal, json!({})).unwrap();
    assert!(w.dispatch_ready().unwrap().is_empty());
    assert_eq!(w.stage, Stage::Blocked);
    let before = w.outcome.clone().unwrap();
    w.complete("c", bc[1].ordinal, json!({})).unwrap();
    assert_eq!(w.outcome, Some(before.clone()));
    assert!(before.get("siteId").is_none());
    assert!(
        before["reason"]
            .as_str()
            .unwrap()
            .contains("prerequisite missing")
    );
}

#[test]
fn a_subflow_participates_in_the_same_dependency_graph_as_actions() {
    let d:Definition=serde_json::from_value(json!({"id":"mixed-flow","name":"mixed-flow","entry":"work",
  "flows":{"main":{"label":"main","entry":"work"},"child":{"label":"child","entry":"child-work","outputs":{"answer":{"path":"/latest/inside/answer"}}}},
  "nodes":{"a":{"kind":"agent","actor":"a","prompt":"a"},"sub":{"kind":"flow","call":"child","inputs":{"object":{"source":{"path":"/latest/a/value"}}}},"c":{"kind":"agent","actor":"c","prompt":"c"},"d":{"kind":"agent","actor":"d","prompt":"d"},"join":{"kind":"agent","actor":"join","prompt":"join"},"inside":{"kind":"agent","actor":"inside","prompt":"inside"}},
  "phases":{"work":{"flow":"main","run":["a","sub","c","d","join"],"edges":[{"from":"a","to":"sub"},{"from":"a","to":"c"},{"from":"sub","to":"d","when":{"eq":[{"path":"/latest/sub/answer"},"child result"]}},{"from":"c","to":"join"},{"from":"d","to":"join"}],"routes":[{"next":"$complete"}]},
   "child-work":{"flow":"child","run":["inside"],"routes":[{"next":"$return"}]}}})).unwrap();
    let mut w = Workflow::from_definition(d, json!({})).unwrap();
    let a = w.dispatch().unwrap().pop().unwrap();
    w.complete("a", a.ordinal, json!({"value":"hello"}))
        .unwrap();
    let inside = w.dispatch().unwrap().pop().unwrap();
    assert_eq!(inside.site, "inside");
    assert_eq!(inside.input["vars"]["source"], "hello");
    let c = w.dispatch_ready().unwrap().pop().unwrap();
    assert_eq!(c.site, "c");
    let checkpoint = serde_json::to_string(&w).unwrap();
    let mut w: Workflow = serde_json::from_str(&checkpoint).unwrap();
    w.complete("inside", inside.ordinal, json!({"answer":"child result"}))
        .unwrap();
    let d = w.dispatch_ready().unwrap().pop().unwrap();
    assert_eq!(d.site, "d");
    assert_eq!(d.input["latest"]["sub"]["answer"], "child result");
    w.complete("d", d.ordinal, json!({})).unwrap();
    assert!(w.dispatch_ready().unwrap().is_empty());
    w.complete("c", c.ordinal, json!({})).unwrap();
    let join = w.dispatch().unwrap().pop().unwrap();
    assert_eq!(join.site, "join");
    w.complete("join", join.ordinal, json!({})).unwrap();
    assert_eq!(w.stage, Stage::Completed);
    let calls = w.graph.all_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].flow, "child");
    assert_eq!(calls[0].status, "completed");
    assert_eq!(calls[0].output.as_ref().unwrap()["answer"], "child result");
    assert_eq!(inside.input["__callPath"][0], calls[0].id);
}

#[test]
fn a_flow_node_can_contain_dynamic_instances_and_restore_them_from_a_checkpoint() {
    let d:Definition=serde_json::from_value(json!({"id":"composite","name":"composite","entry":"work",
  "flows":{"main":{"label":"main","entry":"work"},"bundle":{"label":"bundle","entry":"expand","outputs":{"items":{"path":"/latest/expand"}}},"leaf":{"label":"leaf","entry":"inside","outputs":{"result":{"path":"/latest/leaf-agent/value"}}}},
  "nodes":{"sub":{"kind":"flow","call":"bundle","inputs":{"path":"/vars/input"}},"other":{"kind":"agent","actor":"other","prompt":"other"},"leaf-agent":{"kind":"agent","actor":"leaf","prompt":"leaf"}},
  "phases":{"work":{"flow":"main","run":["sub","other"],"routes":[{"next":"$complete"}]},"expand":{"flow":"bundle","call":"leaf","foreach":{"items":{"path":"/vars/items"},"maxConcurrency":2},"scope":{"item":{"path":"/item"}},"routes":[{"next":"$return"}]},"inside":{"flow":"leaf","run":["leaf-agent"],"routes":[{"next":"$return"}]}}})).unwrap();
    let mut w = Workflow::from_definition(d, json!({"items":["one","two"]})).unwrap();
    let leaf = w.dispatch().unwrap();
    assert_eq!(leaf.len(), 2);
    let other = w.dispatch_ready().unwrap().pop().unwrap();
    assert_eq!(other.site, "other");
    let saved = serde_json::to_string(&w).unwrap();
    assert_eq!(saved.matches("\"id\":\"composite\"").count(), 1);
    let mut w: Workflow = serde_json::from_str(&saved).unwrap();
    w.complete("other", other.ordinal, json!({})).unwrap();
    for a in leaf.iter().rev() {
        w.complete(
            "leaf-agent",
            a.ordinal,
            json!({"value":a.input["vars"]["item"]}),
        )
        .unwrap();
    }
    assert_eq!(w.stage, Stage::Completed);
    let calls = w.graph.all_calls();
    assert_eq!(calls.len(), 3);
    let parent = calls.iter().find(|c| c.flow == "bundle").unwrap();
    assert_eq!(parent.status, "completed");
    assert_eq!(
        parent.output.as_ref().unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    for call in calls.iter().filter(|c| c.flow == "leaf") {
        assert_eq!(call.parent.as_deref(), Some(parent.id.as_str()));
        assert_eq!(call.status, "completed");
    }
}

#[test]
fn sibling_subflow_nodes_can_run_concurrently_and_keep_separate_results() {
    let d:Definition=serde_json::from_value(json!({"id":"sibling-calls","name":"sibling-calls","entry":"work",
  "flows":{"main":{"label":"main","entry":"work"},"child":{"label":"child","entry":"child-work","outputs":{"result":{"path":"/latest/inside/value"}}}},
  "nodes":{"left":{"kind":"flow","call":"child","inputs":{"literal":{"side":"left"}}},"right":{"kind":"flow","call":"child","inputs":{"literal":{"side":"right"}}},"inside":{"kind":"agent","actor":"inside","prompt":"inside"},"join":{"kind":"agent","actor":"join","prompt":"join"}},
  "phases":{"work":{"flow":"main","run":["left","right","join"],"edges":[{"from":"left","to":"join"},{"from":"right","to":"join"}],"routes":[{"next":"$complete"}]},"child-work":{"flow":"child","run":["inside"],"routes":[{"next":"$return"}]}}})).unwrap();
    let mut w = Workflow::from_definition(d, json!({})).unwrap();
    let first = w.dispatch().unwrap().pop().unwrap();
    let second = w.dispatch_ready().unwrap().pop().unwrap();
    assert_ne!(first.actor, second.actor);
    assert_ne!(first.ordinal, second.ordinal);
    assert_ne!(first.input["__callPath"], second.input["__callPath"]);
    w.complete("inside", second.ordinal, json!({"value":"R"}))
        .unwrap();
    assert!(w.dispatch_ready().unwrap().is_empty());
    w.complete("inside", first.ordinal, json!({"value":"L"}))
        .unwrap();
    let join = w.dispatch().unwrap().pop().unwrap();
    assert_eq!(join.input["latest"]["left"]["result"], "L");
    assert_eq!(join.input["latest"]["right"]["result"], "R");
    w.complete("join", join.ordinal, json!({})).unwrap();
    assert_eq!(w.stage, Stage::Completed);
}

#[test]
fn workflow_result_does_not_depend_on_which_parallel_action_finished_last() {
    let d:Definition=serde_json::from_value(json!({"id":"parallel-output","name":"parallel-output","entry":"both","nodes":{"a":{"kind":"agent","actor":"a","prompt":"a"},"b":{"kind":"agent","actor":"b","prompt":"b"}},"phases":{"both":{"run":["a","b"],"routes":[{"next":"$complete"}]}}})).unwrap();
    let mut w = Workflow::from_definition(d, json!({})).unwrap();
    let actions = w.dispatch().unwrap();
    w.complete("b", actions[1].ordinal, json!({"answer":"B"}))
        .unwrap();
    w.complete("a", actions[0].ordinal, json!({"answer":"A"}))
        .unwrap();
    let result = &w.outcome.as_ref().unwrap()["result"];
    assert_eq!(result["a"]["answer"], "A");
    assert_eq!(result["b"]["answer"], "B");
}
