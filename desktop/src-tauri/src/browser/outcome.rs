use super::confirmation::{
    ActionFacts, ActionKind, ExecutionFact, Expectation,
    decide_confirmation, evaluate_expectation,
};
use super::host::{BrowserHost, find_webview};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::time::{Duration, Instant};
use tauri::AppHandle;

#[derive(Clone)]
pub(crate) struct Capture {
    facts: ActionFacts,
    visible_text: Option<String>,
    html_length: Option<u64>,
    generation: u64,
    download_ids: BTreeSet<String>,
    dialog_ids: BTreeSet<String>,
}

pub(crate) fn action_kind(name: &str) -> Option<ActionKind> {
    Some(match name {
        "browser_fill" => ActionKind::Fill,
        "browser_click" => ActionKind::Click,
        "browser_press" => ActionKind::Press,
        "browser_scroll" => ActionKind::Scroll,
        "browser_navigate" => ActionKind::Navigate,
        "browser_back" | "browser_forward" => ActionKind::History,
        "browser_reload" => ActionKind::Reload,
        "browser_stop" => ActionKind::Stop,
        "browser_open" | "browser_select_tab" | "browser_close_tab" => ActionKind::Tab,
        "browser_submit" => ActionKind::Submit,
        "browser_upload" => ActionKind::Upload,
        "browser_execute_script" => ActionKind::Script,
        "browser_wait" => ActionKind::Wait,
        _ => return None,
    })
}

fn sanitize_url(raw: &str) -> Option<String> {
    let mut url = tauri::Url::parse(raw).ok()?;
    url.set_username("").ok()?;
    url.set_password(None).ok()?;
    let query = url
        .query_pairs()
        .filter(|(key, _)| {
            let key = key.to_ascii_lowercase();
            !["token", "secret", "pass", "password", "auth", "key", "credential"]
                .iter()
                .any(|sensitive| key.contains(sensitive))
        })
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("&");
    url.set_query((!query.is_empty()).then_some(query.as_str()));
    url.set_fragment(None);
    Some(url.to_string())
}

pub(crate) async fn capture(
    app: &AppHandle,
    host: &BrowserHost,
    session_id: &str,
    tab_id: &str,
    selector: Option<&str>,
    expectation: Option<&Expectation>,
) -> Result<Capture, String> {
    let tab = host
        .runtime
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .spaces
        .get(session_id)
        .and_then(|space| space.tabs.get(tab_id))
        .cloned()
        .ok_or("TAB_NOT_FOUND")?;
    let mut facts = ActionFacts {
        session_id: Some(session_id.into()),
        tab_id: Some(tab_id.into()),
        active_tab_id: Some(tab_id.into()),
        is_loading: Some(tab.navigation.is_loading),
        ..Default::default()
    };
    if let Some(url) = tab.committed_url.as_deref().and_then(sanitize_url) {
        facts.url = Some(url);
    }
    let webview = find_webview(app, host, session_id, tab_id)?;
    let selector_json = serde_json::to_string(&selector).map_err(|error| error.to_string())?;
    let count_selector = expectation
        .filter(|expectation| expectation.kind == super::confirmation::ExpectationKind::SelectorPresent)
        .map(|expectation| expectation.value.as_str())
        .or(selector);
    let count_json = serde_json::to_string(&count_selector).map_err(|error| error.to_string())?;
    let script = format!(
        r#"(()=>{{const target=new URL(location.href);target.username='';target.password='';const params=new URLSearchParams(target.search);for(const key of [...params.keys()]){{if(/token|secret|pass|auth|key|credential/i.test(key))params.delete(key)}}target.search=params.toString();target.hash='';const el={selector_json}?document.querySelector({selector_json}):null;const form=el?(el.tagName==='FORM'?el:el.closest('form')):null;const invalid=form?form.querySelector(':invalid'):null;const sensitive=el&&el.type==='password';return JSON.stringify({{url:target.toString(),title:document.title,text:(document.body?.innerText||'').slice(0,4000),htmlLength:document.documentElement.outerHTML.length,value:sensitive?null:(el?.value??null),readonly:el?.readOnly===true,disabled:el?.disabled===true,focused:el?el===document.activeElement:(document.activeElement!==document.body),connected:el?el.isConnected:false,validation:invalid?invalid.validationMessage:null,scrollX:window.scrollX,scrollY:window.scrollY,matchCount:{count_json}?document.querySelectorAll({count_json}).length:null}})}})()"#
    );
    let mut visible_text = None;
    let mut html_length = None;
    match super::mcp::evaluate(&webview, &script).await {
        Ok(raw) => {
            let text: String = serde_json::from_str(&raw).map_err(|_| "EVALUATION_FAILED")?;
            let value: Value = serde_json::from_str(&text).map_err(|_| "EVALUATION_FAILED")?;
            visible_text = value["text"].as_str().map(str::to_owned);
            html_length = value["htmlLength"].as_u64();
            facts.url = value["url"].as_str().map(str::to_owned).or(facts.url);
            facts.title = value["title"].as_str().map(str::to_owned);
            facts.visible_text = value["text"].as_str().map(str::to_owned);
            html_length = value["htmlLength"].as_u64();
            facts.value = value["value"].as_str().map(str::to_owned);
            facts.readonly = value["readonly"].as_bool().unwrap_or(false);
            facts.disabled = value["disabled"].as_bool().unwrap_or(false);
            facts.focused = value["focused"].as_bool().unwrap_or(false);
            facts.target_connected = value["connected"].as_bool();
            facts.validation = value["validation"].as_str().map(str::to_owned);
            facts.scroll_after = value["scrollY"].as_f64();
            facts.match_count = value["matchCount"].as_u64().map(|count| count as usize);
        }
        Err(_) => {
            facts.unobserved = true;
        }
    }
    let dialog_ids = host
        .dialogs
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .records
        .values()
        .filter(|record| record.session_id == session_id && record.tab_id == tab_id)
        .map(|record| record.dialog_id.clone())
        .collect::<BTreeSet<_>>();
    let dialogs = host.dialogs.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
    facts.dialog_opened = dialogs.records.values().any(|record| {
        record.session_id == session_id && record.tab_id == tab_id && record.status == "pending"
    });
    drop(dialogs);
    let download_ids = host
        .downloads
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .records
        .values()
        .filter(|record| record.session_id == session_id && record.tab_id == tab_id)
        .map(|record| record.download_id.clone())
        .collect::<BTreeSet<_>>();
    let downloads = host.downloads.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
    facts.download_started = downloads.records.values().any(|record| {
        record.session_id == session_id
            && record.tab_id == tab_id
            && matches!(record.status.as_str(), "pending" | "approved" | "completed")
    });
    drop(downloads);

    Ok(Capture {
        facts,
        visible_text,
        html_length,
        generation: tab.generation,
        download_ids,
        dialog_ids,
    })
}

fn compare(before: &Capture, after: &mut Capture, name: &str, arguments: &Value) {
    after.facts.download_started = after
        .download_ids
        .difference(&before.download_ids)
        .next()
        .is_some();
    after.facts.dialog_opened = after
        .dialog_ids
        .difference(&before.dialog_ids)
        .next()
        .is_some();
    after.facts.navigation_started = after.facts.is_loading == Some(true)
        || after.generation > before.generation;
    after.facts.navigation_committed = after.generation > before.generation
        || (after.facts.url != before.facts.url && after.facts.is_loading == Some(false));
    after.facts.change_observed = after.facts.url != before.facts.url
        || after.facts.title != before.facts.title
        || after.visible_text != before.visible_text
        || after.html_length != before.html_length;
    after.facts.visual_only = after.visible_text == before.visible_text
        && after.html_length != before.html_length;
    after.facts.target_removed = before.facts.target_connected == Some(true)
        && after.facts.target_connected == Some(false);
    after.facts.scroll_before = before.facts.scroll_after;
    after.facts.expected_value = arguments
        .get("value")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if name == "browser_stop" {
        after.facts.is_loading = Some(false);
    }
    if after.facts.dialog_opened || after.facts.download_started {
        after.facts.unobserved = false;
    }
    after.facts.condition_met = match name {
        "browser_press" => true,
        "browser_stop" => true,
        "browser_reload" => after.facts.is_loading == Some(false),
        "browser_open" | "browser_select_tab" | "browser_close_tab" => true,
        "browser_navigate" | "browser_back" | "browser_forward" | "browser_reload" => {
            after.facts.navigation_committed
        }
        "browser_execute_script" => true,
        _ => false,
    };
}

fn failed_outcome(code: &str) -> Value {
    json!({
        "isError": true,
        "content": [{"type": "text", "text": code}],
        "structuredContent": {"outcome": {
            "level": "failed",
            "suggestedAction": "retry",
            "reason": code,
            "timedOut": false,
            "unobserved": false,
        }},
        "error": {"code": code},
    })
}

pub(crate) async fn finalize_tool_result(
    app: &AppHandle,
    host: &BrowserHost,
    name: &str,
    arguments: &Value,
    expectation: Option<Expectation>,
    before: Capture,
    session_id: &str,
    result: Result<Value, String>,
) -> Result<Value, String> {
    eprintln!("OUTCOME_FINALIZE {name}");
    let Some(action) = action_kind(name) else {
        return result;
    };
    if name == "browser_open" {
        return result;
    }
    let selector = arguments.get("selector").and_then(Value::as_str);
    let tab_id = arguments
        .get("tabId")
        .and_then(Value::as_str)
        .ok_or("MISSING_ARGUMENT")?;
    let started = Instant::now();
    let mut after = if name == "browser_close_tab" {
        let mut closed = before.clone();
        closed.facts.condition_met = true;
        closed
    } else {
        capture(app, host, session_id, tab_id, selector, expectation.as_ref()).await?
    };
    if name != "browser_close_tab" {
        compare(&before, &mut after, name, arguments);
    }
    let mut evaluation = expectation
        .as_ref()
        .map(|expectation| evaluate_expectation(expectation, &after.facts));
    let navigation_family = matches!(
        name,
        "browser_navigate" | "browser_back" | "browser_forward" | "browser_reload"
    );
    let needs_wait = name != "browser_stop"
        && (expectation.is_some()
            || navigation_family
            || after.facts.navigation_started
            || matches!(name, "browser_click" | "browser_submit"));
    if needs_wait {
        let request_id = super::mcp::random_id(12)?;
        host.runtime
            .lock()
            .map_err(|_| "BROWSER_LOCK_FAILED")?
            .begin_request(&request_id, session_id, tab_id)?;
        let budget = Duration::from_millis(expectation.as_ref().map_or_else(
            || arguments.get("timeoutMs").and_then(Value::as_u64).unwrap_or(5000),
            |expectation| expectation.timeout_ms,
        ));
        let action_generation = after.generation;
        let mut committed_url: Option<String> = after.facts.url.clone();
        loop {
            if started.elapsed() >= budget {
                after.facts.timed_out = true;
                if let Some(evaluation) = evaluation.as_mut() {
                    evaluation.timed_out = true;
                }
                break;
            }
            let pending = host
                .runtime
                .lock()
                .map_err(|_| "BROWSER_LOCK_FAILED")?
                .requests
                .get(&request_id)
                .is_some_and(|request| request.status == super::model::RequestStatus::Pending);
            if !pending {
                return Ok(failed_outcome("CANCELLED"));
            }
            if after.facts.navigation_committed {
                committed_url = after.facts.url.clone();
            } else if after.facts.url != committed_url && !navigation_family {
                return Ok(failed_outcome("GENERATION_CHANGED"));
            }
            if after.generation != action_generation && !navigation_family {
                return Ok(failed_outcome("GENERATION_CHANGED"));
            }
            if let Some(expectation) = expectation.as_ref() {
                evaluation = Some(evaluate_expectation(expectation, &after.facts));
                if evaluation.as_ref().is_some_and(|evaluation| evaluation.matched) {
                    break;
                }
            } else if navigation_family {
                if after.facts.condition_met {
                    break;
                }
            } else if !after.facts.navigation_started
                && (after.facts.navigation_committed
                    || after.facts.target_removed
                    || after.facts.dialog_opened
                    || after.facts.download_started
                    || started.elapsed() >= Duration::from_millis(500))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
            after = capture(app, host, session_id, tab_id, selector, expectation.as_ref()).await?;
            compare(&before, &mut after, name, arguments);
        }
        host.runtime
            .lock()
            .map_err(|_| "BROWSER_LOCK_FAILED")?
            .complete_request(&request_id)?;
    }

    let mut execution = ExecutionFact::default();
    if let Ok(value) = &result {
        if let Some(error) = value.pointer("/structuredContent/error/code").and_then(Value::as_str) {
            execution.error = Some(error.into());
        }
        if value.pointer("/structuredContent/status").and_then(Value::as_str) == Some("cancelled") {
            execution.cancelled = true;
        }
        if action == ActionKind::Wait {
            after.facts.condition_met = value
                .pointer("/structuredContent/status")
                .and_then(Value::as_str)
                == Some("completed");
        }
    }
    let confirmation = decide_confirmation(action, &execution, &after.facts, evaluation.as_ref());
    let mut value = result?;
    let content = value
        .get_mut("structuredContent")
        .and_then(Value::as_object_mut)
        .ok_or("RESULT_SHAPE_INVALID")?;
    content.insert("outcome".into(), serde_json::to_value(confirmation).map_err(|error| error.to_string())?);
    content.insert("facts".into(), serde_json::to_value(after.facts).map_err(|error| error.to_string())?);
    if let Some(evaluation) = evaluation {
        content.insert("expectation".into(), serde_json::to_value(evaluation).map_err(|error| error.to_string())?);
    }
    eprintln!("OUTCOME_RESULT {}", value);
    Ok(value)
}

