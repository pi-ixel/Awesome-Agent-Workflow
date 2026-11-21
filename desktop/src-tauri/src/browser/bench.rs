//! 仅在临时 Windows 基准测试进程中运行，不启动实际工作区。
use super::evidence::call_cdp;
use super::host::{
    BrowserHost, NativeBounds, browser_close_session, browser_create_space, browser_set_visible,
    create_tab_for, find_webview, session_partition,
};
use super::model::PageSource;
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::PathBuf, time::Duration};
use tauri::{AppHandle, Manager, Webview};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use webview2_com::{
    CoTaskMemPWSTR,
    Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PROCESS_KIND, ICoreWebView2_2, ICoreWebView2_13,
        ICoreWebView2Environment8,
    },
};
use windows_core::{Interface, PWSTR};
use windows_sys::Win32::{
    Foundation::CloseHandle,
    System::{
        ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX},
        Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ},
    },
};

const PAGE: &str = "<!doctype html><title>AAW WebView2 bench</title><p>Same local test page for all sessions</p>";

pub(crate) fn output_path() -> Option<PathBuf> {
    std::env::var_os("AAW_WEBVIEW2_BENCH_OUT").map(PathBuf::from)
}

pub(super) fn browser_root() -> Option<Result<PathBuf, String>> {
    output_path().map(|_| {
        std::env::var_os("AAW_WEBVIEW2_BENCH_ROOT")
            .map(PathBuf::from)
            .filter(|root| root.is_absolute())
            .map(|root| root.join("embedded-browser"))
            .ok_or_else(|| "AAW_WEBVIEW2_BENCH_ROOT must be an absolute path".into())
    })
}

pub(crate) fn start(app: &AppHandle) -> bool {
    let Some(out) = output_path() else {
        return false;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = tokio::time::timeout(Duration::from_secs(90), run(&app)).await;
        let (payload, status) = match result {
            Ok(Ok(values)) => (values, 0),
            Ok(Err(error)) => (json!({"status":"error","error":error}), 1),
            Err(_) => (json!({"status":"error","error":"native benchmark timed out"}), 1),
        };
        let written = serde_json::to_vec_pretty(&payload)
            .map_err(std::io::Error::other)
            .and_then(|bytes| std::fs::write(out, bytes));
        app.exit(if written.is_ok() { status } else { 2 });
    });
    true
}

async fn run(app: &AppHandle) -> Result<Value, String> {
    let root = browser_root().ok_or("BENCH_ROOT_MISSING")??;
    if root.try_exists().map_err(|err| err.to_string())? {
        return Err("benchmark browser directory must not exist yet".into());
    }
    if std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_some() {
        return Err("WEBVIEW2_USER_DATA_FOLDER would invalidate this benchmark".into());
    }
    let sessions = match std::env::var("AAW_WEBVIEW2_BENCH_SESSIONS").as_deref() {
        Ok("1") => 1,
        Ok("3") => 3,
        _ => return Err("AAW_WEBVIEW2_BENCH_SESSIONS must be 1 or 3".into()),
    };
    let shared = std::env::var("AAW_WEBVIEW2_SHARED_PROFILES").as_deref() == Ok("1");
    let settle = std::env::var("AAW_WEBVIEW2_BENCH_SETTLE_MS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(5_000);
    if !(1_000..=20_000).contains(&settle) {
        return Err("benchmark settle delay must be from 1000 to 20000 ms".into());
    }

    let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|err| err.to_string())?;
    let url = format!("http://{}/", listener.local_addr().map_err(|err| err.to_string())?);
    let server = tauri::async_runtime::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            tauri::async_runtime::spawn(async move {
                let mut request = [0; 8192];
                if matches!(tokio::time::timeout(Duration::from_secs(3), socket.read(&mut request)).await, Ok(Ok(n)) if n > 0) {
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{PAGE}",
                        PAGE.len()
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                }
            });
        }
    });
    let result = measure(app, &url, sessions, shared, settle).await;
    server.abort();
    result
}

fn bounds() -> NativeBounds {
    NativeBounds { x: 8.0, y: 8.0, width: 650.0, height: 420.0 }
}

async fn open_tab(app: &AppHandle, session: &str, url: &str) -> Result<(String, Webview), String> {
    let host = app.state::<BrowserHost>();
    let tab = create_tab_for(app, &host, session, url, bounds(), PageSource::User).await?;
    let view = find_webview(app, &host, session, &tab.tab_id)?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(12);
    loop {
        let observed = evaluate(&view, "[location.href,document.title,document.readyState]").await;
        if observed.as_ref().is_ok_and(|state| *state == json!([url, "AAW WebView2 bench", "complete"])) {
            return Ok((tab.tab_id, view));
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!("test page did not finish loading in {session}: {observed:?}"));
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

async fn evaluate(view: &Webview, expression: &str) -> Result<Value, String> {
    let result = call_cdp(
        view,
        "Runtime.evaluate",
        json!({"expression":expression,"returnByValue":true}),
    )
    .await?;
    if result.get("exceptionDetails").is_some() {
        return Err(format!("benchmark page script failed: {result}"));
    }
    result.pointer("/result/value").cloned().ok_or_else(|| format!("benchmark page script returned no value: {result}"))
}

async fn check_markers(view: &Webview, expected: Option<usize>) -> Result<(), String> {
    let values = evaluate(
        view,
        "[localStorage.getItem('aawbench'), document.cookie.split('; ').find(c=>c.startsWith('aawbench='))?.slice(9) ?? null]",
    )
    .await?;
    let expected = expected.map(|v| v.to_string());
    if values != json!([expected, expected]) {
        return Err(format!("session data not isolated: {values}"));
    }
    Ok(())
}

struct Snapshot {
    browser_pid: u32,
    profile: String,
    version: String,
    process_kinds: Vec<(u32, i32)>,
}

async fn snapshot(view: &Webview) -> Result<Snapshot, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    view.with_webview(move |platform| {
        let result = (|| -> windows_core::Result<Snapshot> {
            unsafe {
                let core = platform.controller().CoreWebView2()?;
                let mut browser_pid = 0;
                core.BrowserProcessId(&mut browser_pid)?;
                let mut profile = PWSTR::null();
                core.cast::<ICoreWebView2_13>()?.Profile()?.ProfileName(&mut profile)?;
                let profile = CoTaskMemPWSTR::from(profile).to_string();
                let env = core.cast::<ICoreWebView2_2>()?.Environment()?;
                let mut version = PWSTR::null();
                env.BrowserVersionString(&mut version)?;
                let version = CoTaskMemPWSTR::from(version).to_string();
                let collection = env.cast::<ICoreWebView2Environment8>()?.GetProcessInfos()?;
                let mut count = 0;
                collection.Count(&mut count)?;
                let mut process_kinds = Vec::new();
                for index in 0..count {
                    let item = collection.GetValueAtIndex(index)?;
                    let mut pid = 0;
                    let mut kind = COREWEBVIEW2_PROCESS_KIND(0);
                    item.ProcessId(&mut pid)?;
                    item.Kind(&mut kind)?;
                    if pid > 0 {
                        process_kinds.push((pid as u32, kind.0));
                    }
                }
                Ok(Snapshot { browser_pid, profile, version, process_kinds })
            }
        })();
        let _ = send.send(result.map_err(|err| err.to_string()));
    })
    .map_err(|err| err.to_string())?;
    tokio::time::timeout(Duration::from_secs(8), receive)
        .await
        .map_err(|_| "WebView2 process snapshot timed out")?
        .map_err(|_| "WebView2 process snapshot callback dropped")?
}

fn private_bytes(pid: u32) -> Result<u64, String> {
    unsafe {
        let mut handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid);
        if handle.is_null() {
            handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        }
        if handle.is_null() {
            return Err(format!("could not open WebView2 PID {pid}: {}", std::io::Error::last_os_error()));
        }
        let mut counters = PROCESS_MEMORY_COUNTERS_EX::default();
        counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
        let success = K32GetProcessMemoryInfo(
            handle, (&mut counters as *mut PROCESS_MEMORY_COUNTERS_EX).cast(), counters.cb,
        );
        let error = std::io::Error::last_os_error();
        CloseHandle(handle);
        if success == 0 {
            return Err(format!("could not measure WebView2 PID {pid}: {error}"));
        }
        Ok(counters.PrivateUsage as u64)
    }
}

async fn measure(app: &AppHandle, url: &str, sessions: usize, shared: bool, settle: u64) -> Result<Value, String> {
    let mut tabs = Vec::new();
    for i in 0..sessions {
        let session = format!("bench-session-{i}");
        browser_create_space(app.clone(), "main".into(), "aaw-benchmark".into(), session.clone(), app.state())?;
        let (tab, view) = open_tab(app, &session, url).await?;
        browser_set_visible(app.clone(), app.state(), session.clone(), tab, true)?;
        check_markers(&view, None).await?;
        evaluate(&view, &format!(
            "(localStorage.setItem('aawbench','{i}'),document.cookie='aawbench={i}; Max-Age=3600; Path=/',true)"
        )).await?;
        tabs.push((session, view));
    }
    for (i, (_, view)) in tabs.iter().enumerate() {
        check_markers(view, Some(i)).await?;
    }
    tokio::time::sleep(Duration::from_millis(settle)).await;

    let main = app.get_webview("main").ok_or("main WebView not present")?;
    let main_pid = snapshot(&main).await?.browser_pid;
    let mut browser_pids = std::collections::BTreeSet::new();
    let mut processes = BTreeMap::new();
    let mut profiles = BTreeMap::new();
    let mut version = String::new();
    for (session, view) in &tabs {
        let snapshot = snapshot(view).await?;
        if snapshot.browser_pid == main_pid
            || !snapshot.process_kinds.iter().any(|(pid, _)| *pid == snapshot.browser_pid)
        {
            return Err(format!("unexpected browser process data in {session}"));
        }
        if (shared && !snapshot.profile.eq_ignore_ascii_case(&session_partition(session)))
            || (!shared && !snapshot.profile.eq_ignore_ascii_case("Default"))
        {
            return Err(format!("unexpected actual profile in {session}: {}", snapshot.profile));
        }
        version = snapshot.version;
        profiles.insert(session.clone(), snapshot.profile);
        browser_pids.insert(snapshot.browser_pid);
        for (pid, kind) in snapshot.process_kinds {
            processes.insert(pid, kind);
        }
    }
    if browser_pids.len() != (if shared { 1 } else { sessions }) || processes.contains_key(&main_pid) {
        return Err(format!("unexpected browser process groups: {browser_pids:?}"));
    }
    let process_rows = processes.iter().map(|(&pid, &kind)| {
        private_bytes(pid).map(|bytes| (pid, kind, bytes))
    }).collect::<Result<Vec<_>, _>>()?;
    let sum: u64 = process_rows.iter().map(|(_, _, bytes)| bytes).sum();

    // 测量之后走正式关闭、重开和清理路径，不把额外窗口计入基准。
    let (first_session, _) = &tabs[0];
    browser_close_session(app.clone(), app.state(), first_session.clone())?;
    let (_, reopened) = open_tab(app, first_session, url).await?;
    check_markers(&reopened, Some(0)).await?;
    browser_close_session(app.clone(), app.state(), first_session.clone())?;
    super::data::browser_clear_session_data(app.clone(), app.state(), first_session.clone()).await?;
    let (_, cleared) = open_tab(app, first_session, url).await?;
    check_markers(&cleared, None).await?;
    for (i, (_, view)) in tabs.iter().enumerate().skip(1) {
        check_markers(view, Some(i)).await?;
    }

    Ok(json!({
        "status":"ok","webview2Version":version,"sessions":sessions,"sharedProfiles":shared,
        "browserGroupCount":browser_pids.len(),"browserPids":browser_pids,"processCount":processes.len(),
        "privateBytes":sum,"processes":process_rows.into_iter().map(|(pid,kind,bytes)| json!({"pid":pid,"kind":kind,"privateBytes":bytes})).collect::<Vec<_>>(),
        "profiles":profiles,"isolationVerified":true,"targetedClearVerified":true
    }))
}
