//! ADR 023 P2/P3 装配：用户消息队列、会话事件缓冲与权限/问答中继已从
//! ServiceHost 移交会话宿主（SessionChannel / HeadlessHost）。二期-2 起
//! 宿主是纯内存桩：没有 host_* 表、没有事件持久化、没有消息状态机指纹
//! （排队/送达语义归宿主原生会话流），本文件按新接缝直接驱动宿主侧簿记。
use aaw_workflow_core::{
    Action, Workflow,
    headless_host::SessionChannel,
    journal::Journal,
    runtime::Host,
    service_host::ServiceHost,
};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex, atomic::AtomicBool},
    time::{Duration, Instant},
};

#[test]
fn routes_interaction_to_its_session_and_replays_early_events() {
    let db_path = std::env::temp_dir().join(format!(
        "aaw-host-{}-{}.sqlite",
        std::process::id(),
        Instant::now().elapsed().as_nanos()
    ));
    let mut journal = Journal::open(&db_path).unwrap();
    journal
        .create("r", "project", &workflow("test".into()))
        .unwrap();
    journal.claim("r", "project", "owner").unwrap();
    let action = journal
        .dispatch("r", "project", "owner")
        .unwrap()
        .pop()
        .unwrap();
    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let copy = events.clone();
    let sink = Arc::new(move |event: Value| {
        copy.lock().unwrap().push(event);
        Ok(())
    });
    let host = Arc::new(ServiceHost::new(
        "r".into(),
        "project".into(),
        "owner".into(),
        db_path.clone(),
        sink.clone(),
    ));
    let channel = Arc::new(SessionChannel::new("r".into(), sink));
    channel.notification(&action,"session/update",&json!({"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"text":"early"}}})).unwrap();
    assert!(events.lock().unwrap().is_empty());
    journal
        .link_session("r", "project", "owner", &action.site, action.ordinal, "s")
        .unwrap();
    channel.session_established(&action, "s", false).unwrap();
    assert_eq!(events.lock().unwrap()[1]["event"]["text"], "early");
    channel
        .begin_action(&action, "s", "INTERNAL PROMPT AND SCHEMA")
        .unwrap();
    channel.notification(&action,"session/update",&json!({"sessionId":"s","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"REPLAYED INTERNAL PROMPT"}}})).unwrap();
    // 会话身份标注（workflow_context）保留普通呈现；调度 prompt 绝不以
    // 用户消息形态进入事件流（宿主合成的用户消息只有真实排队消息与
    // 初始需求，内部上下文不冒充任何一方）。
    channel.enqueue_user_message("s", "用户追加").unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let delivered = channel
        .wait_user_message(&action, "s", cancel.clone())
        .unwrap();
    assert_eq!(delivered, "用户追加");
    // 消息此刻才进入会话流（一条普通用户消息事件）；没有「已排队/已
    // 送达/已确认」类引擎指纹事件。
    {
        let events = events.lock().unwrap();
        assert!(events.iter().any(|e| e["event"]["type"] == "user_message_chunk"
            && e["event"]["text"] == "用户追加"));
        assert!(!events
            .iter()
            .any(|e| e["event"]["type"].as_str().unwrap_or("").starts_with("workflow_input")));
    }
    // 未知会话的消息入口不存在：不能串线。
    assert!(channel.enqueue_user_message("other-session", "串线").is_err());
    channel.notification(&action,"session/update",&json!({"sessionId":"s","update":{"sessionUpdate":"tool_call","toolCallId":"t","rawInput":{"headers":{"Authorization":"do-not-record"},"url":"https://user:password@example.com/?token=hidden","reference":"https://example.com/doc?token=artifact-secret"}}})).unwrap();
    let other = channel.clone();
    let action_clone = action.clone();
    let thread = std::thread::spawn(move || {
        other.relay_interaction(
            &action_clone,
            "_chrys/request_input",
            &json!({"sessionId":"s","requestId":"q","questions":[{"question":"choose"}]}),
        )
    });
    let mut pending = Vec::new();
    for _ in 0..100 {
        pending = channel.pending_interactions().unwrap();
        if !pending.is_empty() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let id = pending[0]["interactionId"].as_str().unwrap();
    assert!(
        channel
            .respond_interaction(id, "permission", json!({"outcome":"selected"}))
            .is_err()
    );
    channel
        .respond_interaction(id, "question", json!({"answers":[]}))
        .unwrap();
    assert_eq!(thread.join().unwrap().unwrap()["answers"], json!([]));
    // 已决交互不再挂起（应答路由回会话事件链）。
    assert!(channel.pending_interactions().unwrap().is_empty());
    // 实时事件流的脱敏与归属（发布面断言；宿主侧无任何持久化副本）。
    let published: Vec<Value> = events.lock().unwrap().clone();
    let all = published
        .iter()
        .map(|value| value.to_string())
        .collect::<Vec<_>>()
        .join("");
    let log: Vec<Value> = published
        .iter()
        .filter(|value| value["type"] == "acp-event")
        .map(|value| value["event"].clone())
        .collect();
    assert_eq!(
        serde_json::to_value(&log[0]).unwrap()["text"],
        "early"
    );
    assert!(
        !log.iter()
            .any(|e| e["type"] == "user_message_chunk" && e["text"] == "INTERNAL PROMPT AND SCHEMA")
    );
    assert!(log.iter().any(|e| e["type"] == "workflow_context"));
    assert!(
        log.iter().any(|e| e["type"] == "workflow_context" && e["text"] == "INTERNAL PROMPT AND SCHEMA")
    );
    assert!(!all.contains("REPLAYED INTERNAL PROMPT"));
    assert!(log.iter().any(|e| e["type"] == "tool_call" && e["toolCallId"] == "t"));
    assert!(
        !all.contains("do-not-record")
            && !all.contains("password")
            && !all.contains("hidden")
            && !all.contains("artifact-secret")
    );
    // 宿主侧零持久化：同库不再有任何 host_* 表（二期-2 瘦身的落库面）。
    let tables: String = rusqlite::Connection::open(&db_path)
        .unwrap()
        .query_row(
            "SELECT COALESCE(GROUP_CONCAT(name),'') FROM sqlite_master WHERE type='table'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!tables.contains("host_"), "host tables must be gone: {tables}");
    journal
        .complete(
            "r",
            "project",
            "owner",
            &action.site,
            action.ordinal,
            json!({
                "status":"ready", "reference":"req", "evidence":"confirmed",
                "custom":{"files":{"comment":"交付的文件","values":["aaa.md","bbb.md"]}}
            }),
        )
        .unwrap();
    let list = host.workflow_results(None, None).unwrap();
    assert_eq!(list[0]["siteId"], action.site);
    assert!(
        list[0]["fields"]
            .as_array()
            .unwrap()
            .contains(&json!("custom"))
    );
    let raw = host
        .workflow_results(Some(&action.site), Some(action.ordinal))
        .unwrap();
    assert_eq!(raw["result"]["custom"]["files"]["values"][1], "bbb.md");
    assert!(host.workflow_results(Some(&action.site), Some(99)).is_err());
    journal.release("r", "project", "owner").unwrap();
    drop(journal);
    drop(host);
    drop(channel);
    std::fs::remove_file(db_path).unwrap();
}

fn workflow(requirement: String) -> Workflow {
    let definition = aaw_workflow_core::source::compile_dir(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("workflows/aaw-dev")).unwrap().definition;
    Workflow::from_definition(definition, json!({"requirement":requirement})).unwrap()
}

#[test]
fn long_session_replay_is_buffered_before_linking() {
    let db_path =
        std::env::temp_dir().join(format!("aaw-long-replay-{}.sqlite", uuid::Uuid::new_v4()));
    let mut journal = Journal::open(&db_path).unwrap();
    journal
        .create("r", "project", &workflow("test".into()))
        .unwrap();
    journal.claim("r", "project", "owner").unwrap();
    let action = journal
        .dispatch("r", "project", "owner")
        .unwrap()
        .pop()
        .unwrap();
    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let copy = events.clone();
    let channel = SessionChannel::new(
        "r".into(),
        Arc::new(move |event| {
            copy.lock().unwrap().push(event);
            Ok(())
        }),
    );
    for i in 0..600 {
        channel.notification(&action, "session/update", &json!({"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"text":format!("event-{i}")}}})).unwrap();
    }
    journal
        .link_session("r", "project", "owner", &action.site, action.ordinal, "s")
        .unwrap();
    channel.session_established(&action, "s", true).unwrap();
    let events = events.lock().unwrap();
    assert_eq!(events.len(), 601);
    assert_eq!(events[0]["type"], "acp-session-restored");
    assert_eq!(events[1]["event"]["text"], "event-0");
    assert_eq!(events[600]["event"]["text"], "event-599");
    drop(events);
    drop(channel);
    drop(journal);
    std::fs::remove_file(db_path).unwrap();
}

/// 评审阻断项回归（两轮）的接缝新形态：同一会话的多个并发写者（ACP
/// reader 线程 / actor 线程 / service 线程的真实形态）同时发布事件。
/// 旧宿主把事件写进 host_session_events（COUNT+INSERT 分配 seq），SQLite
/// BUSY 竞争曾把正常轮次打成伪失败；二期-2 删除持久化后事件只实时发布，
/// 回归线收敛为「任何一次并发 notification 都不得失败、不得丢失」。
#[test]
fn concurrent_session_notifications_never_fail_or_lose_events() {
    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let copy = events.clone();
    let channel = Arc::new(SessionChannel::new(
        "r".into(),
        Arc::new(move |event| {
            copy.lock().unwrap().push(event);
            Ok(())
        }),
    ));
    let action = Action {
        site: "requirement".into(),
        ordinal: 1,
        actor: "设计".into(),
        input: json!({"__node":{"kind":"agent"}}),
    };
    channel.session_established(&action, "s", false).unwrap();
    // 生产真实并发度：同一会话最多 3 类写者（ACP reader 的 notification、
    // actor 线程的 begin_action、service 线程的 enqueue）。
    let writers = 3usize;
    let per_writer = 120usize;
    let mut handles = Vec::new();
    for writer in 0..writers {
        let channel = channel.clone();
        let action = action.clone();
        handles.push(std::thread::spawn(move || {
            for i in 0..per_writer {
                channel
                    .notification(
                        &action,
                        "session/update",
                        &json!({"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"text":format!("w{writer}-e{i}")}}}),
                    )
                    .expect("concurrent event publish must not fail");
            }
        }));
    }
    for handle in handles {
        handle.join().unwrap();
    }
    let published = events.lock().unwrap();
    let session_events = published
        .iter()
        .filter(|value| value["type"] == "acp-event")
        .count();
    assert_eq!(
        session_events,
        writers * per_writer,
        "every concurrent notification must be published exactly once"
    );
    // 每个写者的事件全部在场（不丢事件）。
    for writer in 0..writers {
        for i in 0..per_writer {
            let marker = format!("w{writer}-e{i}");
            assert!(
                published
                    .iter()
                    .any(|value| value["event"]["text"] == marker),
                "event {marker} must not be lost"
            );
        }
    }
}

/// 停止运行后消息入口必须显式报错：宁可让用户看到「未能排队」也不能让
/// 消息静默滞留在一个永不会被送达的队列里。
#[test]
fn cancelled_inputs_reject_new_messages() {
    let channel = Arc::new(SessionChannel::new("r".into(), Arc::new(|_| Ok(()))));
    let action = Action {
        site: "requirement".into(),
        ordinal: 1,
        actor: "设计".into(),
        input: json!({"__node":{"kind":"agent"}}),
    };
    channel.session_established(&action, "s", false).unwrap();
    channel.cancel_waiting();
    let error = match channel.enqueue_user_message("s", "停止后的消息") {
        Err(error) => error,
        Ok(()) => panic!("cancelled session must not accept messages"),
    };
    assert_eq!(error, "WORKFLOW_SESSION_NOT_ACCEPTING_INPUT");
    // 取消唤醒阻塞中的等待轮次。
    let waiter = {
        let channel = channel.clone();
        let action = action.clone();
        std::thread::spawn(move || {
            channel.wait_user_message(&action, "s", Arc::new(AtomicBool::new(false)))
        })
    };
    let error = match waiter.join().unwrap() {
        Err(error) => error,
        Ok(text) => panic!("cancelled wait must fail, got {text}"),
    };
    assert_eq!(error, "RUN_CANCELLED");
}
