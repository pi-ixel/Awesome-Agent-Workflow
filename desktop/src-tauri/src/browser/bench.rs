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
        COREWEBVIEW2_PROCESS_KIND, ICoreWebView2_2, ICoreWebView2_13, ICoreWebView2Environment8,
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

mod parallel;

const PAGE: &str =
    "<!doctype html><title>AAW WebView2 bench</title><p>Same local test page for all sessions</p>";

pub fn output_path() -> Option<PathBuf> {
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

pub(super) fn simulate_bad_profile(name: Option<&str>) -> bool {
    name.is_some()
        && output_path().is_some()
        && std::env::var("AAW_WEBVIEW2_BENCH_PHASE").as_deref() == Ok("reject")
}

pub(crate) fn start(app: &AppHandle) -> bool {
    let Some(out) = output_path() else {
        return false;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = tokio::time::timeout(Duration::from_secs(120), run(&app)).await;
        let (payload, status) = match result {
            Ok(Ok(values)) => (values, 0),
            Ok(Err(error)) => (json!({"status":"error","error":error}), 1),
            Err(_) => (
                json!({"status":"error","error":"native benchmark timed out"}),
                1,
            ),
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
    let phase = std::env::var("AAW_WEBVIEW2_BENCH_PHASE").unwrap_or_else(|_| "perf".into());
    let is_parallel = phase == "parallel";
    if (phase == "perf" || is_parallel) && root.try_exists().map_err(|err| err.to_string())? {
        return Err("benchmark browser directory must not exist yet".into());
    }
    if std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_some() {
        return Err("WEBVIEW2_USER_DATA_FOLDER would invalidate this benchmark".into());
    }
    let sessions = match (is_parallel, std::env::var("AAW_WEBVIEW2_BENCH_SESSIONS").as_deref()) {
        (true, Ok("2")) => 2,
        (true, Ok("4")) => 4,
        (false, Ok("1")) => 1,
        (false, Ok("3")) => 3,
        _ => return Err("并发基准使用 2 或 4 个会话，配置基准使用 1 或 3 个会话".into()),
    };
    let shared = std::env::var("AAW_WEBVIEW2_SHARED_PROFILES").as_deref() == Ok("1");
    let settle = std::env::var("AAW_WEBVIEW2_BENCH_SETTLE_MS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(5_000);
    if !(1_000..=20_000).contains(&settle) {
        return Err("benchmark settle delay must be from 1000 to 20000 ms".into());
    }

    let port: u16 = if phase == "perf" || is_parallel {
        0
    } else {
        std::env::var("AAW_WEBVIEW2_BENCH_PORT")
            .map_err(|_| "BENCH_PORT_MISSING")?
            .parse()
            .map_err(|_| "BENCH_PORT_INVALID")?
    };
    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|err| err.to_string())?;
    let url = format!(
        "http://{}/",
        listener.local_addr().map_err(|err| err.to_string())?
    );
    let requests = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let served_cache = requests.clone();
    let server = tauri::async_runtime::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let served_cache = served_cache.clone();
            tauri::async_runtime::spawn(async move {
                let mut request = [0; 8192];
                if matches!(tokio::time::timeout(Duration::from_secs(3), socket.read(&mut request)).await, Ok(Ok(n)) if n > 0)
                {
                    let fetch = request.starts_with(b"GET /cache ");
                    let body = if fetch {
                        served_cache
                            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                            .to_string()
                    } else if is_parallel {
                        parallel::PAGE.to_owned()
                    } else {
                        PAGE.to_owned()
                    };
                    let policy = if fetch { "max-age=3600" } else { "no-store" };
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: {policy}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                }
            });
        }
    });
    let result = if is_parallel {
        parallel::measure(app, &url, sessions).await
    } else if phase == "perf" {
        measure(app, &url, sessions, shared, settle).await
    } else {
        verify_profile_lifecycle(app, &url, &phase, &root).await
    };
    server.abort();
    result.map_err(|error| format!("{phase}: {error}"))
}

fn bounds() -> NativeBounds {
    NativeBounds {
        x: 8.0,
        y: 8.0,
        width: 650.0,
        height: 420.0,
    }
}

async fn open_tab(app: &AppHandle, session: &str, url: &str) -> Result<(String, Webview), String> {
    let host = app.state::<BrowserHost>();
    let tab = create_tab_for(app, &host, session, url, bounds(), PageSource::User).await?;
    let view = find_webview(app, &host, session, &tab.tab_id)?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(12);
    loop {
        let observed = evaluate(&view, "[location.href,document.title,document.readyState]").await;
        if observed
            .as_ref()
            .is_ok_and(|state| *state == json!([url, "AAW WebView2 bench", "complete"]))
        {
            return Ok((tab.tab_id, view));
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "test page did not finish loading in {session}: {observed:?}"
            ));
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

async fn evaluate(view: &Webview, expression: &str) -> Result<Value, String> {
    let result = call_cdp(
        view,
        "Runtime.evaluate",
        json!({"expression":expression,"returnByValue":true,"awaitPromise":true}),
    )
    .await?;
    if result.get("exceptionDetails").is_some() {
        return Err(format!("benchmark page script failed: {result}"));
    }
    result
        .pointer("/result/value")
        .cloned()
        .ok_or_else(|| format!("benchmark page script returned no value: {result}"))
}

fn marker_script(body: &str) -> String {
    format!(
        r#"(async () => {{
          const db = await new Promise((resolve, reject) => {{
            const open = indexedDB.open('aaw-benchmark', 1);
            open.onupgradeneeded = () => open.result.createObjectStore('markers');
            open.onsuccess = () => resolve(open.result);
            open.onerror = () => reject(open.error);
          }});
          try {{
            const dbValue = await new Promise((resolve, reject) => {{
              const read = db.transaction('markers').objectStore('markers').get('owner');
              read.onsuccess = () => resolve(read.result);
              read.onerror = () => reject(read.error);
            }});
            {body}
          }} finally {{ db.close(); }}
        }})()"#
    )
}

async fn set_markers(view: &Webview, value: usize) -> Result<(), String> {
    let script = marker_script(&format!(
        r#"localStorage.setItem('aawbench', '{value}');
        document.cookie = 'aawbench={value}; Max-Age=3600; Path=/';
        await new Promise((resolve, reject) => {{
          const write = db.transaction('markers', 'readwrite');
          write.objectStore('markers').put('{value}', 'owner');
          write.oncomplete = resolve;
          write.onerror = () => reject(write.error);
        }});
        return true;"#
    ));
    evaluate(view, &script).await?;
    Ok(())
}

async fn open_session(app: &AppHandle, session: &str, url: &str) -> Result<Webview, String> {
    browser_create_space(
        app.clone(),
        "main".into(),
        "aaw-benchmark".into(),
        session.into(),
        app.state(),
    )?;
    let (_, view) = open_tab(app, session, url).await?;
    Ok(view)
}

async fn close_session(app: &AppHandle, session: &str) -> Result<(), String> {
    browser_close_session(app.clone(), app.state(), session.into())?;
    tokio::time::sleep(Duration::from_millis(550)).await;
    Ok(())
}

async fn verify_profile_lifecycle(
    app: &AppHandle,
    url: &str,
    phase: &str,
    root: &std::path::Path,
) -> Result<Value, String> {
    const LEGACY: &str = "upgrade-existing-session";
    const A: &str = "shared-session-a";
    const B: &str = "shared-session-b";
    match phase {
        "legacy" => {
            let view = open_session(app, LEGACY, url).await?;
            set_markers(&view, 99).await?;
            close_session(app, LEGACY).await?;
            // 模拟不认识存储模式记录的旧版，保留真实的旧 UDF。
            let marker = root
                .join("webview2-profile-modes")
                .join(format!("{}.json", session_partition(LEGACY)));
            std::fs::remove_file(marker).map_err(|err| err.to_string())?;
        }
        "seed" => {
            let old = open_session(app, LEGACY, url).await?;
            check_markers(&old, Some(99)).await?;
            let original = super::profile::SessionProfile::for_session(app, LEGACY, false)?;
            if original.name.is_some() || original.directory != root.join(session_partition(LEGACY))
            {
                return Err("legacy user data folder changed after upgrading".into());
            }
            close_session(app, LEGACY).await?;

            let a = open_session(app, A, url).await?;
            set_markers(&a, 1).await?;
            let (_, other_tab) = open_tab(app, A, url).await?;
            check_markers(&other_tab, Some(1)).await?;

            let b = open_session(app, B, url).await?;
            check_markers(&b, None).await?;
            set_markers(&b, 2).await?;
            check_markers(&a, Some(1)).await?;
            close_session(app, A).await?;
            close_session(app, B).await?;
        }
        "reopen" => {
            let a = open_session(app, A, url).await?;
            let b = open_session(app, B, url).await?;
            check_markers(&a, Some(1))
                .await
                .map_err(|error| format!("restart A: {error}"))?;
            check_markers(&b, Some(2))
                .await
                .map_err(|error| format!("restart B: {error}"))?;
            let a_profile = snapshot(&a).await?;
            let b_profile = snapshot(&b).await?;
            if a_profile.profile != session_partition(A)
                || b_profile.profile != session_partition(B)
                || a_profile.browser_pid != b_profile.browser_pid
            {
                return Err("disabling the trial changed an existing profile".into());
            }

            let next = open_session(app, "new-after-disabled", url).await?;
            if snapshot(&next).await?.browser_pid == a_profile.browser_pid {
                return Err("new session used the shared profile with the trial disabled".into());
            }
            close_session(app, "new-after-disabled").await?;

            let fetch = "fetch('/cache').then(response => response.text())";
            let cached_a = evaluate(&a, fetch).await?;
            let cached_b = evaluate(&b, fetch).await?;
            if cached_a == cached_b
                || evaluate(&a, fetch).await? != cached_a
                || evaluate(&b, fetch).await? != cached_b
            {
                return Err("could not warm separate HTTP caches".into());
            }
            super::data::browser_clear_cache(app.clone(), app.state(), A.into()).await?;
            if evaluate(&a, fetch).await? == cached_a || evaluate(&b, fetch).await? != cached_b {
                return Err("cache cleanup did not only clear the selected profile".into());
            }
            check_markers(&a, Some(1)).await?;
            check_markers(&b, Some(2)).await?;

            super::data::browser_clear_site_data(app.clone(), app.state(), A.into(), url.into())
                .await?;
            let (_, after_site_clear) = open_tab(app, A, url).await?;
            let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
            loop {
                check_markers(&b, Some(2))
                    .await
                    .map_err(|error| format!("site clear B: {error}"))?;
                match check_markers(&after_site_clear, None).await {
                    Ok(()) => break,
                    Err(_) if tokio::time::Instant::now() < deadline => {
                        tokio::time::sleep(Duration::from_millis(350)).await;
                    }
                    Err(error) => return Err(format!("site clear A: {error}")),
                }
            }

            set_markers(&after_site_clear, 1).await?;
            close_session(app, A).await?;
            super::data::browser_clear_session_data(app.clone(), app.state(), A.into()).await?;
            let (_, cleared) = open_tab(app, A, url).await?;
            check_markers(&cleared, None).await?;
            check_markers(&b, Some(2)).await?;
            for row in super::data::browser_data_catalog(app.clone(), app.state())? {
                if matches!(row.partition.session_id.as_str(), A | B)
                    && row.occupancy.bytes.is_some()
                {
                    return Err(
                        "shared folder bytes were attributed to an individual session".into(),
                    );
                }
            }
        }
        "reject" => {
            let before = app.webviews().len();
            let err = open_session(app, "incorrect-controller-profile", url)
                .await
                .err()
                .ok_or("wrong WebView2 profile was accepted")?;
            if !err.contains("WEBVIEW2_PROFILE_MISMATCH") || app.webviews().len() != before {
                return Err(format!("failed to close the unverified view: {err}"));
            }
        }
        _ => return Err(format!("unknown validation phase: {phase}")),
    }
    Ok(json!({"status":"ok","phase":phase}))
}

async fn check_markers(view: &Webview, expected: Option<usize>) -> Result<(), String> {
    let values = evaluate(
        view,
        &marker_script("return [localStorage.getItem('aawbench'), document.cookie.split('; ').find(c=>c.startsWith('aawbench='))?.slice(9) ?? null, dbValue ?? null];"),
    )
    .await?;
    let expected = expected.map(|v| v.to_string());
    if values != json!([expected, expected, expected]) {
        return Err(format!(
            "expected session markers {expected:?}, observed {values}"
        ));
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
                core.cast::<ICoreWebView2_13>()?
                    .Profile()?
                    .ProfileName(&mut profile)?;
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
                Ok(Snapshot {
                    browser_pid,
                    profile,
                    version,
                    process_kinds,
                })
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
            return Err(format!(
                "could not open WebView2 PID {pid}: {}",
                std::io::Error::last_os_error()
            ));
        }
        let mut counters = PROCESS_MEMORY_COUNTERS_EX::default();
        counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
        let success = K32GetProcessMemoryInfo(
            handle,
            (&mut counters as *mut PROCESS_MEMORY_COUNTERS_EX).cast(),
            counters.cb,
        );
        let error = std::io::Error::last_os_error();
        CloseHandle(handle);
        if success == 0 {
            return Err(format!("could not measure WebView2 PID {pid}: {error}"));
        }
        Ok(counters.PrivateUsage as u64)
    }
}

async fn measure(
    app: &AppHandle,
    url: &str,
    sessions: usize,
    shared: bool,
    settle: u64,
) -> Result<Value, String> {
    let mut tabs = Vec::new();
    for i in 0..sessions {
        let session = format!("bench-session-{i}");
        browser_create_space(
            app.clone(),
            "main".into(),
            "aaw-benchmark".into(),
            session.clone(),
            app.state(),
        )?;
        let (tab, view) = open_tab(app, &session, url).await?;
        browser_set_visible(app.clone(), app.state(), session.clone(), tab, true)?;
        check_markers(&view, None).await?;
        set_markers(&view, i).await?;
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
            || !snapshot
                .process_kinds
                .iter()
                .any(|(pid, _)| *pid == snapshot.browser_pid)
        {
            return Err(format!("unexpected browser process data in {session}"));
        }
        // 独立数据目录的隐式默认 Profile 在部分运行时返回空名称。
        // 共享模式仍严格要求会话名；进程组与存储隔离另外验证。
        let profile_matches = if shared {
            snapshot
                .profile
                .eq_ignore_ascii_case(&session_partition(session))
        } else {
            snapshot.profile.is_empty() || snapshot.profile.eq_ignore_ascii_case("Default")
        };
        if !profile_matches {
            return Err(format!(
                "unexpected actual profile in {session}: {}",
                snapshot.profile
            ));
        }
        version = snapshot.version;
        profiles.insert(session.clone(), snapshot.profile);
        browser_pids.insert(snapshot.browser_pid);
        for (pid, kind) in snapshot.process_kinds {
            processes.insert(pid, kind);
        }
    }
    if browser_pids.len() != (if shared { 1 } else { sessions })
        || processes.contains_key(&main_pid)
    {
        return Err(format!(
            "unexpected browser process groups: {browser_pids:?}"
        ));
    }
    let process_rows = processes
        .iter()
        .map(|(&pid, &kind)| private_bytes(pid).map(|bytes| (pid, kind, bytes)))
        .collect::<Result<Vec<_>, _>>()?;
    let sum: u64 = process_rows.iter().map(|(_, _, bytes)| bytes).sum();

    // 测量之后走正式关闭、重开和清理路径，不把额外窗口计入基准。
    let (first_session, _) = &tabs[0];
    browser_close_session(app.clone(), app.state(), first_session.clone())?;
    let (_, reopened) = open_tab(app, first_session, url).await?;
    check_markers(&reopened, Some(0)).await?;
    browser_close_session(app.clone(), app.state(), first_session.clone())?;
    super::data::browser_clear_session_data(app.clone(), app.state(), first_session.clone())
        .await?;
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
