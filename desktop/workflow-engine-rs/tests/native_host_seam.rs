//! ADR 023 二期-1 接缝中段集成：引擎 bin（native 模式）× 模拟宿主进程。
//!
//! 评审阻断项的回归线（两侧单测各测各的假设，中段零覆盖）：
//! 1. 线格式两端匹配：引擎 stdout 的宿主回调帧是事件信封
//!    `{"type":"event","event":{"type":"host-frame","runId":…,"frame":"<线帧
//!    JSON 字符串>"}}`；模拟宿主解码字符串帧、按 id 回应答——经
//!    `{"type":"host-frame","runId":…,"frame":"<字符串>"}` 写回 stdin。
//!    native 模式下一次真实 spawn→prompt_turn→turn_ended→完成收口。
//! 2. cancel_waiting 不回应答：模拟宿主对 cancel_waiting 帧不回帧（Desktop
//!    语义），随后继续的请求不报 HOST_RESPONSE_ID_MISMATCH。
//! 3. 应答截止时间：宿主对应答沉默时运行失败而不是永久挂死
//!    （HOST_RESPONSE_TIMEOUT 上抛为 run-error）。
//! 4. 二期-3：问题池 tracker 帧同样过线——start_question_tracker 按需求单
//!    参数真的 spawn tracker 并完成握手，question_tracker_request 中继
//!    JSON-RPC；引擎侧 QuestionPool 的 tools/list 与 aaw_pool_* 调用在跨
//!    进程路径下由宿主持有的 tracker 服务。
//!
//! fake agent（dev-fake-acp.py 基础模式）会经 MCP 结果通道交付并完成一个
//! 最小定义，证明 RemoteHost 的信封语义在跨进程路径下不破坏引擎四件合同。
use aaw_workflow_core::result_channel::ResultChannelOffer;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

/// 模拟宿主：读引擎 stdout 的 event 信封行，对 host-frame 请求按 id 回应答。
/// spawn 时真的拉起 fake agent（线格式替身里跑真实 ACP 轮次）；prompt_turn
/// 时驱动一轮 fake agent 轮次、结束才回帧；cancel_waiting 不回帧（Desktop
/// 语义）。`stall` 为 true 时对 spawn 沉默（超时路径）。返回（终局事件，
/// 是否见过 cancel_waiting 帧）。
fn host_loop(engine: &mut std::process::Child, stall: bool) -> (Value, bool) {
    let mut stdin = engine.stdin.take().unwrap();
    let stdout = engine.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel::<Value>();
    let _reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().flatten() {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if tx.send(v).is_err() {
                    break;
                }
            }
        }
    });
    let mut run_id = String::new();
    // 会话 id → fake agent：dev 流程多个 actor 各自 spawn（引擎按会话寻址
    // prompt_turn），模拟宿主按 session_id 分发（与 nativeHost 同语义）。
    let mut agents: BTreeMap<String, FakeAgent> = BTreeMap::new();
    // 挂起的 wait_turn_ended 帧（引擎在等下一个轮次边界）：消息轮次由对端
    // 原生驱动，桩没有消息来源——挂起直至 cancel_waiting 以错误应答唤醒
    // （与 Desktop nativeHost 同语义）。
    let mut pending_waits: BTreeMap<String, u64> = BTreeMap::new();
    // 问题池 tracker（二期-3）：按需求单参数真的拉起 tracker 进程并中继
    // JSON-RPC（与 nativeHost 的 TrackerRelay 同语义；状态文件按 cwd 规则
    // 落盘，测试目录由系统回收）。
    let mut tracker: Option<(std::process::Child, std::process::ChildStdin, BufReader<std::process::ChildStdout>, u64)> = None;
    let deadline = Instant::now() + Duration::from_secs(90);
    let mut stalled_reported = false;
    let mut saw_cancel_waiting = false;
    let outcome = loop {
        if Instant::now() > deadline {
            panic!("host loop deadline exceeded (runId={run_id})");
        }
        let event = match rx.recv_timeout(Duration::from_secs(10)) {
            Ok(event) => event,
            Err(_) => continue,
        };
        let event = &event["event"];
        if event["type"] == "run-starting" {
            run_id = event["runId"].as_str().unwrap_or("").to_owned();
        }
        if event["type"] == "run-error" || event["type"] == "run-settled" {
            break event.clone();
        }
        if event["type"] == "host-frame" {
            let frame: Value =
                serde_json::from_str(event["frame"].as_str().unwrap_or("null"))
                    .expect("host frame must be a JSON string");
            let id = frame["id"].as_u64().unwrap_or(0);
            let kind = frame["request"]["kind"].as_str().unwrap_or("");
            if stall && kind == "spawn_node_session" && !stalled_reported {
                stalled_reported = true;
                continue; // 沉默：触发引擎的 HOST_RESPONSE_TIMEOUT
            }
            if kind == "cancel_waiting" {
                saw_cancel_waiting = true;
                // fire-and-forget：不回应答本帧（Desktop 语义）；但挂起的
                // wait 帧要以错误应答唤醒，否则引擎运行线程永久阻塞。
                for (_, wait_id) in std::mem::take(&mut pending_waits) {
                    let response = json!({
                        "id": wait_id,
                        "response": {"code": "RUN_CANCELLED"},
                    });
                    let line = json!({
                        "type": "host-frame",
                        "runId": run_id,
                        "frame": serde_json::to_string(&response).unwrap(),
                    });
                    writeln!(stdin, "{line}").unwrap();
                    stdin.flush().unwrap();
                }
                continue;
            }
            let result = match kind {
                "spawn_node_session" => {
                    let requirement = &frame["request"]["requirement"];
                    let command: Vec<String> = requirement["command"]
                        .as_array()
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(Value::as_str)
                                .map(str::to_owned)
                                .collect()
                        })
                        .unwrap_or_default();
                    let cwd = requirement["cwd"].as_str().unwrap_or(".").to_owned();
                    // 结果通道：与真宿主同一规则——握手后按 Agent 声明的
                    // mcpCapabilities 经 ResultChannelOffer::mcp_server 选定。
                    let mcp = requirement["mcp_servers"].clone();
                    let offer: Option<ResultChannelOffer> =
                        serde_json::from_value(requirement["result_channel"].clone()).unwrap();
                    let agent = FakeAgent::start(&command, &cwd, mcp, offer.as_ref());
                    let session_id = agent.session_id.clone();
                    agents.insert(session_id.clone(), agent);
                    json!({"result":{"sessionId":session_id}})
                }
                "prompt_turn" => {
                    let session_id = frame["request"]["session_id"]
                        .as_str()
                        .unwrap_or("")
                        .to_owned();
                    let prompt = frame["request"]["prompt"].as_str().unwrap_or("");
                    agents
                        .get_mut(&session_id)
                        .expect("prompt for unknown session")
                        .prompt_turn(prompt);
                    json!({"result":null})
                }
                "wait_turn_ended" => {
                    let session_id = frame["request"]["session_id"]
                        .as_str()
                        .unwrap_or("")
                        .to_owned();
                    pending_waits.insert(session_id, id);
                    continue; // 挂起：等原生消息轮次或取消唤醒
                }
                "stop_node_session" => {
                    let session_id = frame["request"]["session_id"]
                        .as_str()
                        .unwrap_or("")
                        .to_owned();
                    if let Some(mut process) = agents.remove(&session_id) {
                        process.kill();
                    }
                    json!({"result":null})
                }
                "start_question_tracker" => {
                    let params = &frame["request"]["params"];
                    if tracker.is_some() {
                        json!({"result":null}) // 幂等：同作用域重复启动是 no-op
                    } else {
                        let executable = params["executable"].as_str().unwrap_or("").to_owned();
                        let cwd = params["cwd"].as_str().unwrap_or(".").to_owned();
                        let mut command = Command::new(&executable);
                        command.current_dir(&cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
                        if let Some(home) = params["home"].as_str() {
                            command.env("QUESTION_TRACKER_HOME", home);
                        }
                        #[cfg(windows)]
                        {
                            use std::os::windows::process::CommandExt;
                            command.creation_flags(0x08000000);
                        }
                        let mut child = command.spawn().expect("tracker spawn");
                        let mut stdin_t = child.stdin.take().expect("tracker stdin");
                        let mut stdout_t = BufReader::new(child.stdout.take().expect("tracker stdout"));
                        // 宿主侧握手（与 TrackerClient/nativeHost 同序列）。
                        let mut next: u64 = 0;
                        for method in [
                            ("initialize", json!({"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"aaw-native-host","version":"1"}})),
                        ] {
                            next += 1;
                            writeln!(stdin_t, "{}", json!({"jsonrpc":"2.0","id":next,"method":method.0,"params":method.1})).unwrap();
                            stdin_t.flush().unwrap();
                            loop {
                                let mut line = String::new();
                                stdout_t.read_line(&mut line).expect("tracker init read");
                                if line.is_empty() {
                                    panic!("tracker exited during initialize");
                                }
                                let value: Value = serde_json::from_str(&line).expect("tracker init json");
                                if value["id"].as_u64() == Some(next) {
                                    break;
                                }
                            }
                        }
                        writeln!(stdin_t, "{}", json!({"jsonrpc":"2.0","method":"notifications/initialized"})).unwrap();
                        stdin_t.flush().unwrap();
                        let session = params["session"].as_str().unwrap_or("").to_owned();
                        next += 1;
                        writeln!(stdin_t, "{}", json!({"jsonrpc":"2.0","id":next,"method":"tools/call","params":{"name":"create_session","arguments":{"session":session}}})).unwrap();
                        stdin_t.flush().unwrap();
                        loop {
                            let mut line = String::new();
                            stdout_t.read_line(&mut line).expect("tracker create_session read");
                            if line.is_empty() {
                                panic!("tracker exited during create_session");
                            }
                            let value: Value = serde_json::from_str(&line).expect("tracker create_session json");
                            if value["id"].as_u64() == Some(next) {
                                break;
                            }
                        }
                        tracker = Some((child, stdin_t, stdout_t, next));
                        json!({"result":null})
                    }
                }
                "question_tracker_request" => {
                    let (method, params) = {
                        let request = &frame["request"];
                        (
                            request["method"].as_str().unwrap_or("").to_owned(),
                            request["params"].clone(),
                        )
                    };
                    let (_, stdin_t, stdout_t, next_id) = tracker
                        .as_mut()
                        .expect("tracker request before start_question_tracker");
                    let id = *next_id + 1;
                    *next_id = id;
                    writeln!(stdin_t, "{}", json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})).unwrap();
                    stdin_t.flush().unwrap();
                    let tracker_result;
                    loop {
                        let mut line = String::new();
                        stdout_t.read_line(&mut line).expect("tracker rpc read");
                        if line.is_empty() {
                            panic!("tracker exited during {method}");
                        }
                        let value: Value = serde_json::from_str(&line).expect("tracker rpc json");
                        if value["id"].as_u64() == Some(id) {
                            tracker_result = value["result"].clone();
                            break;
                        }
                    }
                    json!({"result":tracker_result})
                }
                _ => json!({"result":null}),
            };
            let response = json!({ "id": id, "response": result });
            let line = json!({
                "type": "host-frame",
                "runId": run_id,
                "frame": serde_json::to_string(&response).unwrap(),
            });
            writeln!(stdin, "{line}").unwrap();
            stdin.flush().unwrap();
        }
    };
    (outcome, saw_cancel_waiting)
}

/// 一条被模拟宿主持有的 fake agent 进程：真实 ACP stdio，轮次驱动与
/// dev-fake-acp.py 的协议一致（initialize/session/new/session/prompt）。
/// stdout 由 FakeAgent 独占持有（BufReader 一次性取走，读回响应后归还）。
struct FakeAgent {
    child: std::process::Child,
    stdin: Option<std::process::ChildStdin>,
    stdout: Option<BufReader<std::process::ChildStdout>>,
    session_id: String,
}

impl FakeAgent {
    fn start(command: &[String], cwd: &str, mcp: Value, offer: Option<&ResultChannelOffer>) -> Self {
        let mut cmd = Command::new(&command[0]);
        cmd.args(&command[1..])
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        let mut child = cmd.spawn().expect("fake agent spawn");
        let mut stdin = child.stdin.take().expect("fake agent stdin");
        let mut stdout = BufReader::new(child.stdout.take().expect("fake agent stdout"));
        writeln!(
            stdin,
            "{}",
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false}},"clientInfo":{"name":"sim-host","version":"1"}}})
        )
        .unwrap();
        stdin.flush().unwrap();
        let initialized = read_response(&mut stdout, 1);
        let mut mcp = mcp;
        if let Some(offer) = offer {
            let http = initialized["result"]["agentCapabilities"]["mcpCapabilities"]["http"] == true;
            mcp.as_array_mut().unwrap().push(offer.mcp_server(http));
        }
        writeln!(
            stdin,
            "{}",
            json!({"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":cwd,"mcpServers":mcp}})
        )
        .unwrap();
        stdin.flush().unwrap();
        let response = read_response(&mut stdout, 2);
        let session_id = response["result"]["sessionId"]
            .as_str()
            .expect("fake agent session id")
            .to_owned();
        Self {
            child,
            stdin: Some(stdin),
            stdout: Some(stdout),
            session_id,
        }
    }

    fn prompt_turn(&mut self, prompt: &str) {
        let stdin = self
            .stdin
            .as_mut()
            .expect("fake agent stdin already consumed");
        let mut stdout = self
            .stdout
            .take()
            .expect("fake agent stdout already consumed");
        writeln!(
            stdin,
            "{}",
            json!({"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":self.session_id,"prompt":[{"type":"text","text":prompt}]}})
        )
        .unwrap();
        stdin.flush().unwrap();
        // 轮次结束（响应 id=3）才算 turn_ended；期间的通知（session/update）
        // 由 read_response 吞掉（会话内容归宿主，引擎帧不带）。
        read_response(&mut stdout, 3);
        self.stdout = Some(stdout);
    }

    fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// 读到指定 id 的响应为止（通知丢弃；会话内容不进帧的引擎感知路径）。
fn read_response(stdout: &mut BufReader<std::process::ChildStdout>, id: u64) -> Value {
    let deadline = Instant::now() + Duration::from_secs(45);
    loop {
        if Instant::now() > deadline {
            panic!("fake agent response deadline exceeded (id={id})");
        }
        let mut line = String::new();
        stdout.read_line(&mut line).expect("fake agent stdout");
        if line.is_empty() {
            panic!("fake agent exited before response id={id}");
        }
        let value: Value = serde_json::from_str(&line).expect("fake agent json");
        if value["id"].as_u64() == Some(id) {
            return value;
        }
    }
}

fn spawn_engine(dir: &std::path::Path, native: bool) -> std::process::Child {
    let mut command = Command::new(env!("CARGO_BIN_EXE_workflow_service"));
    command
        .arg(dir.join("journal.sqlite"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    if native {
        command.arg("--session-host=native");
        // 接缝测试注入秒级应答截止：宿主沉默/断链的失败必须落在测试时限
        // 内可观测（生产默认 120s 由 bin 兜底）。
        command.env("AAW_HOST_RESPONSE_TIMEOUT_SECS", "5");
    }
    command.spawn().unwrap()
}

fn start_run(engine: &mut std::process::Child, dir: &std::path::Path, id: u64) {
    let fake = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/dev-fake-acp.py");
    let stdin = engine.stdin.as_mut().unwrap();
    writeln!(
        stdin,
        "{}",
        json!({"id": id, "method": "start-dev", "params": {"input": {
            "cwd": dir.to_str().unwrap(),
            "requirement": "fixture",
            "command": ["python", fake.to_str().unwrap()],
            "mcpServers": [],
        }}})
    )
    .unwrap();
    stdin.flush().unwrap();
}

#[test]
#[ignore = "requires Python; exercises the native host seam across the real service process"]
fn native_host_seam_completes_a_run_end_to_end() {
    // 全链路：模拟宿主是真实宿主（Desktop nativeHost）的线格式替身——它
    // 收 spawn 帧后真的拉起 fake agent 进程（dev-fake-acp.py，带结果通道
    // MCP 配置），在 prompt_turn 帧时经 ACP stdio 驱动真实轮次，轮次结束
    // 才回帧（turn_ended 的 Desktop 语义）。这样结果通道由 fake agent 提交，
    // 引擎四件合同在跨进程路径下完整走通。
    let dir = std::env::temp_dir().join(format!(
        "aaw-native-seam-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&dir).unwrap();
    let mut engine = spawn_engine(&dir, true);
    start_run(&mut engine, &dir, 1);
    let (event, saw_cancel_waiting) = host_loop(&mut engine, false);
    assert_eq!(event["type"], "run-settled", "{event}");
    assert_eq!(event["settlement"]["status"], "completed", "{event}");
    assert!(saw_cancel_waiting, "run end must emit cancel_waiting frames");
    let _ = engine.kill();
    let _ = engine.wait();
    // Windows：journal 句柄随引擎退出释放有延迟，删除失败不判失败
    // （临时目录由系统回收）。
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
#[ignore = "requires Python; cancel_waiting (no answer) must not poison the next request"]
fn stop_request_answer_frame_never_poisons_the_mailbox() {
    // 序列：spawn（回帧）→ stop 协议（cancel_waiting，宿主不回帧）→
    // 引擎侧停止中的轮次返回后继续 next_user_message——陈旧无主帧不存在，
    // 下一请求不会撞 HOST_RESPONSE_ID_MISMATCH。这里以「运行正常停摆且无
    // id 错配错误」为过线标准：run-error 若含 HOST_RESPONSE_ID_MISMATCH
    // 即阻断项复发。
    let dir = std::env::temp_dir().join(format!(
        "aaw-native-stop-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&dir).unwrap();
    let mut engine = spawn_engine(&dir, true);
    start_run(&mut engine, &dir, 1);
    let (event, saw_cancel_waiting) = host_loop(&mut engine, false);
    let message = event["message"].as_str().unwrap_or("");
    assert!(
        saw_cancel_waiting,
        "stop path must have emitted a cancel_waiting frame for the test to be meaningful"
    );
    assert!(
        !message.contains("HOST_RESPONSE_ID_MISMATCH"),
        "stale answer frame poisoned the mailbox: {event}"
    );
    let _ = engine.kill();
    let _ = engine.wait();
    // Windows：journal 句柄随引擎退出释放有延迟，删除失败不判失败。
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
#[ignore = "requires Python; a silent host must fail the run with HOST_RESPONSE_TIMEOUT"]
fn a_silent_host_fails_the_run_instead_of_hanging() {
    let dir = std::env::temp_dir().join(format!(
        "aaw-native-stall-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&dir).unwrap();
    let mut engine = spawn_engine(&dir, true);
    start_run(&mut engine, &dir, 1);
    let started = Instant::now();
    let (event, _) = host_loop(&mut engine, true);
    assert_eq!(event["type"], "run-error", "{event}");
    assert!(
        event["message"].as_str().unwrap_or("").contains("HOST_RESPONSE_TIMEOUT"),
        "expected timeout, got: {event}"
    );
    assert!(
        started.elapsed() < Duration::from_secs(85),
        "timeout must bound the hang (took {:?})",
        started.elapsed()
    );
    let _ = engine.kill();
    let _ = engine.wait();
    let _ = std::fs::remove_dir_all(dir);
}
