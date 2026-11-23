//! 使用真实浏览器 MCP、独立端点和实际 WebView 运行可重复的并行查询。
use super::{
    AppHandle, BrowserHost, Duration, Manager, Value, Webview, evaluate, find_webview, json,
    snapshot,
};
use crate::browser::{
    host::{browser_begin_work, browser_cancel_work, browser_create_space, browser_set_visible},
    mcp::{McpEndpoint, browser_mcp_bind, browser_mcp_create},
};
use serde::Serialize;
use std::sync::Arc;
use tokio::{sync::Barrier, task::JoinSet, time::Instant};
use windows_sys::Win32::{
    Foundation::CloseHandle,
    System::{
        ProcessStatus::{
            K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX, PROCESS_MEMORY_COUNTERS_EX2,
        },
        Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ},
    },
};

pub(super) const PAGE: &str = r#"<!doctype html><meta charset=utf-8>
<title>并行查询</title><h1>研究资料</h1><button id="proof">标记已读</button><main></main>
<script>
const page = location.pathname;
document.title = page;
const main = document.querySelector('main');
for (let n = 0; n < 8; n++) {
  const entry = document.createElement('article');
  entry.innerHTML = `<h2>资料 ${n + 1}</h2><p>${'可重复的研究资料。'.repeat(60)}</p>`;
  const canvas = document.createElement('canvas');
  canvas.width = 1024; canvas.height = 512; canvas.style.width = '560px';
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, '#eef3ff'); gradient.addColorStop(1, '#334b76');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, canvas.width, canvas.height);
  entry.append(canvas); main.append(entry);
}
let clicks = 0;
document.querySelector('#proof').onclick = () => { document.title = `${page}:${++clicks}`; };
</script>"#;

struct Client {
    http: reqwest::Client,
    endpoint: McpEndpoint,
}

impl Client {
    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let reply: Value = self
            .http
            .post(&self.endpoint.url)
            .bearer_auth(&self.endpoint.token)
            .json(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))
            .send()
            .await
            .map_err(|err| err.to_string())?
            .error_for_status()
            .map_err(|err| err.to_string())?
            .json()
            .await
            .map_err(|err| err.to_string())?;
        if let Some(error) = reply.get("error") {
            return Err(format!("{method}: {error}"));
        }
        Ok(reply["result"].clone())
    }

    async fn tool(&self, name: &str, arguments: Value) -> Result<Value, String> {
        let reply = self
            .request("tools/call", json!({"name":name,"arguments":arguments}))
            .await?;
        if reply["isError"] == true {
            return Err(format!("{name}: {}", reply["structuredContent"]));
        }
        Ok(reply["structuredContent"].clone())
    }

    async fn open(&self, url: &str) -> Result<String, String> {
        self.tool("browser_open", json!({"url":url})).await?["tabId"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| "未返回标签 ID".into())
    }

    async fn check_title(&self, tab: &str, expected: &str) -> Result<(), String> {
        let result = self.tool("browser_snapshot", json!({"tabId":tab})).await?;
        if result["title"] != expected {
            return Err(format!(
                "页面状态不符，预期 {expected}，实际 {}",
                result["title"]
            ));
        }
        Ok(())
    }

    async fn read_and_mark(&self, tab: &str, page: &str) -> Result<(), String> {
        self.tool(
            "browser_wait",
            json!({"tabId":tab,"selector":"#proof","timeoutMs":10000}),
        )
        .await?;
        self.check_title(tab, page).await?;
        self.tool("browser_click", json!({"tabId":tab,"selector":"#proof"}))
            .await?;
        self.check_title(tab, &format!("{page}:1")).await
    }
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Sample {
    working_set: u64,
    private_working_set: Option<u64>,
    private_commit: u64,
    process_count: usize,
    tab_count: usize,
}

fn process_memory(pid: u32) -> Option<(u64, Option<u64>, u64)> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut counters = PROCESS_MEMORY_COUNTERS_EX2::default();
        counters.cb = std::mem::size_of_val(&counters) as u32;
        let pointer = (&mut counters as *mut PROCESS_MEMORY_COUNTERS_EX2).cast();
        let has_private_working_set = K32GetProcessMemoryInfo(handle, pointer, counters.cb) != 0;
        let ok = has_private_working_set
            || K32GetProcessMemoryInfo(
                handle,
                pointer,
                std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
            ) != 0;
        CloseHandle(handle);
        ok.then_some((
            counters.WorkingSetSize as u64,
            has_private_working_set.then_some(counters.PrivateWorkingSetSize as u64),
            counters.PrivateUsage as u64,
        ))
    }
}

async fn sample(app: &AppHandle, anchor: &Webview) -> Result<Sample, String> {
    let processes = snapshot(anchor).await?.process_kinds;
    let tab_count = app
        .state::<BrowserHost>()
        .labels
        .lock()
        .map_err(|_| "BROWSER_LOCK_FAILED")?
        .len();
    let mut sample = Sample {
        tab_count,
        private_working_set: Some(0),
        ..Default::default()
    };
    for (pid, _) in processes {
        // 渲染进程可能在取到快照后退出。
        if let Some((working_set, private_working_set, commit)) = process_memory(pid) {
            sample.working_set += working_set;
            sample.private_working_set = sample
                .private_working_set
                .zip(private_working_set)
                .map(|(a, b)| a + b);
            sample.private_commit += commit;
            sample.process_count += 1;
        }
    }
    if sample.process_count == 0 {
        return Err("未采到内嵌浏览器进程".into());
    }
    Ok(sample)
}

pub(super) async fn measure(app: &AppHandle, url: &str, sessions: usize) -> Result<Value, String> {
    let reuse = std::env::var("AAW_WEBVIEW2_BENCH_REUSE").as_deref() == Ok("1");
    let http = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|err| err.to_string())?;
    let barrier = Arc::new(Barrier::new(sessions));
    let mut jobs = JoinSet::new();
    let host = app.state::<BrowserHost>();
    host.set_agent_control(true)?;
    for index in 0..sessions {
        let session = format!("parallel-{index}");
        browser_create_space(
            app.clone(),
            "main".into(),
            "aaw-benchmark".into(),
            session.clone(),
            app.state(),
        )?;
        let endpoint = browser_mcp_create(app.clone(), app.state()).await?;
        let endpoint = browser_mcp_bind(endpoint.endpoint_id, session.clone(), None, app.state())?;
        let client = Client {
            http: http.clone(),
            endpoint,
        };
        client
            .request("initialize", json!({"protocolVersion":"2025-03-26"}))
            .await?;
        client
            .request("notifications/initialized", json!({}))
            .await?;
        let app = app.clone();
        let url = url.to_owned();
        let barrier = barrier.clone();
        jobs.spawn(async move {
            let search = format!("/search-{index}");
            let article = format!("/article-{index}");
            barrier.wait().await;
            let start = Instant::now();
            browser_begin_work(app.clone(), app.state(), session.clone())?;
            let first = client
                .open(&format!("{}{search}", url.trim_end_matches('/')))
                .await?;
            let view = find_webview(&app, &app.state(), &session, &first)?;
            if index == 0 {
                browser_set_visible(
                    app.clone(),
                    app.state(),
                    session.clone(),
                    first.clone(),
                    true,
                )?;
            }
            client.read_and_mark(&first, &search).await?;
            evaluate(
                &view,
                &format!("(localStorage.setItem('bench-owner','{index}'), true)"),
            )
            .await?;
            barrier.wait().await;
            let article_url = format!("{}{article}", url.trim_end_matches('/'));
            let last = if reuse {
                let listed = client.tool("browser_list_tabs", json!({})).await?;
                if listed["tabs"][0]["tabId"] != first {
                    return Err("任务标签不可见".into());
                }
                client
                    .tool("browser_navigate", json!({"tabId":first,"url":article_url}))
                    .await?;
                first.clone()
            } else {
                client.open(&article_url).await?
            };
            // 等候导航提交，避免在旧页面上匹配相同的按钮。
            let view = find_webview(&app, &app.state(), &session, &last)?;
            let deadline = Instant::now() + Duration::from_secs(12);
            while evaluate(
                &view,
                "document.readyState === 'complete' ? location.pathname : ''",
            )
            .await?
                != article.as_str()
            {
                if Instant::now() >= deadline {
                    return Err("资料页导航超时".to_owned());
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            client.read_and_mark(&last, &article).await?;
            if evaluate(&view, "localStorage.getItem('bench-owner')").await? != index.to_string() {
                return Err("会话登录数据隔离失败".into());
            }
            let elapsed = start.elapsed().as_millis() as u64;
            // 所有会话都保持活动到最后一条查询执行完，覆盖共同的峰值窗口。
            barrier.wait().await;
            if index == 0 {
                browser_set_visible(app.clone(), app.state(), session.clone(), first, false)?;
            }
            browser_cancel_work(app.clone(), app.state(), session.clone()).await?;
            Ok::<_, String>((client, session, last, article, elapsed))
        });
    }
    let mut finished = Vec::new();
    let mut peak = Sample::default();
    let mut ticks = tokio::time::interval(Duration::from_millis(200));
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    while !jobs.is_empty() {
        tokio::select! {
            job = jobs.join_next() => {
                if let Some(job) = job { finished.push(job.map_err(|err| err.to_string())??); }
            }
            _ = ticks.tick() => {
                if let Ok(anchor) = find_webview(app, &host, "parallel-0", "tab-1") {
                    let current = sample(app, &anchor).await?;
                    if current.working_set > peak.working_set { peak = current; }
                }
            }
        }
    }
    let ended = Instant::now();
    let anchor = find_webview(app, &host, "parallel-0", "tab-1")?;
    let settled = sample(app, &anchor).await?;
    if settled.tab_count != sessions * if reuse { 1 } else { 2 } || peak.process_count == 0 {
        return Err("峰值采样或查询标签数量不完整".into());
    }
    tokio::time::sleep_until(ended + Duration::from_secs(30)).await;
    let idle_30 = sample(app, &anchor).await?;
    tokio::time::sleep_until(ended + Duration::from_secs(60)).await;
    let idle_60 = sample(app, &anchor).await?;
    for (client, session, tab, article, _) in &finished {
        let opening_tab = if reuse {
            // 模拟同一会话正在创建另一个标签，原生句柄还没有登记。
            let mut runtime = host.runtime.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
            Some(runtime.create_tab(session, "about:blank")?.tab_id)
        } else {
            None
        };
        browser_begin_work(app.clone(), app.state(), session.clone())?;
        client.check_title(tab, &format!("{article}:1")).await?;
        client
            .tool("browser_click", json!({"tabId":tab,"selector":"#proof"}))
            .await?;
        client.check_title(tab, &format!("{article}:2")).await?;
        browser_cancel_work(app.clone(), app.state(), session.clone()).await?;
        if let Some(opening_tab) = opening_tab {
            host.runtime
                .lock()
                .map_err(|_| "BROWSER_LOCK_FAILED")?
                .close_tab(session, &opening_tab)?;
        }
    }
    Ok(
        json!({"status":"ok","sessions":sessions,"reuse":reuse, "peak":peak,
        "settled":settled,"idle30":idle_30,"idle60":idle_60,
        "durationMs":finished.iter().map(|entry| entry.4).collect::<Vec<_>>(),"allSessionsResumed":true}),
    )
}

/// 经真实 MCP 冷启动，不允许面板或测试预先创建浏览器空间。
pub(super) async fn cold_start(app: &AppHandle, url: &str) -> Result<Value, String> {
    let http = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| error.to_string())?;
    let host = app.state::<BrowserHost>();
    host.set_agent_control(true)?;
    let mut clients = Vec::new();
    let mut tabs = Vec::new();
    let mut foreign_only_tab = None;
    for index in 0..2 {
        let session = format!("scheduled-cold-{index}");
        if host
            .runtime
            .lock()
            .map_err(|_| "BROWSER_LOCK_FAILED")?
            .spaces
            .contains_key(&session)
        {
            return Err("冷启动测试已被预热".into());
        }
        let endpoint = browser_mcp_create(app.clone(), app.state()).await?;
        let endpoint = browser_mcp_bind(
            endpoint.endpoint_id,
            session.clone(),
            Some("cold-workspace".into()),
            app.state(),
        )?;
        let client = Client {
            http: http.clone(),
            endpoint,
        };
        client
            .request("initialize", json!({"protocolVersion":"2025-03-26"}))
            .await?;
        client
            .request("notifications/initialized", json!({}))
            .await?;
        if browser_begin_work(app.clone(), app.state(), session.clone())?.is_some() {
            return Err("空会话不应提前创建浏览器空间".into());
        }
        // 一条会话直接首开；另一条先列空标签，覆盖两种工具首调顺序。
        if index == 1 && client.tool("browser_list_tabs", json!({})).await?["tabs"] != json!([]) {
            return Err("新会话标签应为空".into());
        }
        let path = format!("/cold-{index}");
        let tab = client
            .open(&format!("{}{path}", url.trim_end_matches('/')))
            .await?;
        client.read_and_mark(&tab, &path).await?;
        if host
            .runtime
            .lock()
            .map_err(|_| "BROWSER_LOCK_FAILED")?
            .spaces[&session]
            .workspace_id
            != "cold-workspace"
        {
            return Err("冷启动空间未归属任务项目".into());
        }
        let listed = client.tool("browser_list_tabs", json!({})).await?;
        if listed["tabs"].as_array().map(Vec::len) != Some(1) || listed["tabs"][0]["tabId"] != tab {
            return Err("会话标签不匹配".into());
        }
        tabs.push(tab);
        if index == 0 {
            foreign_only_tab = Some(client.open(&format!("{}foreign-only", url)).await?);
        }
        clients.push(client);
    }
    for index in 0..2 {
        // tab ID 在各会话内编号；同名 ID 应读到各自页面。
        clients[index].check_title(&tabs[index], &format!("/cold-{index}:1")).await?;
    }
    let foreign = foreign_only_tab.ok_or("测试缺少独有标签")?;
    if clients[1].tool("browser_snapshot", json!({"tabId":foreign})).await.is_ok() {
        return Err("跨会话标签访问未拒绝".into());
    }
    for index in 0..2 {
        let session = clients[index]
            .endpoint
            .session_id
            .clone()
            .ok_or("ENDPOINT_NOT_BOUND")?;
        browser_cancel_work(app.clone(), app.state(), session.clone()).await?;
        super::super::host::browser_close_session(app.clone(), app.state(), session)?;
        super::super::mcp::browser_mcp_revoke(
            clients[index].endpoint.endpoint_id.clone(),
            app.state(),
        )?;
    }
    Ok(
        json!({"status":"ok","coldOpen":true,"emptyList":true,"navigationAndClick":true,"sessionIsolation":true}),
    )
}
