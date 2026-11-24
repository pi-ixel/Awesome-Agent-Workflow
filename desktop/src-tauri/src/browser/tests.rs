use super::model::{Controller, PageSource, RequestStatus, TabLifecycle};
use super::runtime::BrowserRuntime;

fn runtime_with_tab() -> (BrowserRuntime, String) {
    let mut runtime = BrowserRuntime::default();
    runtime
        .create_space("window-a", "workspace", "session-a")
        .unwrap();
    let tab = runtime
        .create_tab("session-a", "https://local.test/a")
        .unwrap();
    (runtime, tab.tab_id)
}

#[test]
fn td_024_u01a_session_defaults_to_user_control() {
    let (runtime, tab_id) = runtime_with_tab();
    let space = &runtime.spaces["session-a"];
    assert!(!space.agent_active);
    assert!(!space.manual_takeover);
    assert_eq!(space.tabs[&tab_id].control.controller, Controller::User);
    runtime
        .assert_session_control("session-a", PageSource::User)
        .unwrap();
}

#[test]
fn td_024_u01b_takeover_updates_all_tabs_cancels_work_and_isolates_sessions() {
    let (mut runtime, first) = runtime_with_tab();
    let second = runtime
        .create_tab("session-a", "https://local.test/2")
        .unwrap();
    runtime
        .create_space("window-b", "workspace", "session-b")
        .unwrap();
    let other = runtime
        .create_tab("session-b", "https://local.test/b")
        .unwrap();
    runtime.begin_agent_activity("session-a").unwrap();
    runtime.begin_agent_activity("session-b").unwrap();
    runtime
        .begin_request("request-a", "session-a", &first)
        .unwrap();
    runtime
        .begin_request("request-b", "session-b", &other.tab_id)
        .unwrap();
    let before = runtime.spaces["session-a"].tabs[&first].control.generation;
    let space = runtime.user_takeover("session-a", &first, before).unwrap();
    assert!(space.manual_takeover);
    assert!(!space.agent_active);
    assert!(
        space
            .tabs
            .values()
            .all(|tab| tab.control.controller == Controller::User)
    );
    assert!(space.tabs[&first].control.generation > before);
    assert_eq!(
        runtime.requests["request-a"].status,
        RequestStatus::Cancelled
    );
    assert_eq!(runtime.requests["request-b"].status, RequestStatus::Pending);
    assert!(runtime.spaces["session-b"].agent_active);
    assert_eq!(second.session_id, "session-a");
}

#[test]
fn td_024_u01c_new_tab_and_only_new_turn_restores_agent_access() {
    let (mut runtime, tab_id) = runtime_with_tab();
    let active = runtime.begin_agent_activity("session-a").unwrap();
    let created = runtime
        .create_tab("session-a", "https://local.test/new")
        .unwrap();
    assert_eq!(created.control.controller, Controller::Agent);
    let generation = active.tabs[&tab_id].control.generation;
    runtime
        .user_takeover("session-a", &tab_id, generation)
        .unwrap();
    let user_created = runtime
        .create_tab("session-a", "https://local.test/user")
        .unwrap();
    assert_eq!(user_created.control.controller, Controller::User);
    assert!(runtime.begin_agent_activity("session-a").is_err());
    runtime.begin_turn("session-a").unwrap();
    assert!(runtime.begin_agent_activity("session-a").is_ok());
    let request = runtime
        .begin_request("agent-new-turn", "session-a", &created.tab_id)
        .unwrap();
    assert_eq!(request.status, RequestStatus::Pending);
}

#[test]
fn td_024_u01d_crash_and_recovery_preserve_user_control() {
    let (mut runtime, tab_id) = runtime_with_tab();
    let active = runtime.begin_agent_activity("session-a").unwrap();
    let generation = active.tabs[&tab_id].control.generation;
    runtime
        .user_takeover("session-a", &tab_id, generation)
        .unwrap();
    let crashed = runtime.crash_tab("session-a", &tab_id).unwrap();
    assert_eq!(crashed.control.controller, Controller::User);
    let recovered = runtime.recover_tab("session-a", &tab_id).unwrap();
    assert_eq!(recovered.control.controller, Controller::User);
    assert!(recovered.generation > crashed.generation);
}

#[test]
fn td_024_u01e_source_control_is_fail_closed() {
    let (mut runtime, tab_id) = runtime_with_tab();
    runtime
        .assert_session_control("session-a", PageSource::Agent)
        .unwrap();
    runtime
        .assert_session_control("session-a", PageSource::User)
        .unwrap();
    let active = runtime.begin_agent_activity("session-a").unwrap();
    runtime
        .assert_session_control("session-a", PageSource::User)
        .unwrap_err();
    let generation = active.tabs[&tab_id].control.generation;
    runtime
        .user_takeover("session-a", &tab_id, generation)
        .unwrap();
    runtime
        .assert_session_control("session-a", PageSource::User)
        .unwrap();
    runtime
        .assert_session_control("session-a", PageSource::Agent)
        .unwrap_err();
}

#[test]
fn td_024_u03a_input_bridge_defaults_idle_and_distinguishes_trusted_input() {
    let script = super::host::control_bridge_script("session-a", "tab-1");
    assert!(script.contains("__aawAgentActive=false"));
    assert!(script.contains("event.isTrusted"));
    assert!(script.contains("preventDefault"));
    assert!(script.contains("stopImmediatePropagation"));
    assert!(script.contains("user-takeover"));
}

#[test]
fn td_01_u01_generations_are_independent_and_monotonic() {
    let (mut runtime, tab_id) = runtime_with_tab();
    let before = runtime.spaces["session-a"].tabs[&tab_id].clone();
    let recovered = runtime.recover_tab("session-a", &tab_id).unwrap();
    assert_eq!(recovered.tab_id, before.tab_id);
    assert!(recovered.generation > before.generation);
    assert_eq!(recovered.control.generation, before.control.generation);
}

#[test]
fn td_02_i03_crash_cancels_old_work_and_recovery_keeps_identity() {
    let (mut runtime, tab_id) = runtime_with_tab();
    runtime
        .begin_request("request-a", "session-a", &tab_id)
        .unwrap();
    let crashed = runtime.crash_tab("session-a", &tab_id).unwrap();
    assert_eq!(crashed.lifecycle, TabLifecycle::Crashed);
    assert_eq!(
        runtime.requests["request-a"].status,
        RequestStatus::Cancelled
    );
    assert_eq!(
        runtime
            .begin_request("blocked", "session-a", &tab_id)
            .unwrap_err(),
        "TAB_NOT_READY"
    );
    let recovered = runtime.recover_tab("session-a", &tab_id).unwrap();
    assert_eq!(recovered.tab_id, tab_id);
    assert!(recovered.generation > crashed.generation);
    assert_eq!(recovered.committed_url, Some("https://local.test/a".into()));
}

#[test]
fn td_01_u03_closed_tabs_never_resurrect() {
    let (mut runtime, tab_id) = runtime_with_tab();
    runtime.close_tab("session-a", &tab_id).unwrap();
    let error = runtime.recover_tab("session-a", &tab_id).unwrap_err();
    assert_eq!(error, "TAB_CLOSED");
    assert_eq!(
        runtime.spaces["session-a"].tabs[&tab_id].lifecycle,
        TabLifecycle::Closed
    );
}

#[test]
fn td_01_b01_b05_session_ownership_is_fail_closed() {
    let (mut runtime, tab_id) = runtime_with_tab();
    runtime
        .create_space("window-b", "workspace", "session-b")
        .unwrap();
    assert_eq!(
        runtime.recover_tab("session-b", &tab_id).unwrap_err(),
        "ACCESS_DENIED"
    );
    assert_eq!(runtime.spaces["session-b"].tabs.len(), 0);
}

#[test]
fn td_024_u01f_takeover_cancels_pending_and_preserves_session_ownership() {
    let (mut runtime, tab_id) = runtime_with_tab();
    let active = runtime.begin_agent_activity("session-a").unwrap();
    let generation = active.tabs[&tab_id].control.generation;
    runtime
        .begin_request("request-a", "session-a", &tab_id)
        .unwrap();
    let space = runtime
        .user_takeover("session-a", &tab_id, generation)
        .unwrap();
    let tab = &space.tabs[&tab_id];
    assert_eq!(tab.control.controller, Controller::User);
    assert_eq!(tab.control.owner_session_id, "session-a");
    assert_eq!(
        runtime.requests["request-a"].status,
        RequestStatus::Cancelled
    );
}

#[test]
fn td_04_u05_turn_cancellation_only_cancels_current_session_pending_requests() {
    let (mut runtime, tab_id) = runtime_with_tab();
    runtime
        .create_space("window-b", "workspace", "session-b")
        .unwrap();
    let other = runtime
        .create_tab("session-b", "https://local.test/b")
        .unwrap();
    runtime
        .begin_request("request-a", "session-a", &tab_id)
        .unwrap();
    runtime
        .begin_request("request-b", "session-b", &other.tab_id)
        .unwrap();
    runtime.complete_request("request-a").unwrap();
    runtime
        .begin_request("request-a-2", "session-a", &tab_id)
        .unwrap();
    let cancelled = runtime.cancel_session_requests("session-a");
    assert_eq!(cancelled, vec!["request-a-2".to_owned()]);
    assert_eq!(
        runtime.requests["request-a"].status,
        RequestStatus::Completed
    );
    assert_eq!(
        runtime.requests["request-a-2"].status,
        RequestStatus::Cancelled
    );
    assert_eq!(runtime.requests["request-b"].status, RequestStatus::Pending);
}

#[test]
fn td_024_u01g_only_new_turn_restores_agent_without_control_approval() {
    let (mut runtime, tab_id) = runtime_with_tab();
    let active = runtime.begin_agent_activity("session-a").unwrap();
    let generation = active.tabs[&tab_id].control.generation;
    runtime
        .user_takeover("session-a", &tab_id, generation)
        .unwrap();
    assert_eq!(
        runtime
            .assert_agent_control("session-a", &tab_id)
            .unwrap_err(),
        "CONTROL_NOT_GRANTED"
    );
    assert_eq!(
        runtime
            .begin_request("blocked", "session-a", &tab_id)
            .unwrap_err(),
        "CONTROL_NOT_GRANTED"
    );
    let before = runtime.spaces["session-a"].tabs[&tab_id].control.generation;
    let next = runtime.begin_turn("session-a").unwrap();
    assert_eq!(next.tabs[&tab_id].control.controller, Controller::User);
    assert!(next.tabs[&tab_id].control.generation > before);
    let granted = runtime.begin_agent_activity("session-a").unwrap();
    assert_eq!(granted.tabs[&tab_id].control.controller, Controller::Agent);
    assert!(
        runtime
            .begin_request("allowed", "session-a", &tab_id)
            .is_ok()
    );
    assert_eq!(granted.tabs[&tab_id].control.owner_session_id, "session-a");
}

#[test]
fn td_01_i03_agent_input_does_not_trigger_user_takeover() {
    let (mut runtime, tab_id) = runtime_with_tab();
    let before = runtime.spaces["session-a"].tabs[&tab_id].control.clone();
    let after = runtime.agent_input("session-a", &tab_id).unwrap();
    assert_eq!(after.control, before);
}

#[test]
fn td_01_i06_terminal_request_state_cannot_be_overwritten() {
    let (mut runtime, tab_id) = runtime_with_tab();
    runtime
        .begin_request("request-a", "session-a", &tab_id)
        .unwrap();
    runtime.complete_request("request-a").unwrap();
    let cancelled = runtime.cancel_request("request-a").unwrap();
    assert_eq!(cancelled.status, RequestStatus::Completed);
    assert!(cancelled.late_cancel_recorded);
}

#[test]
fn td_01_b02_stale_request_cannot_target_replacement_page() {
    let (mut runtime, tab_id) = runtime_with_tab();
    runtime
        .begin_request("request-a", "session-a", &tab_id)
        .unwrap();
    runtime.recover_tab("session-a", &tab_id).unwrap();
    assert_eq!(runtime.requests["request-a"].status, RequestStatus::Stale);
    assert_eq!(
        runtime.complete_request("request-a").unwrap_err(),
        "STALE_GENERATION"
    );
}

#[test]
fn td_02_b03_navigation_protocols_are_fail_closed() {
    for target in ["file:///tmp/a", "javascript:alert(1)", "data:text/html,a"] {
        assert_eq!(
            super::host::validate_navigation_target(target).unwrap_err(),
            "NAVIGATION_DENIED"
        );
    }
    assert_eq!(
        super::host::validate_navigation_target("https://local.test/a").unwrap(),
        "https://local.test/a"
    );
}

#[test]
fn td_02_u02_native_bounds_are_bounded() {
    assert!(super::host::validate_native_bounds(300.0, 200.0).is_ok());
    assert_eq!(
        super::host::validate_native_bounds(0.0, 200.0).unwrap_err(),
        "INVALID_BOUNDS"
    );
    assert_eq!(
        super::host::validate_native_bounds(300.0, f64::INFINITY).unwrap_err(),
        "INVALID_BOUNDS"
    );
}

#[test]
fn td_04_i01_u01_endpoints_are_unique_and_identity_is_trusted() {
    let mut registry = super::mcp::McpRegistry::default();
    let a = super::mcp::create_endpoint(&mut registry, 41001).unwrap();
    let b = super::mcp::create_endpoint(&mut registry, 41002).unwrap();
    assert_ne!(a.endpoint_id, b.endpoint_id);
    assert_ne!(a.token, b.token);
    assert_eq!(
        super::mcp::resolve_endpoint(&registry, &a.token).unwrap_err(),
        "ENDPOINT_NOT_BOUND"
    );
    super::mcp::bind_endpoint(&mut registry, &a.endpoint_id, "session-a", None).unwrap();
    assert_eq!(
        super::mcp::resolve_endpoint(&registry, &a.token)
            .unwrap()
            .session_id
            .unwrap(),
        "session-a"
    );
    assert_eq!(
        super::mcp::resolve_endpoint(&registry, "forged").unwrap_err(),
        "ENDPOINT_UNKNOWN"
    );
}

#[test]
fn td_07_u01_session_partitions_are_stable_and_collision_resistant() {
    let a = super::host::session_partition("C:/work/a_b");
    let b = super::host::session_partition("C:/work/a:b");
    assert_eq!(a, super::host::session_partition("C:/work/a_b"));
    assert_ne!(a, b);
    assert_eq!(a.len(), 32);
    assert!(a.chars().all(|character| character.is_ascii_hexdigit()));
}

#[test]
fn td_03_i05_protocol_version_negotiation_is_explicit() {
    for version in ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"] {
        assert_eq!(
            super::mcp::negotiate_protocol_version(version).unwrap(),
            version
        );
    }
    assert_eq!(
        super::mcp::negotiate_protocol_version("1999-01-01").unwrap_err(),
        "PROTOCOL_VERSION_UNSUPPORTED"
    );
}

#[test]
fn td_03_u03_effective_tool_contract_covers_core_navigation_and_discovery() {
    let definitions = super::tool::tool_definitions();
    let names: Vec<_> = definitions["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    for required in [
        "browser_capabilities",
        "browser_select_tab",
        "browser_close_tab",
        "browser_back",
        "browser_forward",
        "browser_reload",
        "browser_stop",
        "browser_wait",
        "browser_locate",
    ] {
        assert!(names.contains(&required), "missing tool: {required}");
    }
}

#[test]
fn td_03_u01_tool_argument_contract_rejects_unknown_missing_and_wrong_types() {
    assert!(
        super::tool::validate_tool_arguments(
            "browser_click",
            &serde_json::json!({"tabId":"tab-1","selector":"#target"})
        )
        .is_ok()
    );
    for arguments in [
        serde_json::json!({"selector":"#target"}),
        serde_json::json!({"tabId":1,"selector":"#target"}),
        serde_json::json!({"tabId":"","selector":"#target"}),
        serde_json::json!({"tabId":"tab-1","selector":"#target","sessionId":"session-b"}),
    ] {
        assert_eq!(
            super::tool::validate_tool_arguments("browser_click", &arguments).unwrap_err(),
            "INVALID_ARGUMENT"
        );
    }
    assert!(
        super::tool::validate_tool_arguments(
            "browser_scroll",
            &serde_json::json!({"tabId":"tab-1","deltaY":100.5})
        )
        .is_ok()
    );
    assert_eq!(
        super::tool::validate_tool_arguments(
            "browser_scroll",
            &serde_json::json!({"tabId":"tab-1","deltaY":"fast"})
        )
        .unwrap_err(),
        "INVALID_ARGUMENT"
    );
    assert_eq!(
        super::tool::validate_tool_arguments("not_a_tool", &serde_json::json!({})).unwrap_err(),
        "TOOL_NOT_SUPPORTED"
    );
}

#[test]
fn td_03_b03_http_transport_rejects_wrong_method_path_and_host() {
    assert!(
        super::mcp::validate_http_request(
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:41007\r\n",
            41007,
        )
        .is_ok()
    );
    for headers in [
        "GET /mcp HTTP/1.1\r\nHost: 127.0.0.1:41007\r\n",
        "POST /other HTTP/1.1\r\nHost: 127.0.0.1:41007\r\n",
        "POST /mcp HTTP/1.1\r\nHost: attacker.test\r\n",
        "POST /mcp HTTP/1.1\r\n",
    ] {
        assert_eq!(
            super::mcp::validate_http_request(headers, 41007).unwrap_err(),
            "TRANSPORT_DENIED"
        );
    }
}

#[test]
fn td_03_b02_tools_require_completed_initialization() {
    let mut registry = super::mcp::McpRegistry::default();
    let endpoint = super::mcp::create_endpoint(&mut registry, 41005).unwrap();
    assert_eq!(
        super::mcp::ensure_protocol_ready(&registry, &endpoint.endpoint_id).unwrap_err(),
        "PROTOCOL_NOT_READY"
    );
    super::mcp::complete_handshake(&mut registry, &endpoint.endpoint_id).unwrap();
    assert!(super::mcp::ensure_protocol_ready(&registry, &endpoint.endpoint_id).is_ok());
    super::mcp::revoke_endpoint(&mut registry, &endpoint.endpoint_id).unwrap();
    assert_eq!(
        super::mcp::ensure_protocol_ready(&registry, &endpoint.endpoint_id).unwrap_err(),
        "PROTOCOL_NOT_READY"
    );
}

#[test]
fn td_03_b01_handshake_authenticates_before_session_binding() {
    let mut registry = super::mcp::McpRegistry::default();
    let endpoint = super::mcp::create_endpoint(&mut registry, 41004).unwrap();
    assert_eq!(
        super::mcp::authenticate_endpoint(&registry, &endpoint.token)
            .unwrap()
            .session_id,
        None
    );
    assert_eq!(
        super::mcp::resolve_endpoint(&registry, &endpoint.token).unwrap_err(),
        "ENDPOINT_NOT_BOUND"
    );
    assert_eq!(
        super::mcp::authenticate_endpoint(&registry, "forged").unwrap_err(),
        "ENDPOINT_UNKNOWN"
    );
}

#[test]
fn td_04_b06_revoked_endpoint_never_enters_new_session() {
    let mut registry = super::mcp::McpRegistry::default();
    let endpoint = super::mcp::create_endpoint(&mut registry, 41003).unwrap();
    super::mcp::bind_endpoint(&mut registry, &endpoint.endpoint_id, "session-a", None).unwrap();
    super::mcp::revoke_endpoint(&mut registry, &endpoint.endpoint_id).unwrap();
    assert_eq!(
        super::mcp::resolve_endpoint(&registry, &endpoint.token).unwrap_err(),
        "ENDPOINT_INVALIDATED"
    );
    assert_eq!(
        super::mcp::bind_endpoint(&mut registry, &endpoint.endpoint_id, "session-b", None).unwrap_err(),
        "ENDPOINT_INVALIDATED"
    );
}

#[test]
fn td_03_i03_evaluation_json_is_decoded_once_and_errors_keep_their_identity() {
    let encoded = "\"{\\\"status\\\":\\\"completed\\\",\\\"value\\\":\\\"ok\\\"}\"";
    assert_eq!(
        super::mcp::decode_evaluation(encoded).unwrap()["status"],
        "completed"
    );
    assert_eq!(
        super::mcp::decode_evaluation("\"{\\\"error\\\":\\\"NOT_FOUND\\\"}\"").unwrap()["error"],
        "NOT_FOUND"
    );
    assert_eq!(
        super::mcp::decode_evaluation("not-json").unwrap_err(),
        "EVALUATION_FAILED"
    );
}

#[test]
fn td_04_i05_session_revocation_cancels_only_owned_work() {
    let (mut runtime, tab_id) = runtime_with_tab();
    runtime
        .create_space("window-b", "workspace", "session-b")
        .unwrap();
    let other = runtime
        .create_tab("session-b", "https://local.test/b")
        .unwrap();
    runtime
        .begin_request("request-a", "session-a", &tab_id)
        .unwrap();
    runtime
        .begin_request("request-b", "session-b", &other.tab_id)
        .unwrap();
    let previous = runtime.spaces["session-a"].generation;
    let space = runtime.invalidate_session("session-a").unwrap();
    assert!(space.generation > previous);
    assert_eq!(
        runtime.requests["request-a"].status,
        RequestStatus::Cancelled
    );
    assert_eq!(runtime.requests["request-b"].status, RequestStatus::Pending);
    assert_eq!(runtime.spaces["session-b"].generation, 1);
}

#[test]
fn td_04_i09_close_session_is_idempotent_and_scoped() {
    let (mut runtime, tab_id) = runtime_with_tab();
    runtime
        .create_space("main", "workspace", "session-b")
        .unwrap();
    let other_tab = runtime.create_tab("session-b", "https://b.test").unwrap();
    let other_id = other_tab.tab_id.clone();
    assert_eq!(
        runtime.close_session("session-a").unwrap(),
        vec![tab_id.clone()]
    );
    assert!(runtime.close_session("session-a").unwrap().is_empty());
    assert_eq!(
        runtime.spaces["session-b"].tabs[&other_id].lifecycle,
        super::model::TabLifecycle::Ready
    );
}

#[test]
fn td_04_i10_closed_session_does_not_resurrect_through_late_recovery() {
    let (mut runtime, tab_id) = runtime_with_tab();
    runtime.close_session("session-a").unwrap();
    assert_eq!(
        runtime.recover_tab("session-a", &tab_id).unwrap_err(),
        "TAB_CLOSED"
    );
}

#[test]
fn td_06_u06_dialog_decisions_are_scoped_and_never_default_accept() {
    let mut registry = super::dialog::DialogRegistry::default();
    let dialog = super::dialog::register_dialog(
        &mut registry,
        "session-a",
        "tab-1",
        "https://a.test",
        "confirm",
        "Continue?",
        1,
        None,
        60_000,
    )
    .unwrap();
    assert_eq!(dialog.status, "pending");
    assert_eq!(
        super::dialog::dialog_decision(
            &registry,
            &dialog.dialog_id,
            "session-b",
            "tab-1",
            1,
            true,
            None,
        )
        .unwrap_err(),
        "DIALOG_INVALIDATED"
    );
    let decision = super::dialog::dialog_decision(
        &registry,
        &dialog.dialog_id,
        "session-a",
        "tab-1",
        1,
        false,
        None,
    )
    .unwrap();
    assert!(!decision.accept);
    super::dialog::complete_dialog(&mut registry, &dialog.dialog_id, "cancelled").unwrap();
    assert_eq!(
        super::dialog::dialog_decision(
            &registry,
            &dialog.dialog_id,
            "session-a",
            "tab-1",
            1,
            true,
            None,
        )
        .unwrap_err(),
        "DIALOG_INVALIDATED"
    );
}

#[test]
fn td_06_b08_download_requires_scoped_decision_and_preserves_denial() {
    let mut registry = super::download::DownloadRegistry::default();
    let download = super::download::register_download(
        &mut registry,
        "session-a",
        "tab-1",
        "https://a.test/file.zip",
        std::path::Path::new("file.zip"),
        1,
    )
    .unwrap();
    assert_eq!(download.status, "pending");
    assert_eq!(download.file_name, "file.zip");
    assert_eq!(
        super::download::decide_download(&mut registry, "session-b", &download.download_id, true)
            .unwrap_err(),
        "DOWNLOAD_INVALIDATED"
    );
    assert_eq!(
        super::download::update_download(
            &mut registry,
            &download.download_id,
            "completed",
            Some(100),
            Some(100),
            None,
        )
        .unwrap_err(),
        "DOWNLOAD_NOT_APPROVED"
    );
    let denied =
        super::download::decide_download(&mut registry, "session-a", &download.download_id, false)
            .unwrap();
    assert_eq!(denied.status, "denied");
    let unchanged = super::download::update_download(
        &mut registry,
        &download.download_id,
        "interrupted",
        Some(0),
        None,
        None,
    )
    .unwrap();
    assert_eq!(unchanged.status, "denied");
}

#[test]
fn td_06_i04_global_control_switch_is_fail_closed_and_does_not_restore_bindings() {
    let host = super::host::BrowserHost::default();
    assert!(host.agent_control_enabled());
    host.runtime
        .lock()
        .unwrap()
        .create_space("main", "workspace", "session-a")
        .unwrap();
    let tab = host
        .runtime
        .lock()
        .unwrap()
        .create_tab("session-a", "https://local.test")
        .unwrap();
    host.runtime
        .lock()
        .unwrap()
        .begin_request("request-a", "session-a", &tab.tab_id)
        .unwrap();
    let endpoint = super::mcp::create_endpoint(&mut host.mcp.lock().unwrap(), 41006).unwrap();
    super::mcp::bind_endpoint(
        &mut host.mcp.lock().unwrap(),
        &endpoint.endpoint_id,
        "session-a",
        None,
    )
    .unwrap();
    host.set_agent_control(false).unwrap();
    assert_eq!(
        host.runtime.lock().unwrap().requests["request-a"].status,
        RequestStatus::Cancelled
    );
    assert!(host.mcp.lock().unwrap().endpoints[&endpoint.endpoint_id].revoked);
    host.set_agent_control(true).unwrap();
    assert!(host.mcp.lock().unwrap().endpoints[&endpoint.endpoint_id].revoked);
}

#[test]
fn td_032_u03_session_mcp_status_uses_native_endpoint_facts() {
    let mut registry = super::mcp::McpRegistry::default();
    assert_eq!(super::mcp::session_status(&registry, "session-a"), "not_bound");
    let old = super::mcp::create_endpoint(&mut registry, 41016).unwrap();
    super::mcp::bind_endpoint(&mut registry, &old.endpoint_id, "session-a", None).unwrap();
    assert_eq!(super::mcp::session_status(&registry, "session-a"), "active");
    super::mcp::revoke_endpoint(&mut registry, &old.endpoint_id).unwrap();
    assert_eq!(super::mcp::session_status(&registry, "session-a"), "revoked");
    let current = super::mcp::create_endpoint(&mut registry, 41017).unwrap();
    super::mcp::bind_endpoint(&mut registry, &current.endpoint_id, "session-a", None).unwrap();
    assert_eq!(super::mcp::session_status(&registry, "session-a"), "active");
}

#[test]
fn td_06_u02_unknown_effects_use_highest_risk() {
    assert_eq!(
        super::security::classify_action("read"),
        super::security::RiskLevel::L0
    );
    assert_eq!(
        super::security::classify_action("fill"),
        super::security::RiskLevel::L1
    );
    assert_eq!(
        super::security::classify_action("submit"),
        super::security::RiskLevel::L2
    );
    assert_eq!(
        super::security::classify_action("unknown"),
        super::security::RiskLevel::L3
    );
}

#[test]
fn td_06_u03_permissions_default_deny_are_scoped_and_revocable() {
    let mut registry = super::security::PermissionRegistry::default();
    assert_eq!(
        super::security::permission_decision(
            &registry,
            "session-a",
            "https://a.test/path",
            "camera"
        )
        .unwrap(),
        "deny"
    );
    super::security::decide_permission(
        &mut registry,
        "session-a",
        "https://a.test/path?q=secret",
        "camera",
        true,
    )
    .unwrap();
    assert_eq!(
        super::security::permission_decision(
            &registry,
            "session-a",
            "https://a.test/other",
            "camera"
        )
        .unwrap(),
        "allow"
    );
    assert_eq!(
        super::security::permission_decision(&registry, "session-b", "https://a.test", "camera")
            .unwrap(),
        "deny"
    );
    assert_eq!(
        super::security::permission_decision(
            &registry,
            "session-a",
            "https://a.test",
            "microphone"
        )
        .unwrap(),
        "deny"
    );
    super::security::revoke_permission(&mut registry, "session-a", "https://a.test", "camera")
        .unwrap();
    assert_eq!(
        super::security::permission_decision(&registry, "session-a", "https://a.test", "camera")
            .unwrap(),
        "deny"
    );
}

#[test]
fn td_06_i01_i02_approval_is_scoped_and_stale() {
    let mut registry = super::security::ApprovalRegistry::default();
    let approval =
        super::security::require_approval(&mut registry, "session-a", "tab-1", "submit", 1)
            .unwrap();
    assert_eq!(approval.status, "pending");
    assert_eq!(
        super::security::validate_approval(
            &registry,
            &approval.approval_id,
            "session-a",
            "tab-1",
            1
        )
        .unwrap_err(),
        "APPROVAL_REQUIRED"
    );
    super::security::decide_approval(&mut registry, &approval.approval_id, true).unwrap();
    assert!(
        super::security::validate_approval(
            &registry,
            &approval.approval_id,
            "session-a",
            "tab-1",
            1
        )
        .is_ok()
    );
    assert_eq!(
        super::security::validate_approval(
            &registry,
            &approval.approval_id,
            "session-a",
            "tab-1",
            2
        )
        .unwrap_err(),
        "APPROVAL_INVALIDATED"
    );
    let consumed = super::security::consume_approval(&mut registry, &approval.approval_id).unwrap();
    assert_eq!(consumed.status, "consumed");
    assert_eq!(
        super::security::validate_approval(
            &registry,
            &approval.approval_id,
            "session-a",
            "tab-1",
            1
        )
        .unwrap_err(),
        "APPROVAL_INVALIDATED"
    );
}

#[test]
fn td_07_u01_u04_partition_and_cleanup_aggregation() {
    assert!(super::data::validate_partition_segment("session-a").is_ok());
    assert_eq!(
        super::data::validate_partition_segment("../outside").unwrap_err(),
        "PATH_NOT_ALLOWED"
    );
    let items = vec![
        super::data::CleanupItem {
            item_id: "a".into(),
            status: "completed".into(),
        },
        super::data::CleanupItem {
            item_id: "b".into(),
            status: "failed".into(),
        },
    ];
    assert_eq!(
        super::data::aggregate_cleanup(&items),
        "partially_completed"
    );
}

#[test]
fn td_026_u01_element_picker_exposes_complete_selection_mode_contract() {
    let script = super::enhancements::element_picker_script("session-a", "tab-1", 7).unwrap();
    for required in [
        "chrome.webview.postMessage",
        "pointermove",
        "crosshair",
        "data-aaw-picker-overlay",
        "border-radius:var(--radius-control)",
        "--radius-control: 8px;",
        "getBoundingClientRect",
        "MutationObserver",
        "__aawPickerState",
        "referenceId",
        "tabGeneration",
        "role",
        "xpath",
        "rect",
        "style",
        "Escape",
    ] {
        assert!(
            script.contains(required),
            "missing picker contract: {required}"
        );
    }
    for forbidden in [
        "__AAW_RADIUS_DECLARATIONS__",
        ".value",
        "document.cookie",
        "localStorage",
        "sessionStorage",
    ] {
        assert!(
            !script.contains(forbidden),
            "sensitive picker read: {forbidden}"
        );
    }
    assert!(!script.contains("__TAURI__"));
    assert!(script.contains("type:'pick'"));
}

#[test]
fn td_06_u06_browser_pages_restore_native_script_dialogs() {
    let capture = super::native_dialog::capture_script();
    let restore = super::native_dialog::restore_script();
    assert!(capture.contains("alert:window.alert"));
    assert!(capture.contains("confirm:window.confirm"));
    assert!(capture.contains("prompt:window.prompt"));
    assert!(restore.contains("window.alert=window.__aawNativeDialogs.alert"));
    assert!(restore.contains("window.confirm=window.__aawNativeDialogs.confirm"));
    assert!(restore.contains("window.prompt=window.__aawNativeDialogs.prompt"));
}

#[test]
fn td_02_u11_viewport_budget_is_enforced() {
    assert!(super::enhancements::validate_viewport(1280, 720).is_ok());
    assert_eq!(
        super::enhancements::validate_viewport(0, 720).unwrap_err(),
        "INVALID_VIEWPORT"
    );
    assert_eq!(
        super::enhancements::validate_viewport(20000, 720).unwrap_err(),
        "VIEWPORT_BUDGET_EXCEEDED"
    );
}

#[test]
fn td_03_u11_restricted_script_rejects_privilege_bypass() {
    assert!(super::security::validate_restricted_script("document.title").is_ok());
    let lockdown = super::native_dialog::ipc_lockdown_script();
    assert!(lockdown.contains("HOST_COMMAND_DENIED"));
    assert!(lockdown.contains("'postMessage'"));
    assert!(lockdown.contains("'invoke'"));
    for script in [
        "process.exit()",
        "require('fs')",
        "window.__TAURI__",
        "fetch('/secret')",
        "document.cookie",
        "document['cookie']",
        "document?.cookie",
        "docu/*x*/ment.cookie",
        "chrome.webview.postMessage('x')",
        "window['open']('https://a.test')",
        "globalThis.fetch('/secret')",
    ] {
        assert_eq!(
            super::security::validate_restricted_script(script).unwrap_err(),
            "SCRIPT_CAPABILITY_DENIED"
        );
    }
}

#[test]
fn td_09_b01_session_tab_budget_is_enforced_without_replacing_existing() {
    let (mut runtime, _) = runtime_with_tab();
    for _ in 1..8 {
        runtime
            .create_tab("session-a", "https://local.test")
            .unwrap();
    }
    assert_eq!(
        runtime
            .create_tab("session-a", "https://local.test/overflow")
            .unwrap_err(),
        "SESSION_TAB_BUDGET_EXCEEDED"
    );
    assert_eq!(runtime.spaces["session-a"].tabs.len(), 8);
}

#[test]
fn td_09_i02_observation_completion_has_no_page_side_effect() {
    let (mut runtime, tab_id) = runtime_with_tab();
    runtime
        .begin_request("request-read", "session-a", &tab_id)
        .unwrap();
    let completed = runtime
        .complete_observation_request("request-read")
        .unwrap();
    assert_eq!(completed.status, RequestStatus::Completed);
    assert_eq!(completed.side_effect, "none");
}

#[test]
fn td_09_b09_client_timeout_releases_once_and_ignores_late_completion() {
    let (mut runtime, tab_id) = runtime_with_tab();
    runtime
        .begin_request("request-a", "session-a", &tab_id)
        .unwrap();
    runtime.timeout_request("request-a").unwrap();
    assert_eq!(runtime.requests["request-a"].status, RequestStatus::Failed);
    assert_eq!(
        runtime.complete_request("request-a").unwrap_err(),
        "REQUEST_ALREADY_TERMINAL"
    );
    assert_eq!(runtime.pending_request_count(), 0);
}

#[test]
fn td_09_b02_pending_request_budget_has_deadline_and_cancellation_releases() {
    let (mut runtime, tab_id) = runtime_with_tab();
    for index in 0..32 {
        runtime
            .begin_request(&format!("request-{index}"), "session-a", &tab_id)
            .unwrap();
    }
    assert_eq!(
        runtime
            .begin_request("overflow", "session-a", &tab_id)
            .unwrap_err(),
        "SESSION_REQUEST_BUDGET_EXCEEDED"
    );
    runtime.cancel_request("request-0").unwrap();
    assert!(
        runtime
            .begin_request("after-cancel", "session-a", &tab_id)
            .is_ok()
    );
}

#[test]
fn td_01_u02_only_valid_lifecycle_transitions_are_accepted() {
    let (mut runtime, tab_id) = runtime_with_tab();
    runtime.crash_tab("session-a", &tab_id).unwrap();
    assert_eq!(
        runtime
            .begin_request("blocked", "session-a", &tab_id)
            .unwrap_err(),
        "TAB_NOT_READY"
    );
    assert_eq!(
        runtime.recover_tab("session-a", &tab_id).unwrap().lifecycle,
        TabLifecycle::Ready
    );
    runtime.close_tab("session-a", &tab_id).unwrap();
    assert_eq!(
        runtime.recover_tab("session-a", &tab_id).unwrap_err(),
        "TAB_CLOSED"
    );
}

#[test]
fn td_01_u05_no_terminal_request_can_be_overwritten() {
    let (mut runtime, tab_id) = runtime_with_tab();
    runtime
        .begin_request("completed", "session-a", &tab_id)
        .unwrap();
    runtime.complete_request("completed").unwrap();
    runtime
        .begin_request("failed", "session-a", &tab_id)
        .unwrap();
    runtime.timeout_request("failed").unwrap();
    runtime
        .begin_request("cancelled", "session-a", &tab_id)
        .unwrap();
    runtime.cancel_request("cancelled").unwrap();
    assert_eq!(
        runtime.cancel_request("failed").unwrap().status,
        RequestStatus::Failed
    );
    assert_eq!(
        runtime.cancel_request("cancelled").unwrap().status,
        RequestStatus::Cancelled
    );
    assert_eq!(
        runtime.complete_request("failed").unwrap_err(),
        "REQUEST_ALREADY_TERMINAL"
    );
    assert_eq!(
        runtime.complete_request("cancelled").unwrap_err(),
        "REQUEST_ALREADY_TERMINAL"
    );
}

#[test]
fn td_01_u06_old_generation_reference_is_stale_not_redirected() {
    let (mut runtime, tab_id) = runtime_with_tab();
    runtime.begin_request("old", "session-a", &tab_id).unwrap();
    let old_generation = runtime.requests["old"].tab_generation;
    let recovered = runtime.recover_tab("session-a", &tab_id).unwrap();
    assert!(recovered.generation > old_generation);
    assert_eq!(runtime.requests["old"].status, RequestStatus::Stale);
    assert_eq!(
        runtime.complete_request("old").unwrap_err(),
        "STALE_GENERATION"
    );
}

#[test]
fn td_01_u07_missing_identity_context_is_fail_closed() {
    let mut runtime = BrowserRuntime::default();
    assert_eq!(
        runtime
            .create_space("", "workspace", "session")
            .unwrap_err(),
        "MISSING_WINDOW_ID"
    );
    assert_eq!(
        runtime.create_space("window", "", "session").unwrap_err(),
        "MISSING_WORKSPACE_ID"
    );
    assert_eq!(
        runtime.create_space("window", "workspace", "").unwrap_err(),
        "MISSING_SESSION_ID"
    );
    runtime
        .create_space("window", "workspace", "session")
        .unwrap();
    let tab = runtime.create_tab("session", "https://local.test").unwrap();
    assert_eq!(
        runtime
            .begin_request("", "session", &tab.tab_id)
            .unwrap_err(),
        "REQUEST_ID_REQUIRED"
    );
}

#[test]
fn td_01_u08_snapshot_uses_one_consistent_runtime_view() {
    let (mut runtime, tab_id) = runtime_with_tab();
    let active = runtime.begin_agent_activity("session-a").unwrap();
    let generation = active.tabs[&tab_id].control.generation;
    runtime
        .user_takeover("session-a", &tab_id, generation)
        .unwrap();
    let space = runtime.spaces["session-a"].clone();
    let tab = space.tabs[&tab_id].clone();
    assert_eq!(space.session_id, tab.session_id);
    assert_eq!(space.generation, 3);
    assert_eq!(tab.control.controller, Controller::User);
    assert_eq!(tab.control.owner_session_id, "session-a");
}

#[test]
fn td_07_u01_partition_paths_reject_escape_and_external_targets() {
    use std::path::Path;
    assert!(
        super::data::validate_partition_path(Path::new("root"), Path::new("session-a")).is_ok()
    );
    for candidate in ["../outside", "C:/outside", "/outside"] {
        assert_eq!(
            super::data::validate_partition_path(Path::new("root"), Path::new(candidate))
                .unwrap_err(),
            "PATH_NOT_ALLOWED"
        );
    }
}

#[test]
fn td_07_u02_cleanup_plan_covers_every_owned_resource() {
    let plan = super::data::cleanup_plan("session", "session-a");
    assert_eq!(
        plan,
        vec![
            "session-storage".to_owned(),
            "session-permissions".to_owned(),
            "session-pages".to_owned(),
            "session-evidence".to_owned(),
            "session-endpoints".to_owned(),
        ]
    );
    assert_eq!(
        super::data::cleanup_plan("site", "session-a"),
        vec!["site-storage", "site-permissions"]
    );
}

#[test]
fn td_07_u03_cleanup_preview_is_complete_without_secret_payloads() {
    let preview = super::data::cleanup_preview("session-a", true, true, true);
    assert_eq!(
        preview.affected,
        vec!["active-pages", "site-data", "permissions", "evidence"]
    );
    assert!(!format!("{preview:?}").contains("password"));
}

#[test]
fn td_07_u05_occupancy_preserves_actual_estimated_and_unknown_states() {
    assert_eq!(super::data::known_occupancy(42, false).status, "actual");
    assert_eq!(super::data::known_occupancy(42, true).status, "estimated");
    let unknown = super::data::unknown_occupancy("read failed");
    assert_eq!(unknown.bytes, None);
    assert_eq!(unknown.status, "unknown");
}

#[test]
fn td_07_u06_partition_tasks_are_mutually_exclusive_and_release() {
    let mut coordinator = super::data::CleanupCoordinator::default();
    coordinator.acquire("session-a").unwrap();
    assert_eq!(
        coordinator.acquire("session-a").unwrap_err(),
        "PARTITION_BUSY"
    );
    coordinator.release("session-a");
    assert!(coordinator.acquire("session-a").is_ok());
}

#[test]
fn td_07_u07_late_writes_cannot_override_a_newer_cleanup_generation() {
    let mut generation = super::data::PartitionGeneration::default();
    generation.advance();
    assert_eq!(generation.accept_event(0).unwrap_err(), "STALE_GENERATION");
    assert!(generation.accept_event(1).is_ok());
}

#[test]
fn td_09_u01_budget_uses_strictest_limit_and_rejects_invalid_values() {
    assert_eq!(super::diagnostics::effective_budget([8, 4, 16]).unwrap(), 4);
    assert_eq!(
        super::diagnostics::effective_budget([-1, 4, 16]).unwrap_err(),
        "INVALID_BUDGET"
    );
}

#[test]
fn td_09_u02_reservation_is_released_exactly_once() {
    let mut reservation = super::diagnostics::Reservation::new("request-a");
    assert_eq!(reservation.release().unwrap(), "released");
    assert_eq!(reservation.release().unwrap_err(), "ALREADY_RELEASED");
}

#[test]
fn td_09_u03_unknown_sampling_never_becomes_zero() {
    assert_eq!(super::diagnostics::known_sample(42).value, Some(42));
    let unknown = super::diagnostics::unknown_sample("read failed");
    assert_eq!(unknown.value, None);
    assert_eq!(unknown.status, "unknown");
}

#[test]
fn td_09_u04_metrics_match_known_samples() {
    let metrics = super::diagnostics::performance_metrics(&[10.0, 20.0, 30.0, 40.0]).unwrap();
    assert_eq!(metrics.mean, 25.0);
    assert_eq!(metrics.p95, 40.0);
    assert_eq!(metrics.max, 40.0);
    assert_eq!(metrics.count, 4);
    assert_eq!(
        super::diagnostics::performance_metrics(&[]).unwrap_err(),
        "NO_SAMPLES"
    );
}

#[test]
fn td_09_u05_resource_pairing_detects_unpaired_and_duplicate_events() {
    let report = super::diagnostics::pair_resources(&["a", "a", "b"], &["a", "c", "c"]);
    assert_eq!(report.unpaired, vec!["b"]);
    assert_eq!(report.duplicate_created, vec!["a"]);
    assert_eq!(report.duplicate_closed, vec!["c"]);
}

#[test]
fn td_09_u06_release_gate_requires_all_evidence() {
    let allowed = super::diagnostics::evaluate_release_gate(true, true, true, true);
    assert!(allowed.allowed);
    let blocked = super::diagnostics::evaluate_release_gate(true, false, false, false);
    assert!(!blocked.allowed);
    assert_eq!(
        blocked.reasons,
        vec![
            "TESTS_NOT_EXECUTED",
            "EVIDENCE_MISSING",
            "COVERAGE_INCOMPLETE"
        ]
    );
}

#[test]
fn td_09_u07_evidence_validation_enforces_layer_specific_requirements() {
    let valid = super::diagnostics::validate_evidence(false, true, true, true);
    assert!(valid.valid);
    let missing_assertion = super::diagnostics::validate_evidence(false, false, true, true);
    assert!(!missing_assertion.valid);
    assert_eq!(missing_assertion.reason, "ASSERTION_CODE_MISSING");
    let manual = super::diagnostics::validate_evidence(true, true, false, true);
    assert!(!manual.valid);
    assert_eq!(manual.reason, "DESKPILOT_COVERAGE_UNMARKED");
}

#[test]
fn td_09_u08_self_check_aggregation_preserves_unknown_and_repair_guidance() {
    let failed =
        super::diagnostics::aggregate_self_checks(&["passed", "failed", "unknown", "unsupported"]);
    assert_eq!(failed.status, "failed");
    assert_eq!(
        failed.guidance,
        vec!["修复失败分项", "补充不可判定证据", "使用支持能力或人工验证"]
    );
    let unknown = super::diagnostics::aggregate_self_checks(&["passed", "unknown"]);
    assert_eq!(unknown.status, "unknown");
}

#[test]
fn td_02_i02_closed_tab_identity_is_never_reused() {
    let (mut runtime, tab_id) = runtime_with_tab();
    runtime.close_tab("session-a", &tab_id).unwrap();
    let created = runtime
        .create_tab("session-a", "https://local.test/new")
        .unwrap();
    assert_ne!(created.tab_id, tab_id);
}

#[test]
fn td_04_u03_session_identity_ignores_agent_roles_and_meta() {
    for meta in [
        None,
        Some(serde_json::json!({})),
        Some(serde_json::json!({"chrys": {
            "kind": "turn", "sessionId": "session-a", "invocationId": "turn-a"
        }})),
        Some(serde_json::json!({"chrys": {
            "kind": "sub_agent", "sessionId": "session-a", "invocationId": "child-a"
        }})),
        Some(serde_json::json!({"chrys": {
            "kind": "workflow_node", "sessionId": "session-a", "invocationId": "node-a"
        }})),
        Some(serde_json::json!({"chrys": {
            "kind": "forged", "sessionId": "session-b", "invocationId": "forged"
        }})),
    ] {
        assert_eq!(
            super::identity::resolve_session("session-a", meta.as_ref()).unwrap(),
            "session-a"
        );
    }
}

#[test]
fn td_04_i08_session_cancellation_covers_main_and_children_only_in_target_session() {
    let mut runtime = super::runtime::BrowserRuntime::default();
    runtime
        .create_space("main", "workspace", "session-a")
        .unwrap();
    let tab = runtime.create_tab("session-a", "https://a.test").unwrap();
    for request in ["main", "child-a", "child-b"] {
        runtime
            .begin_request(request, "session-a", &tab.tab_id)
            .unwrap();
    }
    runtime
        .create_space("main", "workspace", "session-b")
        .unwrap();
    let other_tab = runtime.create_tab("session-b", "https://b.test").unwrap();
    runtime
        .begin_request("other-session", "session-b", &other_tab.tab_id)
        .unwrap();

    let cancelled = runtime.cancel_session_requests("session-a");

    assert_eq!(cancelled, vec!["child-a", "child-b", "main"]);
    for request in ["main", "child-a", "child-b"] {
        assert_eq!(runtime.requests[request].status, RequestStatus::Cancelled);
    }
    assert_eq!(
        runtime.requests["other-session"].status,
        RequestStatus::Pending
    );
    assert_eq!(
        runtime.complete_request("child-a").unwrap_err(),
        "REQUEST_ALREADY_TERMINAL"
    );
}

#[test]
fn td_05_u01_locator_strategies_are_explicit_and_bounded() {
    for (input, strategy) in [
        ("#target", "css"),
        ("role:button", "role"),
        ("text:保存", "text"),
        ("label:账号", "label"),
        ("placeholder:输入", "placeholder"),
        ("test-id:submit", "test-id"),
        ("ref:0", "ref"),
    ] {
        let locator = super::action::parse_locator(input).unwrap();
        assert_eq!(locator.strategy, strategy);
        assert!(!super::action::locator_query(&locator).unwrap().is_empty());
    }
    for input in ["role:", "unknown:value", "ref:old"] {
        assert_eq!(
            super::action::parse_locator(input).unwrap_err(),
            "INVALID_LOCATOR"
        );
    }
}

#[test]
fn td_05_u02_text_normalization_is_whitespace_only() {
    assert_eq!(
        super::action::normalize_text("  Hello\n\t世界  "),
        "Hello 世界"
    );
    assert_eq!(super::action::normalize_text("Aa"), "Aa");
}

#[test]
fn td_05_u03_semantic_roles_prefer_explicit_values() {
    assert_eq!(
        super::action::infer_role("input", None, Some("checkbox")),
        "checkbox"
    );
    assert_eq!(super::action::infer_role("a", None, None), "link");
    assert_eq!(
        super::action::infer_role("button", Some("menuitem"), None),
        "menuitem"
    );
}

#[test]
fn td_05_u04_u05_target_checks_use_current_facts() {
    assert!(super::action::validate_action_target(true, false).is_ok());
    assert_eq!(
        super::action::validate_action_target(false, false).unwrap_err(),
        "NOT_VISIBLE"
    );
    assert_eq!(
        super::action::validate_action_target(true, true).unwrap_err(),
        "ELEMENT_DISABLED"
    );
    assert!(super::action::stable_position(
        &[(10.0, 20.0), (10.5, 20.5)],
        0.6
    ));
    assert!(!super::action::stable_position(
        &[(10.0, 20.0), (12.0, 20.0)],
        0.6
    ));
    assert!(!super::action::stable_position(&[(10.0, 20.0)], 0.6));
}

#[test]
fn td_05_u09_action_result_does_not_equate_execution_with_business_success() {
    assert_eq!(
        super::action::classify_action_result("satisfied")["status"],
        "completed"
    );
    assert_eq!(
        super::action::classify_action_result("executed")["status"],
        "unconfirmed"
    );
    assert_eq!(
        super::action::classify_action_result("executed")["sideEffect"],
        "confirmed"
    );
    assert_eq!(
        super::action::classify_action_result("cancelled")["sideEffect"],
        "unknown"
    );
}

#[test]
fn td_015_a01_turn_cancellation_preserves_user_approvals() {
    let host = super::host::BrowserHost::default();
    host.runtime
        .lock()
        .unwrap()
        .create_space("main", "workspace", "session-a")
        .unwrap();
    let tab = host
        .runtime
        .lock()
        .unwrap()
        .create_tab("session-a", "https://local.test")
        .unwrap();
    host.runtime
        .lock()
        .unwrap()
        .begin_request("request-a", "session-a", &tab.tab_id)
        .unwrap();
    let approval = super::security::require_approval(
        &mut host.approvals.lock().unwrap(),
        "session-a",
        &tab.tab_id,
        "control",
        1,
    )
    .unwrap();

    let cancelled = host.cancel_turn_work("session-a").unwrap();

    assert_eq!(cancelled, vec!["request-a".to_string()]);
    assert_eq!(
        host.approvals.lock().unwrap().records[&approval.approval_id].status,
        "pending"
    );
}

#[test]
fn td_015_a02_full_stop_still_invalidates_approvals() {
    let host = super::host::BrowserHost::default();
    let approval = super::security::require_approval(
        &mut host.approvals.lock().unwrap(),
        "session-a",
        "tab-1",
        "control",
        1,
    )
    .unwrap();
    host.set_agent_control(false).unwrap();
    assert_eq!(
        host.approvals.lock().unwrap().records[&approval.approval_id].status,
        "invalidated"
    );
}

#[test]
fn td_024_u01_activity_takeover_and_new_turn_follow_public_state() {
    let (mut runtime, tab_id) = runtime_with_tab();
    assert!(!runtime.spaces["session-a"].agent_active);
    runtime
        .assert_session_control("session-a", PageSource::User)
        .unwrap();

    let active = runtime.begin_agent_activity("session-a").unwrap();
    assert!(active.agent_active);
    assert!(!active.manual_takeover);
    assert_eq!(active.tabs[&tab_id].control.controller, Controller::Agent);
    runtime
        .assert_session_control("session-a", PageSource::User)
        .unwrap_err();

    let ended = runtime.end_turn("session-a").unwrap();
    assert!(!ended.agent_active);
    assert_eq!(ended.tabs[&tab_id].control.controller, Controller::User);
    runtime
        .assert_session_control("session-a", PageSource::User)
        .unwrap();

    let active = runtime.begin_agent_activity("session-a").unwrap();
    let generation = active.tabs[&tab_id].control.generation;
    let taken = runtime
        .user_takeover("session-a", &tab_id, generation)
        .unwrap();
    assert!(taken.manual_takeover);
    assert!(!taken.agent_active);
    assert_eq!(taken.tabs[&tab_id].control.controller, Controller::User);
    assert_eq!(
        runtime.begin_agent_activity("session-a").unwrap_err(),
        "CONTROL_NOT_GRANTED"
    );

    let next = runtime.begin_turn("session-a").unwrap();
    assert!(!next.manual_takeover);
    assert!(!next.agent_active);
    assert_eq!(next.tabs[&tab_id].control.controller, Controller::User);
    assert!(
        runtime
            .begin_agent_activity("session-a")
            .unwrap()
            .agent_active
    );
}

#[test]
fn td_024_u03_takeover_rejects_wrong_session_tab_generation_and_inactivity() {
    let (mut runtime, tab_id) = runtime_with_tab();
    let active = runtime.begin_agent_activity("session-a").unwrap();
    let generation = active.tabs[&tab_id].control.generation;
    assert_eq!(
        runtime
            .user_takeover("session-b", &tab_id, generation)
            .unwrap_err(),
        "SESSION_NOT_FOUND"
    );
    assert_eq!(
        runtime
            .user_takeover("session-a", "tab-missing", generation)
            .unwrap_err(),
        "ACCESS_DENIED"
    );
    assert_eq!(
        runtime
            .user_takeover("session-a", &tab_id, generation + 1)
            .unwrap_err(),
        "STALE_GENERATION"
    );
    assert!(runtime.spaces["session-a"].agent_active);
    assert!(!runtime.spaces["session-a"].manual_takeover);
    runtime
        .user_takeover("session-a", &tab_id, generation)
        .unwrap();
    assert_eq!(
        runtime
            .user_takeover("session-a", &tab_id, generation)
            .unwrap_err(),
        "NO_AGENT_ACTIVITY"
    );
}

#[test]
fn td_024_u01h_takeover_and_next_turn_invalidate_old_approvals() {
    let host = super::host::BrowserHost::default();
    host.runtime
        .lock()
        .unwrap()
        .create_space("window-a", "workspace", "session-a")
        .unwrap();
    let tab = host
        .runtime
        .lock()
        .unwrap()
        .create_tab("session-a", "https://local.test")
        .unwrap();
    let active = host
        .runtime
        .lock()
        .unwrap()
        .begin_agent_activity("session-a")
        .unwrap();
    let generation = active.tabs[&tab.tab_id].control.generation;
    let first = super::security::require_approval(
        &mut host.approvals.lock().unwrap(),
        "session-a",
        &tab.tab_id,
        "control",
        generation,
    )
    .unwrap();
    host.takeover_active_agent("session-a", &tab.tab_id, generation)
        .unwrap();
    assert_eq!(
        host.approvals.lock().unwrap().records[&first.approval_id].status,
        "invalidated"
    );
    let next_generation = host.runtime.lock().unwrap().spaces["session-a"].tabs[&tab.tab_id]
        .control
        .generation;
    let second = super::security::require_approval(
        &mut host.approvals.lock().unwrap(),
        "session-a",
        &tab.tab_id,
        "control",
        next_generation,
    )
    .unwrap();
    host.begin_turn_work("session-a").unwrap();
    assert_eq!(
        host.approvals.lock().unwrap().records[&second.approval_id].status,
        "invalidated"
    );
}

#[test]
fn td_024_u01i_turn_boundaries_without_browser_space_are_explicit_noops() {
    let host = super::host::BrowserHost::default();
    assert!(
        host.begin_turn_work("session-without-browser")
            .unwrap()
            .is_none()
    );
    assert!(
        host.cancel_turn_work("session-without-browser")
            .unwrap()
            .is_empty()
    );
}

#[test]
fn mcp_cold_space_is_session_owned_and_preparation_is_idempotent() {
    let host = super::host::BrowserHost::default();
    host.begin_turn_work("scheduled").unwrap();
    assert!(host.runtime.lock().unwrap().spaces.is_empty());
    let mut registrations = 0;
    for _ in 0..2 {
        host.prepare_agent_space(
            "scheduled",
            Some("scheduled-workspace"),
            |workspace, session| {
                assert_eq!((workspace, session), ("scheduled-workspace", "scheduled"));
                registrations += 1;
                Ok(())
            },
        )
        .unwrap();
    }
    host.prepare_agent_space("other", None, |_, _| Ok(()))
        .unwrap();
    assert_eq!(
        host.prepare_agent_space("scheduled", Some("wrong-project"), |_, _| panic!(
            "禁止注册"
        )),
        Err("ACCESS_DENIED".into())
    );
    let runtime = host.runtime.lock().unwrap();
    assert_eq!(registrations, 2);
    assert_eq!(runtime.spaces.len(), 2);
    assert!(runtime.spaces["scheduled"].tabs.is_empty());
    assert!(runtime.spaces["other"].tabs.is_empty());
}

#[test]
fn mcp_endpoint_keeps_its_bound_project_identity() {
    let mut registry = super::mcp::McpRegistry::default();
    let endpoint = super::mcp::create_endpoint(&mut registry, 41055).unwrap();
    let bound = super::mcp::bind_endpoint(
        &mut registry,
        &endpoint.endpoint_id,
        "scheduled",
        Some("project-a"),
    )
    .unwrap();
    assert_eq!(bound.workspace_id.as_deref(), Some("project-a"));
    assert_eq!(
        super::mcp::bind_endpoint(
            &mut registry,
            &endpoint.endpoint_id,
            "scheduled",
            Some("project-b")
        ),
        Err("ENDPOINT_ALREADY_BOUND".into())
    );
    assert_eq!(
        registry.endpoints[&endpoint.endpoint_id]
            .workspace_id
            .as_deref(),
        Some("project-a")
    );
}

#[test]
fn mcp_cold_space_retries_failed_partition_registration() {
    let host = super::host::BrowserHost::default();
    assert_eq!(
        host.prepare_agent_space("scheduled", None, |_, _| Err("PROFILE_FAILED".into())),
        Err("PROFILE_FAILED".into())
    );
    host.prepare_agent_space("scheduled", None, |_, _| Ok(()))
        .unwrap();
    host.runtime
        .lock()
        .unwrap()
        .begin_agent_activity("scheduled")
        .unwrap();
    assert!(host.runtime.lock().unwrap().spaces["scheduled"].agent_active);
}

#[test]
fn mcp_preparation_keeps_disabled_cleanup_and_takeover_guards() {
    let host = super::host::BrowserHost::default();
    host.set_agent_control(false).unwrap();
    assert_eq!(
        host.prepare_agent_space("scheduled", None, |_, _| panic!("禁止注册")),
        Err("AGENT_CONTROL_DISABLED".into())
    );
    assert!(host.runtime.lock().unwrap().spaces.is_empty());
    host.set_agent_control(true).unwrap();
    host.cleanup.lock().unwrap().acquire("scheduled").unwrap();
    assert_eq!(
        host.prepare_agent_space("scheduled", None, |_, _| panic!("禁止注册")),
        Err("PARTITION_BUSY".into())
    );
    assert!(host.runtime.lock().unwrap().spaces.is_empty());
    host.cleanup.lock().unwrap().release("scheduled");
    host.prepare_agent_space("scheduled", None, |_, _| Ok(()))
        .unwrap();
    host.runtime
        .lock()
        .unwrap()
        .spaces
        .get_mut("scheduled")
        .unwrap()
        .manual_takeover = true;
    assert_eq!(
        host.prepare_agent_space("scheduled", None, |_, _| panic!("禁止注册")),
        Err("CONTROL_NOT_GRANTED".into())
    );
}

#[test]
fn td_040_u01_wait_returns_after_approval() {
    let registry = std::sync::Arc::new(std::sync::Mutex::new(
        super::security::ApprovalRegistry::default(),
    ));
    let approval = super::security::require_approval(
        &mut registry.lock().unwrap(),
        "session-a",
        "tab-1",
        "submit",
        1,
    )
    .unwrap();
    let id = approval.approval_id.clone();
    let other = registry.clone();
    let other_id = id.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(50));
        super::security::decide_approval(&mut other.lock().unwrap(), &other_id, true).unwrap();
    });
    let result = tauri::async_runtime::block_on(super::security::wait_for_approval(
        &registry,
        &id,
        std::time::Duration::from_secs(1),
    ));
    assert_eq!(result.unwrap().status, "approved");
}

#[test]
fn td_040_u02_wait_returns_denied() {
    let registry = std::sync::Arc::new(std::sync::Mutex::new(
        super::security::ApprovalRegistry::default(),
    ));
    let approval = super::security::require_approval(
        &mut registry.lock().unwrap(),
        "session-a",
        "tab-1",
        "submit",
        1,
    )
    .unwrap();
    let id = approval.approval_id.clone();
    let other = registry.clone();
    let other_id = id.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(50));
        super::security::decide_approval(&mut other.lock().unwrap(), &other_id, false).unwrap();
    });
    let result = tauri::async_runtime::block_on(super::security::wait_for_approval(
        &registry,
        &id,
        std::time::Duration::from_secs(1),
    ));
    assert_eq!(result.unwrap_err(), "APPROVAL_DENIED");
}

#[test]
fn td_040_u03_wait_returns_invalidated() {
    let registry = std::sync::Arc::new(std::sync::Mutex::new(
        super::security::ApprovalRegistry::default(),
    ));
    let approval = super::security::require_approval(
        &mut registry.lock().unwrap(),
        "session-a",
        "tab-1",
        "submit",
        1,
    )
    .unwrap();
    let id = approval.approval_id.clone();
    let other = registry.clone();
    let other_id = id.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(50));
        other.lock().unwrap().records.get_mut(&other_id).unwrap().status = "invalidated".into();
    });
    let result = tauri::async_runtime::block_on(super::security::wait_for_approval(
        &registry,
        &id,
        std::time::Duration::from_secs(1),
    ));
    assert_eq!(result.unwrap_err(), "APPROVAL_INVALIDATED");
}

#[test]
fn td_040_u04_wait_times_out_with_retryable_error() {
    let registry = std::sync::Mutex::new(super::security::ApprovalRegistry::default());
    let approval = super::security::require_approval(
        &mut registry.lock().unwrap(),
        "session-a",
        "tab-1",
        "submit",
        1,
    )
    .unwrap();
    let id = approval.approval_id.clone();
    let result = tauri::async_runtime::block_on(super::security::wait_for_approval(
        &registry,
        &id,
        std::time::Duration::from_millis(50),
    ));
    assert_eq!(result.unwrap_err(), format!("APPROVAL_REQUIRED:{id}"));
}

#[test]
fn td_040_u05_wait_rejects_missing_approval() {
    let registry = std::sync::Mutex::new(super::security::ApprovalRegistry::default());
    let result = tauri::async_runtime::block_on(super::security::wait_for_approval(
        &registry,
        "approval-missing",
        std::time::Duration::from_millis(10),
    ));
    assert_eq!(result.unwrap_err(), "APPROVAL_NOT_FOUND");
}
