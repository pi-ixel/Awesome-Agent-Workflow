use super::*;
use serde_json::json;
use std::io::Write;

// Run each mode in a fresh process so its peak working set is measured independently.
#[test]
#[ignore = "local comparison of incremental baseline and CodeAgent JSONL"]
fn compare_turn_costs() {
    let mode = std::env::var("AAW_DIFF_BENCH_MODE").unwrap();
    let tmp = tempfile::tempdir().unwrap();
    let work = tmp.path().join("workspace");
    fs::create_dir(&work).unwrap();
    let root = fs::canonicalize(work).unwrap();
    let cwd = root.to_string_lossy();
    let file_body = "x".repeat(8192);
    for i in 0..2000 {
        fs::write(root.join(format!("{i}.txt")), &file_body).unwrap();
    }
    let db = tmp.path().join("baseline.sqlite");
    let records = tmp.path().join("records");
    let logs = tmp.path().join("logs");
    let project = logs.join(crate::codeagent_history::project_slug(&cwd));
    fs::create_dir_all(&project).unwrap();
    let mut log = File::create(project.join("bench.jsonl")).unwrap();
    writeln!(
        log,
        "{}",
        json!({"type":"system","subtype":"init","sessionId":"bench","cwd":cwd})
    )
    .unwrap();
    let cold = Instant::now();
    if mode == "baseline" {
        project_baseline::lease(&root, &db, "bench").unwrap();
    }
    let cold_ms = cold.elapsed().as_secs_f64() * 1000.;
    let mut prep = Vec::new();
    let mut finish = Vec::new();
    for i in 0..30 {
        let user = format!("p{i}");
        let tool = format!("t{i}");
        let id = uuid::Uuid::new_v4().to_string();
        let req = |action: &str, id: Option<&str>| -> Request {
            serde_json::from_value(json!({
            "action":action,"cwd":cwd,"sessionId":"bench","agentKey":"codeagent","userId":user,
            "id":id,"toolIds":[tool],"status":"completed"}))
            .unwrap()
        };
        let run = |request| {
            execute_project(&records, None, request, |r| {
                project_baseline::freeze(r, &db).map_err(|e| e.to_string())
            })
            .unwrap()
        };
        let before_send = Instant::now();
        let record_id = if mode == "baseline" {
            run(req("begin", None)).remove(0).id
        } else {
            id
        };
        prep.push(before_send.elapsed().as_secs_f64() * 1000.);
        let path = format!("{i}.txt");
        fs::write(root.join(&path), "after").unwrap();
        for row in [
            json!({"type":"user","uuid":user,"isUserPrompt":true,"promptId":user}),
            json!({"type":"assistant","parentUuid":user,"message":{"content":[{"type":"tool_use","id":tool,"name":"Write","input":{"file_path":path,"content":"after"}}]}}),
            json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":tool}]},"toolUseResult":{"originalFile":file_body}}),
        ] {
            writeln!(log, "{row}").unwrap();
        }
        log.flush().unwrap();
        let ended = Instant::now();
        if mode == "baseline" {
            run(req("finish", Some(&record_id)));
        } else {
            assert_eq!(
                record_from(
                    &logs,
                    &root,
                    &records,
                    &Boundary {
                        submitted: Some(user.clone()),
                        ..Default::default()
                    },
                    &req("readJournal", Some(&record_id))
                )
                .unwrap()
                .len(),
                1
            );
        }
        finish.push(ended.elapsed().as_secs_f64() * 1000.);
    }
    prep.sort_by(f64::total_cmp);
    finish.sort_by(f64::total_cmp);
    println!(
        "mode={mode} files=2000 rounds=30 cold_ms={cold_ms:.2} prepare_p95_ms={:.3} finish_p95_ms={:.2}",
        prep[28], finish[28]
    );
    if mode == "baseline" {
        project_baseline::release(&root, "bench", tmp.path(), &db).unwrap();
    }
}
