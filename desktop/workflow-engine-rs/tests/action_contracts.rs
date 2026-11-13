use aaw_workflow_core::{
    Action, ProcessOutput, Stage, Workflow, graph::Definition, prompt::agent_request,
};
use serde_json::{Value, json};
fn definition() -> Definition {
    serde_json::from_str(include_str!("../definitions/aaw-dev.json")).unwrap()
}
#[test]
fn reviewers_have_distinct_node_knowledge_and_generic_outputs_are_supported() {
    let flow = definition();
    let a = &flow.nodes["ask#12"];
    let b = &flow.nodes["ask#13"];
    assert_ne!(a.knowledge_files, b.knowledge_files);
    let action = Action {
        site: "custom".into(),
        ordinal: 1,
        actor: "custom".into(),
        input: json!({"__node":{"kind":"agent","actor":"custom","prompt":"do work"},"vars":{}}),
    };
    let request = agent_request(&action).unwrap();
    assert_eq!(request.schema["type"], "object");
    assert_eq!(request.schema["additionalProperties"], true);
    assert!(request.schema.get("required").is_none());
}
#[test]
fn python_failure_and_unparseable_output_cannot_report_success() {
    for output in [
        ProcessOutput {
            exit_code: 1,
            stdout: String::new(),
            stderr: "failed".into(),
        },
        ProcessOutput {
            exit_code: 0,
            stdout: "not json".into(),
            stderr: String::new(),
        },
    ] {
        let mut workflow =
            Workflow::from_definition(definition(), json!({"requirement":"test"})).unwrap();
        workflow.graph.phase = "scan".into();
        let action = workflow.dispatch().unwrap().pop().unwrap();
        assert!(
            workflow
                .complete(&action.site, action.ordinal, json!({"decision":"pass"}))
                .is_err()
        );
        assert!(
            workflow
                .complete_python(&action.site, action.ordinal, output)
                .is_err()
        );
        assert_eq!(workflow.stage, Stage::Running);
        assert!(workflow.action(&action.site, action.ordinal).is_some());
        assert!(workflow.outcome.is_none());
    }
}
#[test]
fn schema_checks_apply_to_manual_results_too() {
    let mut workflow =
        Workflow::from_definition(definition(), json!({"requirement":"test"})).unwrap();
    let action = workflow.dispatch().unwrap().pop().unwrap();
    assert!(
        workflow
            .complete(&action.site, action.ordinal, json!({"status":"ready"}))
            .is_err()
    );
    assert!(workflow.action(&action.site, action.ordinal).is_some());
    let result: Value =
        json!({"status":"ready","reference":"r","evidence":"e","files":{"values":["one.md"]}});
    workflow
        .complete(&action.site, action.ordinal, result)
        .unwrap();
    assert_eq!(workflow.graph.phase, "design");
}

#[test]
fn retry_authorization_identifies_the_execution_not_only_the_node() {
    let mut workflow =
        Workflow::from_definition(definition(), json!({"requirement":"test"})).unwrap();
    let first = workflow.dispatch().unwrap().pop().unwrap();
    let mut second = first.clone();
    second.ordinal += 1;
    workflow
        .inflight
        .insert(Action::key(&second.site, second.ordinal), second.clone());
    workflow
        .authorize_retry(&first.site, first.ordinal, "checked first instance")
        .unwrap();
    assert!(
        workflow
            .consume_retry(&second.site, second.ordinal)
            .is_err()
    );
    assert_eq!(
        workflow
            .consume_retry(&first.site, first.ordinal)
            .unwrap()
            .ordinal,
        first.ordinal
    );
    assert!(workflow.action(&second.site, second.ordinal).is_some());
}
