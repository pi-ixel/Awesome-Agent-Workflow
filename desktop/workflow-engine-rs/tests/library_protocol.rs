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
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "aaw-library-{}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(dir.join("project")).unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_workflow_service"))
            .arg(dir.join("data").join("workflow-runs.sqlite"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
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
