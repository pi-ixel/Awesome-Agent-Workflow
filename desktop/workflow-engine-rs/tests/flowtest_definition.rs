//! 复测用工作流（testdata/aaw-flowtest，见 docs/workflow/flowtest.md）：编译无提醒，
//! 两个起点按设计走完——它是复测的基线，格式或引擎改了它也得照样走通。
use aaw_workflow_core::{Action, ProcessOutput, Stage, Workflow};
use serde_json::{Value, json};

fn compiled() -> aaw_workflow_core::source::Compiled {
    aaw_workflow_core::source::compile_dir(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/aaw-flowtest")).unwrap()
}

fn start(entry: &str, input: Value) -> Workflow {
    Workflow::from_definition(compiled().for_entry(entry, "test").unwrap(), input).unwrap()
}

fn complete(w: &mut Workflow, action: &Action, result: Value) {
    if action.input["__node"]["kind"] == "python" {
        let output = ProcessOutput { exit_code: 0, stdout: result.to_string(), stderr: String::new() };
        w.complete_python(&action.site, action.ordinal, output).unwrap();
    } else {
        w.complete(&action.site, action.ordinal, result).unwrap();
    }
}

/// 只有一个动作在等时：确认它是哪一步并交结果。
fn step(w: &mut Workflow, site: &str, result: Value) -> Action {
    let actions = w.dispatch().unwrap();
    assert_eq!(actions.iter().map(|a| a.site.as_str()).collect::<Vec<_>>(), vec![site]);
    complete(w, &actions[0], result);
    actions[0].clone()
}

#[test]
fn the_flowtest_workflow_compiles_without_warnings() {
    let compiled = compiled();
    assert!(compiled.warnings.is_empty(), "{:?}", compiled.warnings);
}

#[test]
fn the_full_entry_covers_gate_parallel_cards_rework_script_and_handoff() {
    let mut w = start("full", json!({"topic": "水果"}));
    step(&mut w, "ask", json!({"title": "水果清单", "cards": [{"id": "a", "text": "苹果"}, {"id": "b", "text": "香蕉"}]}));
    // 去向要你确认：停在关卡上，放行后才进入制作。
    assert!(w.dispatch().unwrap().is_empty());
    assert_eq!(w.stage, Stage::Waiting);
    let gates = w.gates();
    assert_eq!(gates.len(), 1);
    w.approve(&serde_json::from_value::<Vec<String>>(gates[0]["instance"].clone()).unwrap()).unwrap();
    // 两张卡片并行，各自一个会话。
    let cards = w.dispatch().unwrap();
    assert_eq!(cards.len(), 2, "{cards:?}");
    assert_ne!(cards[0].actor, cards[1].actor, "每张卡片一个会话");
    for (action, id) in cards.iter().zip(["a", "b"]) {
        complete(&mut w, action, json!({"file": format!("trial/flowtest/card-{id}.txt")}));
    }
    let assemble = step(&mut w, "assemble", json!({"file": "trial/flowtest/list.md"}));
    let first_review = step(&mut w, "review", json!({"decision": "revise", "issues": "清单末尾缺少 END 行"}));
    // 整改与汇总是同一个工位（同一会话），再回到同一位评审员。
    let fix = step(&mut w, "fix", json!({"file": "trial/flowtest/list.md"}));
    assert_eq!(fix.actor, assemble.actor);
    let recheck = step(&mut w, "review", json!({"decision": "pass"}));
    assert_eq!(recheck.actor, first_review.actor);
    assert!(recheck.ordinal > first_review.ordinal);
    step(&mut w, "check", json!({"ok": true, "lines": 4}));
    step(&mut w, "handoff", json!({"summary": "做了一份水果清单"}));
    assert_eq!(w.stage, Stage::Completed);
}

#[test]
fn the_block_entry_stops_with_its_explanation_and_handling() {
    let mut w = start("block", json!({}));
    step(&mut w, "block_probe", json!({"status": "stop", "note": "演练阻塞"}));
    assert_eq!(w.stage, Stage::Blocked);
    let outcome = w.outcome.clone().unwrap();
    assert_eq!(outcome["stop"]["phase"], "block_probe", "{outcome}");
    assert_eq!(outcome["stop"]["explain"], "演练要求停下");
    assert!(outcome["reason"].as_str().unwrap().starts_with("这是阻塞演练"));
}

#[test]
fn a_script_that_finds_a_bad_list_blocks_the_run() {
    let mut w = start("full", json!({"topic": "水果"}));
    step(&mut w, "ask", json!({"title": "t", "cards": [{"id": "a", "text": "x"}, {"id": "b", "text": "y"}]}));
    w.dispatch().unwrap();
    let gate: Vec<String> = serde_json::from_value(w.gates()[0]["instance"].clone()).unwrap();
    w.approve(&gate).unwrap();
    for action in w.dispatch().unwrap() {
        complete(&mut w, &action, json!({"file": "f"}));
    }
    step(&mut w, "assemble", json!({"file": "trial/flowtest/list.md"}));
    step(&mut w, "review", json!({"decision": "pass"}));
    step(&mut w, "check", json!({"ok": false, "lines": 3, "problem": "最后一个非空行应是 END"}));
    assert_eq!(w.stage, Stage::Blocked);
    assert_eq!(w.outcome.as_ref().unwrap()["stop"]["explain"], "清单格式不合格");
}
