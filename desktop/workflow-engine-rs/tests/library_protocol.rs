//! 工作流库请求（workflows / workflow / workflow-copy / workflow-delete）与
//! 按起点启动时的输入校验，经真实服务进程验证。不需要 Agent 或 Python。
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU32, Ordering},
        mpsc::{self, Receiver},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

struct Service {
    child: Child,
    input: ChildStdin,
    output: Receiver<Value>,
    next: u64,
    dir: std::path::PathBuf,
}

impl Service {
    fn start() -> Self {
        Self::start_with_mode(false)
    }
    fn start_with_mode(native: bool) -> Self {
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "aaw-library-{}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(dir.join("project")).unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_workflow_service"));
        command.arg(dir.join("data").join("workflow-runs.sqlite"))
            .stdin(Stdio::piped()).stdout(Stdio::piped());
        if native { command.arg("--session-host=native"); }
        let mut child = command.spawn().unwrap();
        let input = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, output) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    if tx.send(value).is_err() {
                        break;
                    }
                }
            }
        });
        let ready = output.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(ready["type"], "ready");
        Self { child, input, output, next: 1, dir }
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next;
        self.next += 1;
        writeln!(self.input, "{}", json!({"id": id, "method": method, "params": params})).unwrap();
        self.input.flush().unwrap();
        loop {
            let message = self.output.recv_timeout(Duration::from_secs(20)).unwrap();
            if message["type"] == "response" && message["id"] == id {
                return match message.get("error") {
                    Some(error) => Err(error.as_str().unwrap_or_default().to_owned()),
                    None => Ok(message["result"].clone()),
                };
            }
        }
    }
}

fn preflight_item<'a>(report: &'a Value, id: &str) -> &'a Value {
    report["items"].as_array().unwrap().iter().find(|item| item["id"] == id).unwrap()
}

#[test]
fn preflight_checks_agent_without_creating_a_run_or_requiring_python() {
    let mut service = Service::start();
    let project = service.dir.join("project");
    let command = std::env::current_exe().unwrap();
    let input = json!({"cwd": project, "workflow":"aaw-dev", "entry":"dev", "inputs":{}, "command":[command], "python":"aaw-missing-python", "mcpServers":[]});
    let report = service.request("preflight", json!({"input":input})).unwrap();
    assert_eq!(preflight_item(&report, "agent")["status"], "pass");
    assert_eq!(preflight_item(&report, "question_tracker")["status"], "pass");
    assert_eq!(preflight_item(&report, "workflow")["status"], "pass");
    assert!(!report["items"].as_array().unwrap().iter().any(|item| item["id"].as_str().unwrap().starts_with("python")));
    assert!(report["configuration"].as_str().is_some_and(|value| value.len() == 64));
    assert_eq!(service.request("list", json!({"cwd": project})).unwrap(), json!([]));
}

#[test]
fn agent_is_checked_again_at_start_before_creating_a_run() {
    let mut service = Service::start();
    let project = service.dir.join("project");
    let executable = project.join(if cfg!(windows) { "agent.exe" } else { "agent" });
    std::fs::write(&executable, "fixture").unwrap();
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap(); }
    let mut input = json!({"cwd": project, "workflow":"aaw-dev", "entry":"dev", "inputs":{"requirement":"x"}, "command":[executable], "mcpServers":[]});
    let report = service.request("preflight", json!({"input":input})).unwrap();
    assert_eq!(preflight_item(&report, "agent")["status"], "pass");
    input["expectedRevision"] = report["revision"].clone();
    input["expectedConfiguration"] = report["configuration"].clone();
    std::fs::remove_file(executable).unwrap();
    assert_eq!(service.request("start", json!({"input":input})).unwrap_err(), "PREFLIGHT_FAILED:agent");
    assert_eq!(service.request("list", json!({"cwd": project})).unwrap(), json!([]));
}

#[test]
#[ignore = "requires Python; verifies the selected entry does not need an unreachable Agent"]
fn python_only_entry_runs_without_an_agent_even_if_another_entry_has_one() {
    let mut service = Service::start();
    let project = service.dir.join("project");
    std::fs::write(project.join("task.py"), "print('{}')\n").unwrap();
    let definition = json!({"id":"test", "name":"Test", "entry":"python_entry", "nodes":{
        "task":{"kind":"python", "actor":"task", "script":"task.py"},
        "other":{"kind":"agent", "actor":"other", "prompt":"work"}
    }, "phases":{
        "python_entry":{"run":["task"],"routes":[{"next":"$complete"}]},
        "agent_entry":{"run":["other"],"routes":[{"next":"$complete"}]}
    }});
    let input = json!({"cwd": project, "inputs":{}, "definition":definition, "mcpServers":[]});
    let report = service.request("preflight", json!({"input":input})).unwrap();
    assert_eq!(preflight_item(&report, "python")["status"], "pass");
    assert!(!report["items"].as_array().unwrap().iter().any(|item| item["id"] == "agent" || item["id"] == "question_tracker"));
    let started = service.request("start-flow", json!({"input":input})).unwrap();
    let run_id = started["runId"].as_str().unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        let snapshot = service.request("snapshot", json!({"runId":run_id, "cwd":project})).unwrap();
        if snapshot["run"]["status"] == "completed" { break; }
        assert!(std::time::Instant::now() < deadline, "{snapshot}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn required_python_and_missing_script_block_before_any_run_is_created() {
    let mut service = Service::start();
    let project = service.dir.join("project");
    std::fs::write(project.join("task.py"), "print('{}')\n").unwrap();
    let definition = json!({"id":"test", "name":"Test", "entry":"work", "nodes":{"task":{"kind":"python", "actor":"task", "script":"task.py"}}, "phases":{"work":{"run":["task"],"routes":[{"next":"$complete"}]}}});
    let input = json!({"cwd": project, "inputs":{}, "definition": definition, "python":"aaw-missing-python", "mcpServers":[]});
    let report = service.request("preflight", json!({"input":input})).unwrap();
    assert_eq!(preflight_item(&report, "python")["status"], "fail");
    assert_eq!(service.request("start-flow", json!({"input":input})).unwrap_err(), "PREFLIGHT_FAILED:python");
    assert_eq!(service.request("list", json!({"cwd": project})).unwrap(), json!([]));
    std::fs::remove_file(project.join("task.py")).unwrap();
    let report = service.request("preflight", json!({"input":input})).unwrap();
    assert_eq!(preflight_item(&report, "workflow")["status"], "fail");
    assert_eq!(service.request("start-flow", json!({"input":input})).unwrap_err(), "PYTHON_SCRIPT_UNAVAILABLE:task.py");
}

#[test]
fn conditional_python_warns_and_start_rechecks_configuration_and_confirmation() {
    let mut service = Service::start_with_mode(true);
    let project = service.dir.join("project");
    std::fs::write(project.join("task.py"), "print('{}')\n").unwrap();
    let definition = json!({"id":"test", "name":"Test", "entry":"first", "initialVars":{"flag":false}, "nodes":{
        "agent":{"kind":"agent", "actor":"agent", "prompt":"work"},
        "task":{"kind":"python", "actor":"task", "script":"task.py"}
    }, "phases":{
        "first":{"run":["agent"],"routes":[{"when":{"path":"/vars/flag"},"next":"later"},{"next":"$complete"}]},
        "later":{"run":["task"],"routes":[{"next":"$complete"}]}
    }});
    let command = std::env::current_exe().unwrap();
    let mut input = json!({"cwd": project, "inputs":{}, "definition":definition, "command":[command], "python":"aaw-missing-python", "mcpServers":[]});
    let report = service.request("preflight", json!({"input":input})).unwrap();
    assert_eq!(preflight_item(&report, "python_conditional")["status"], "warn");
    assert_eq!(service.request("start-flow", json!({"input":input})).unwrap_err(), "PREFLIGHT_WARNING_CONFIRMATION_REQUIRED");
    input["acceptedWarnings"] = json!(["python_conditional"]);
    input["expectedConfiguration"] = json!("changed");
    assert_eq!(service.request("start-flow", json!({"input":input})).unwrap_err(), "PREFLIGHT_CONFIGURATION_CHANGED");
    assert_eq!(service.request("list", json!({"cwd": project})).unwrap(), json!([]));
    input["expectedConfiguration"] = report["configuration"].clone();
    let started = service.request("start-flow", json!({"input":input})).unwrap();
    assert!(started["runId"].as_str().is_some());
}

impl Drop for Service {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn ids(list: &Value) -> Vec<(String, String)> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|item| (item["id"].as_str().unwrap().to_owned(), item["origin"].as_str().unwrap().to_owned()))
        .collect()
}

#[test]
fn presets_are_listed_described_copied_and_protected() {
    let mut service = Service::start();
    let list = service.request("workflows", json!({})).unwrap();
    assert_eq!(ids(&list), [("aaw-dev".into(), "preset".into()), ("aaw-enterprise".into(), "preset".into())]);
    for item in list.as_array().unwrap() {
        assert!(item["meta"].is_object(), "预置工作流应当编译通过：{item}");
        assert_eq!(item["diagnostics"], json!([]), "{item}");
    }

    // 详情：每个起点一份画布目录，带源码文件；起点决定画布入口。
    let detail = service.request("workflow", json!({"id": "aaw-enterprise"})).unwrap();
    let entries: Vec<&str> = detail["meta"]["entries"].as_array().unwrap().iter().map(|e| e["id"].as_str().unwrap()).collect();
    assert_eq!(entries, ["sr", "ar"]);
    assert_eq!(detail["catalogs"]["sr"]["entry"], "sr_init");
    assert_eq!(detail["catalogs"]["ar"]["entry"], "ar_init");
    assert_eq!(detail["catalogs"]["sr"]["revision"], detail["meta"]["revision"]);
    let files: Vec<&str> = detail["files"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap()).collect();
    assert!(files.contains(&"workflow.yaml") && files.contains(&"flows/main.yaml"), "{files:?}");

    // 复制为我的：换 id，名称加「（副本）」；预置的不能删，我的可以删。
    let copied = service.request("workflow-copy", json!({"id": "aaw-dev"})).unwrap();
    assert_eq!(copied["id"], "aaw-dev-copy");
    let list = service.request("workflows", json!({})).unwrap();
    let copy = list.as_array().unwrap().iter().find(|item| item["id"] == "aaw-dev-copy").unwrap();
    assert_eq!(copy["origin"], "user");
    assert_eq!(copy["meta"]["name"], "AAW 轻量开发（副本）");
    assert_eq!(service.request("workflow-copy", json!({"id": "aaw-dev"})).unwrap()["id"], "aaw-dev-copy-2");
    assert_eq!(service.request("workflow-delete", json!({"id": "aaw-dev"})).unwrap_err(), "WORKFLOW_PRESET_READ_ONLY");
    service.request("workflow-delete", json!({"id": "aaw-dev-copy"})).unwrap();
    assert!(service.request("workflow", json!({"id": "aaw-dev-copy"})).is_err());
}

#[test]
fn a_broken_copy_is_listed_with_diagnostics_and_cannot_start() {
    let mut service = Service::start();
    service.request("workflow-copy", json!({"id": "aaw-dev"})).unwrap();
    let main = service.dir.join("data/workflows/aaw-dev-copy/flows/main.yaml");
    let text = std::fs::read_to_string(&main).unwrap();
    std::fs::write(&main, text.replacen("- to: design\n", "- to: desing\n", 1)).unwrap();
    let list = service.request("workflows", json!({})).unwrap();
    let broken = list.as_array().unwrap().iter().find(|item| item["id"] == "aaw-dev-copy").unwrap();
    assert!(broken["meta"].is_null());
    let first = &broken["diagnostics"][0];
    assert_eq!(first["file"], "flows/main.yaml");
    assert!(first["line"].as_u64().is_some(), "{first}");
    assert!(first["message"].as_str().unwrap().contains("去向「desing」"), "{first}");

    let project = service.dir.join("project");
    let error = service
        .request("start", json!({"input": {"cwd": project, "workflow": "aaw-dev-copy", "entry": "dev", "inputs": {"requirement": "x"}, "command": ["agent"], "mcpServers": []}}))
        .unwrap_err();
    assert!(error.starts_with("WORKFLOW_INVALID:"), "{error}");
}

#[test]
fn start_checks_the_entry_and_its_required_inputs() {
    let mut service = Service::start();
    let project = service.dir.join("project");
    let start = |entry: &str, inputs: Value| json!({"input": {"cwd": project, "workflow": "aaw-enterprise", "entry": entry, "inputs": inputs, "command": ["agent"], "mcpServers": []}});
    assert_eq!(service.request("start", start("nope", json!({"requirement": "x"}))).unwrap_err(), "WORKFLOW_ENTRY_UNKNOWN");
    assert_eq!(service.request("start", start("ar", json!({}))).unwrap_err(), "WORKFLOW_INPUT_REQUIRED:requirement");
    assert_eq!(service.request("start", start("ar", json!({"requirement": "   "}))).unwrap_err(), "WORKFLOW_INPUT_REQUIRED:requirement");
}

/// 分享与信任（ADR 036）：导出再导入能还原；导入的脚本确认信任前不能启动，改动后要重新确认；
/// 复制预置时自动信任；不安全的路径拒绝导入。
#[test]
fn imported_scripts_must_be_trusted_before_a_run_starts() {
    let mut service = Service::start();
    let project = service.dir.join("project");
    let manifest = "format: aaw-workflow/1\nid: shared\nname: 分享的流程\nentries:\n  - id: go\n    label: 开始\n    start: task\n";
    let flow = "label: 主流程\nentry: task\nsteps:\n  task:\n    python:\n      label: 检查\n      script: scripts/task.py\n    next:\n      - to: $complete\n";
    let package = json!({"format": "aaw-workflow-package/1", "id": "shared", "files": {
        "workflow.yaml": manifest, "flows/main.yaml": flow, "scripts/task.py": "print('{}')\n"
    }});

    let preview = service.request("workflow-import", json!({"package": package, "preview": true})).unwrap();
    assert_eq!(preview["id"], "shared");
    assert_eq!(preview["scripts"], json!(["scripts/task.py"]));
    assert_eq!(service.request("workflow", json!({"id": "shared"})).unwrap_err(), "WORKFLOW_NOT_FOUND", "预览不写入");

    let imported = service.request("workflow-import", json!({"package": package})).unwrap();
    assert_eq!(imported["id"], "shared");
    let second = service.request("workflow-import", json!({"package": package})).unwrap();
    assert_eq!(second["id"], "shared-2", "id 冲突时换一个");

    let detail = service.request("workflow", json!({"id": "shared"})).unwrap();
    assert_eq!(detail["scripts"], json!([{"path": "scripts/task.py", "trusted": false}]));
    let input = json!({"cwd": project, "workflow": "shared", "entry": "go", "inputs": {}, "python": "aaw-missing-python", "mcpServers": []});
    let report = service.request("preflight", json!({"input": input})).unwrap();
    assert_eq!(preflight_item(&report, "scripts")["status"], "fail");
    assert!(preflight_item(&report, "scripts")["message"].as_str().unwrap().contains("scripts/task.py"));
    assert!(service.request("start", json!({"input": input})).unwrap_err().starts_with("WORKFLOW_SCRIPTS_UNTRUSTED:"));

    service.request("workflow-trust", json!({"id": "shared"})).unwrap();
    let detail = service.request("workflow", json!({"id": "shared"})).unwrap();
    assert_eq!(detail["scripts"][0]["trusted"], true);
    let report = service.request("preflight", json!({"input": input})).unwrap();
    assert!(report["items"].as_array().unwrap().iter().all(|item| item["id"] != "scripts"));

    // 在应用外改了脚本：需要重新确认。
    std::fs::write(service.dir.join("data/workflows/shared/scripts/task.py"), "print('changed')\n").unwrap();
    let detail = service.request("workflow", json!({"id": "shared"})).unwrap();
    assert_eq!(detail["scripts"][0]["trusted"], false);

    // 导出能原样还原。
    let exported = service.request("workflow-export", json!({"id": "shared-2"})).unwrap();
    assert_eq!(exported["format"], "aaw-workflow-package/1");
    assert_eq!(exported["files"]["scripts/task.py"], "print('{}')\n");

    // 复制已信任的工作流：副本同样可信。
    service.request("workflow-trust", json!({"id": "shared-2"})).unwrap();
    let copy = service.request("workflow-copy", json!({"id": "shared-2"})).unwrap();
    let copied = service.request("workflow", json!({"id": copy["id"]})).unwrap();
    assert_eq!(copied["scripts"][0]["trusted"], true);

    let mut unsafe_package = package.clone();
    unsafe_package["files"]["../escape.py"] = json!("x");
    assert!(service.request("workflow-import", json!({"package": unsafe_package})).unwrap_err().starts_with("WORKFLOW_PATH_INVALID"));
    assert_eq!(service.request("workflow-import", json!({"package": {"format": "other"}})).unwrap_err(), "WORKFLOW_PACKAGE_INVALID");
}

/// AI 编辑的草稿（ADR 036）：预置不能直接改；草稿编译出错时报出位置；保存替换原工作流且不带走编写规则；
/// 新建按定义里的 id 保存；放弃删除草稿。
#[test]
fn drafts_are_checked_saved_and_discarded() {
    let mut service = Service::start();
    assert_eq!(service.request("draft-create", json!({"base": "aaw-dev"})).unwrap_err(), "WORKFLOW_PRESET_READ_ONLY");
    let copy = service.request("workflow-copy", json!({"id": "aaw-dev"})).unwrap()["id"].as_str().unwrap().to_owned();

    let draft = service.request("draft-create", json!({"base": copy})).unwrap();
    let draft_id = draft["draftId"].as_str().unwrap().to_owned();
    let dir = std::path::PathBuf::from(draft["dir"].as_str().unwrap());
    assert!(dir.join(".guide/workflow-format.md").is_file(), "编写规则随草稿给 Agent");
    let checked = service.request("draft-check", json!({"draftId": draft_id})).unwrap();
    assert_eq!(checked["ok"], true);
    assert_eq!(checked["changes"], json!([]));
    let listed = service.request("drafts", json!({})).unwrap();
    assert_eq!(listed[0]["base"], json!(copy));
    assert_eq!(listed[0]["changes"], 0);
    assert_eq!(listed[0]["ok"], true);
    // 同一个工作流只保留一份草稿：再次打开回到原来那份；没有改动时不能保存。
    assert_eq!(service.request("draft-create", json!({"base": copy})).unwrap()["draftId"], json!(draft_id));
    assert_eq!(service.request("draft-save", json!({"draftId": draft_id})).unwrap_err(), "DRAFT_UNCHANGED");

    // Agent 改坏了：报出文件与行号，不能保存。
    let manifest = std::fs::read_to_string(dir.join("workflow.yaml")).unwrap();
    std::fs::write(dir.join("workflow.yaml"), manifest.replace("name:", "nmae:")).unwrap();
    let broken = service.request("draft-check", json!({"draftId": draft_id})).unwrap();
    assert_eq!(broken["ok"], false);
    assert_eq!(broken["diagnostics"][0]["file"], "workflow.yaml");
    assert_eq!(broken["changes"][0]["status"], "modified");
    assert_eq!(service.request("draft-save", json!({"draftId": draft_id})).unwrap_err(), "WORKFLOW_INVALID");

    // 改好了：保存替换原工作流，草稿删除，编写规则不进工作流。
    let renamed = manifest.lines().map(|l| if l.starts_with("name:") { "name: 改过的流程".to_owned() } else { l.to_owned() }).collect::<Vec<_>>().join("\n") + "\n";
    std::fs::write(dir.join("workflow.yaml"), renamed).unwrap();
    std::fs::write(dir.join("notes.md"), "说明\n").unwrap();
    let fixed = service.request("draft-check", json!({"draftId": draft_id})).unwrap();
    assert_eq!(fixed["ok"], true);
    let statuses: Vec<(String, String)> = fixed["changes"].as_array().unwrap().iter().map(|c| (c["path"].as_str().unwrap().to_owned(), c["status"].as_str().unwrap().to_owned())).collect();
    assert_eq!(statuses, vec![("notes.md".to_owned(), "added".to_owned()), ("workflow.yaml".to_owned(), "modified".to_owned())]);
    assert_eq!(service.request("draft-save", json!({"draftId": draft_id})).unwrap()["id"], json!(copy));
    let detail = service.request("workflow", json!({"id": copy})).unwrap();
    assert_eq!(detail["meta"]["name"], "改过的流程");
    let paths: Vec<&str> = detail["files"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap()).collect();
    assert!(paths.contains(&"notes.md") && !paths.iter().any(|p| p.starts_with(".guide")), "{paths:?}");
    assert!(!dir.exists(), "保存后删掉草稿");

    // 新建：起步模板能编译，但一点没改不能保存；改过之后按定义里的 id 保存。
    let blank = service.request("draft-create", json!({})).unwrap();
    let blank_id = blank["draftId"].as_str().unwrap().to_owned();
    let blank_dir = std::path::PathBuf::from(blank["dir"].as_str().unwrap());
    let checked = service.request("draft-check", json!({"draftId": blank_id})).unwrap();
    assert_eq!(checked["ok"], true);
    assert_eq!(checked["changes"], json!([]));
    assert_eq!(service.request("draft-save", json!({"draftId": blank_id})).unwrap_err(), "DRAFT_UNCHANGED");
    let manifest = std::fs::read_to_string(blank_dir.join("workflow.yaml")).unwrap();
    std::fs::write(blank_dir.join("workflow.yaml"), manifest.replace("name: 我的工作流", "name: 设计评审流程")).unwrap();
    assert_eq!(service.request("draft-check", json!({"draftId": blank_id})).unwrap()["changes"][0]["status"], "modified");
    assert_eq!(service.request("draft-save", json!({"draftId": blank_id})).unwrap()["id"], "my-workflow");

    // 放弃。
    let other = service.request("draft-create", json!({"base": copy})).unwrap();
    let other_id = other["draftId"].as_str().unwrap().to_owned();
    service.request("draft-discard", json!({"draftId": other_id})).unwrap();
    assert_eq!(service.request("draft-check", json!({"draftId": other_id})).unwrap_err(), "DRAFT_NOT_FOUND");
}

/// 按角色指定 Agent（ADR 036）：某个角色的 Agent 程序找不到时，启动前检查指出是哪个角色。
#[test]
fn preflight_names_the_role_whose_agent_is_missing() {
    let mut service = Service::start();
    let project = service.dir.join("project");
    let command = std::env::current_exe().unwrap();
    let input = json!({"cwd": project, "workflow":"aaw-dev", "entry":"dev", "inputs":{}, "command":[command],
        "roleCommands": {"设计": ["aaw-missing-agent-for-role"]}, "roleModels": {"设计": "fast-model"}, "mcpServers":[]});
    let report = service.request("preflight", json!({"input":input})).unwrap();
    let agent = preflight_item(&report, "agent");
    assert_eq!(agent["status"], "fail");
    assert!(agent["message"].as_str().unwrap().contains("「设计」"), "{agent}");
    let bad = json!({"cwd": project, "workflow":"aaw-dev", "entry":"dev", "inputs":{}, "command":[std::env::current_exe().unwrap()], "roleModels": {"设计": " "}, "mcpServers":[]});
    assert_eq!(preflight_item(&service.request("preflight", json!({"input":bad})).unwrap(), "workspace")["status"], "fail");
}

/// 编写工具（ADR 036）：草稿给出的 MCP 服务能按标准启动，AI 调用 check_workflow 拿到编译结果。
#[test]
fn drafts_offer_a_check_workflow_tool_over_stdio_mcp() {
    let mut service = Service::start();
    let draft = service.request("draft-create", json!({})).unwrap();
    let spec = &draft["mcpServer"];
    assert_eq!(spec["name"], "aaw-workflow-authoring");
    let mut child = Command::new(spec["command"].as_str().unwrap())
        .args(spec["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap()))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut call = |message: Value| -> Value {
        writeln!(input, "{message}").unwrap();
        input.flush().unwrap();
        serde_json::from_str(&output.next().unwrap().unwrap()).unwrap()
    };
    let init = call(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}));
    assert_eq!(init["result"]["serverInfo"]["name"], "aaw-workflow-authoring");
    assert_eq!(call(json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}))["result"]["tools"][0]["name"], "check_workflow");
    let checked = call(json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"check_workflow","arguments":{}}}));
    assert_eq!(checked["result"]["isError"], false);
    assert!(checked["result"]["content"][0]["text"].as_str().unwrap().starts_with("编译通过"));
    drop(input);
    let _ = child.wait();
}