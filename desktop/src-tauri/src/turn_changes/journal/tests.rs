use super::*;
use serde_json::json;
use std::io::Write;

fn append(file: &Path, row: Value) {
    writeln!(
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(file)
            .unwrap(),
        "{row}"
    )
    .unwrap();
}

fn prompt(file: &Path, uuid: &str, prompt: &str) {
    append(
        file,
        json!({"type":"user","isUserPrompt":true,"uuid":uuid,"promptId":prompt,"message":{"content":"same text"}}),
    );
}

fn write_call(file: &Path, parent: &str, id: &str, path: &str) {
    append(
        file,
        json!({"type":"assistant","parentUuid":parent,"message":{"content":[{"type":"tool_use","name":"Write","id":id,"input":{"file_path":path,"content":"after"}}]}}),
    );
}

fn result(id: &str, failed: bool) -> Value {
    json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":id,"is_error":failed}]},"toolUseResult":{"type":"update","originalFile":"before"}})
}

#[test]
fn one_journal_routes_files_to_the_primary_or_related_root() {
    let temp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap();
    let related = root.join("related");
    fs::create_dir(&related).unwrap();
    let main = root.join("session.jsonl");
    prompt(&main, "p", "turn");
    write_call(&main, "p", "primary", "main.txt");
    append(&main, result("primary", false));
    write_call(&main, "p", "child", "related/library.txt");
    append(&main, result("child", false));
    let ids = ["primary".into(), "child".into()];
    let mut index = Streams::new();
    let primary = collect(
        &main,
        &root,
        None,
        std::slice::from_ref(&related),
        &ids,
        &mut index,
    )
    .unwrap();
    let secondary = collect(&main, &related, Some(&root), &[], &ids, &mut index).unwrap();
    assert_eq!(
        primary.keys().map(String::as_str).collect::<Vec<_>>(),
        ["main.txt"]
    );
    assert_eq!(
        secondary.keys().map(String::as_str).collect::<Vec<_>>(),
        ["library.txt"]
    );
}

#[test]
fn later_flush_appends_only_complete_rows_and_keeps_parallel_children_on_their_prompt() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let main = root.join("session.jsonl");
    prompt(&main, "a", "one");
    write_call(&main, "a", "first", "a.txt");
    append(&main, result("first", false));
    prompt(&main, "b", "two");
    write_call(&main, "b", "second", "second.txt");
    append(&main, result("second", false));
    let subs = root.join("session/subagents");
    fs::create_dir_all(&subs).unwrap();
    let child = subs.join("agent-abc.jsonl");
    prompt(&child, "child-user", "one");
    write_call(&child, "child-user", "child-edit", "child.txt");
    write_call(&child, "child-user", "failed", "failed.txt");
    append(&child, result("failed", true));
    write_call(&child, "child-user", "outside", "../outside");
    append(&child, result("outside", false));
    let mut index = Streams::new();
    let read = |ids: &[&str], index: &mut Streams| {
        collect(
            &main,
            root,
            None,
            &[],
            &ids.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            index,
        )
        .unwrap()
    };
    let first = read(&["first"], &mut index);
    assert_eq!(first.len(), 1);
    let offset = index[&child].offset;
    let mut output = OpenOptions::new().append(true).open(&child).unwrap();
    write!(output, "{}", result("child-edit", false)).unwrap();
    output.flush().unwrap();
    assert_eq!(read(&["first"], &mut index).len(), 1);
    assert_eq!(index[&child].offset, offset);
    writeln!(output).unwrap();
    output.flush().unwrap();
    let first = read(&["first"], &mut index);
    assert_eq!(
        first.keys().cloned().collect::<Vec<_>>(),
        ["a.txt", "child.txt"]
    );
    assert_eq!(read(&["second"], &mut index).len(), 1);
    assert!(read(&["first", "second"], &mut index).is_empty());
    assert!(read(&["unknown"], &mut index).is_empty());
}

#[test]
fn fragments_require_a_full_preimage_to_restore() {
    let op = json!({"name":"Edit","input":{"old_string":"A","new_string":"B"}});
    assert!(!edit(&op, &Value::Null).unwrap().whole);
    assert!(
        !edit(&op, &json!({"toolUseResult":{"originalFile":"A A"}}))
            .unwrap()
            .whole
    );
    let precise = edit(&op, &json!({"toolUseResult":{"originalFile":"A!"}})).unwrap();
    assert!(precise.whole);
    assert_eq!(precise.new, "B!");
    assert!(
        !edit(
            &json!({"name":"Write","input":{"content":"new"}}),
            &Value::Null
        )
        .unwrap()
        .whole
    );
    assert!(edit(&json!({"name":"Bash"}), &Value::Null).is_none());
}

#[test]
fn journal_persists_summary_and_protects_restore_and_undo_against_later_edits() {
    use crate::codeagent_history::project_slug;
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("work");
    fs::create_dir(&root).unwrap();
    let root = fs::canonicalize(root).unwrap();
    let cwd = root.to_string_lossy();
    let logs = tmp.path().join("logs");
    let project = logs.join(project_slug(&cwd));
    fs::create_dir_all(&project).unwrap();
    let sid = "session";
    let main = project.join("session.jsonl");
    append(
        &main,
        json!({"type":"system","subtype":"init","cwd":cwd,"sessionId":sid}),
    );
    prompt(&main, "p", "turn");
    write_call(&main, "p", "op", "f.txt");
    append(&main, result("op", false));
    let id = uuid::Uuid::new_v4().to_string();
    let request:Request=serde_json::from_value(json!({"action":"readJournal","cwd":cwd,"agentKey":"codeagent","sessionId":sid,"userId":"user","id":id,"toolIds":["op"]})).unwrap();
    let dir = tmp.path().join("stored");
    fs::create_dir(&dir).unwrap();
    let boundary = Boundary {
        submitted: Some("user".into()),
        ..Default::default()
    };
    let summary = record_from(&logs, &root, &dir, &boundary, &request)
        .unwrap()
        .remove(0);
    assert!(
        summary.details_deferred
            && summary.files[0].after.is_none()
            && summary.files[0].can_restore
    );
    let path = dir.join(format!("{}.json", summary.id));
    let retry = record_from(&logs, &root, &dir, &boundary, &request).unwrap();
    assert_eq!(retry[0].id, summary.id);
    assert_eq!(records(&dir).len(), 1);
    let mut stored = load(&path).unwrap();
    let file = root.join("f.txt");
    let paths = ["f.txt".into()];
    fs::write(&file, "external").unwrap();
    restore(&root, &path, &mut stored, &paths, false, false).unwrap();
    assert_eq!(stored.record.results[0].status, "conflict");
    fs::write(&file, "after").unwrap();
    restore(&root, &path, &mut stored, &paths, false, false).unwrap();
    assert_eq!(fs::read_to_string(&file).unwrap(), "before");
    restore(&root, &path, &mut stored, &paths, true, false).unwrap();
    assert_eq!(fs::read_to_string(file).unwrap(), "after");

    // A second successful write reverses the first. The net turn must disappear.
    append(
        &main,
        json!({"type":"assistant","parentUuid":"p","message":{"content":[
            {"type":"tool_use","id":"reverse","name":"Write","input":{"file_path":"f.txt","content":"before"}}
        ]}}),
    );
    append(
        &main,
        json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"reverse"}]},
        "toolUseResult":{"originalFile":"after"}}),
    );
    let fresh = tmp.path().join("fresh");
    assert!(
        record_from(&logs, &root, &fresh, &boundary, &request)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn delegation_alone_anchors_child_changes_after_a_long_history() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let main = root.join("session.jsonl");
    let mut log = BufWriter::new(File::create(&main).unwrap());
    for i in 0..8000 {
        writeln!(log, "{}", json!({"type":"user","isUserPrompt":true,"uuid":format!("old{i}"),"promptId":format!("p{i}")})).unwrap();
    }
    log.flush().unwrap();
    drop(log);
    prompt(&main, "anchor", "latest");
    append(
        &main,
        json!({"type":"assistant","parentUuid":"anchor","message":{"content":[{"type":"tool_use","name":"Agent","id":"delegate","input":{}}]}}),
    );
    let mut streams = Streams::new();
    let ids = ["delegate".to_string()];
    assert!(
        collect(&main, root, None, &[], &ids, &mut streams)
            .unwrap()
            .is_empty()
    );
    let old_offset = streams[&main].offset;
    let subs = root.join("session/subagents");
    fs::create_dir_all(&subs).unwrap();
    let child = subs.join("agent-only.jsonl");
    prompt(&child, "child-user", "latest");
    write_call(&child, "child-user", "op", "child.txt");
    append(&child, result("op", false));
    let changes = collect(&main, root, None, &[], &ids, &mut streams).unwrap();
    assert_eq!(streams[&main].offset, old_offset);
    assert_eq!(
        changes.keys().collect::<Vec<_>>(),
        [&"child.txt".to_string()]
    );
    prompt(&main, "next", "different");
    write_call(&main, "next", "delegate", "ambiguous.txt");
    assert!(
        collect(&main, root, None, &[], &ids, &mut streams)
            .unwrap()
            .is_empty()
    );
}
