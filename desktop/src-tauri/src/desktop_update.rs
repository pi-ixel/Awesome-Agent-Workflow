//! Native-owned update state. Signed bytes are the trust boundary; URLs never come from uploads.
use base64::{Engine, engine::general_purpose::STANDARD};
use ring::signature::{ED25519, UnparsedPublicKey};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const REPO: &str = "https://github.com/pi-ixel/Awesome-Agent-Workflow";
const MAX_PACKAGE: u64 = 512 * 1024 * 1024;
const MAX_METADATA: usize = 96 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Envelope {
    payload: String,
    signature: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Manifest {
    schema: u32,
    pub version: String,
    platform: String,
    kind: String,
    file_name: String,
    size: u64,
    sha256: String,
    #[serde(default)]
    pub notes: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Preferences {
    pub auto_check: bool,
    pub check_interval_minutes: u32,
    pub auto_download: bool,
    pub server: String,
    pub acceleration: bool,
    pub contribute: bool,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            auto_check: true,
            check_interval_minutes: 30,
            auto_download: true,
            server: option_env!("AAW_DESKTOP_UPDATE_SERVER")
                .filter(|s| !s.is_empty())
                .unwrap_or("http://39.108.107.148:18081")
                .into(),
            acceleration: true,
            contribute: true,
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    phase: String,
    current_version: String,
    ready: Option<Manifest>,
    available: Option<Manifest>,
    progress: u8,
    error: Option<String>,
    upload_error: Option<String>,
    source_messages: Vec<String>,
    installed: bool,
    preferences: Preferences,
}
pub struct Updates {
    snapshot: Mutex<Snapshot>,
    ready_envelope: Mutex<Option<Envelope>>,
    check: tokio::sync::Mutex<()>,
    upload: tokio::sync::Mutex<()>,
    frozen: Mutex<bool>,
    preferences_lock: tokio::sync::Mutex<()>,
    schedule_changed: tokio::sync::Notify,
}
impl Default for Updates {
    fn default() -> Self {
        Self {
            snapshot: Mutex::new(Snapshot {
                phase: "idle".into(),
                current_version: env!("CARGO_PKG_VERSION").into(),
                ready: None,
                available: None,
                progress: 0,
                error: None,
                upload_error: None,
                source_messages: Vec::new(),
                installed: installed_location().is_some(),
                preferences: Preferences::default(),
            }),
            ready_envelope: Mutex::new(None),
            check: tokio::sync::Mutex::new(()),
            upload: tokio::sync::Mutex::new(()),
            frozen: Mutex::new(false),
            preferences_lock: tokio::sync::Mutex::new(()),
            schedule_changed: tokio::sync::Notify::new(),
        }
    }
}
impl Updates {
    pub fn installing(&self) -> bool {
        *self.frozen.lock().unwrap()
    }
}
fn public_key() -> &'static str {
    option_env!("AAW_DESKTOP_UPDATE_PUBLIC_KEY")
        .filter(|key| !key.trim().is_empty())
        .unwrap_or(include_str!("../../update-public-key.txt"))
        .trim()
}
fn verify(envelope: &Envelope, key: &str) -> Result<Manifest, String> {
    if key.is_empty() {
        return Err("此构建未配置更新验证公钥，请安装正式发布版本".into());
    }
    let decoded = STANDARD.decode(key).map_err(|_| "更新公钥无效")?;
    if decoded.len() != 32 {
        return Err("更新公钥长度无效".into());
    }
    let key = UnparsedPublicKey::new(&ED25519, decoded);
    if envelope.payload.len() > 64000 {
        return Err("更新清单过大".into());
    }
    let bytes = STANDARD
        .decode(&envelope.payload)
        .map_err(|e| e.to_string())?;
    let signature = STANDARD
        .decode(&envelope.signature)
        .map_err(|e| e.to_string())?;
    key.verify(&bytes, &signature)
        .map_err(|_| "更新签名验证失败")?;
    let data: Manifest = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let version = Version::parse(&data.version).map_err(|e| e.to_string())?;
    if version.to_string() != data.version
        || !version.pre.is_empty()
        || !version.build.is_empty()
        || data.schema != 1
        || data.platform != "windows-x86_64"
        || data.kind != "nsis"
        || data.file_name != format!("AAW-Desktop-{}-windows-x64-setup.exe", data.version)
        || data.size == 0
        || data.size > MAX_PACKAGE
        || data.sha256.len() != 64
        || !data
            .sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("更新清单字段无效".into());
    }
    Ok(data)
}
fn folder(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("updates");
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("AAW-Desktop/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(600))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| e.to_string())
}
fn change(app: &AppHandle, update: impl FnOnce(&mut Snapshot)) {
    let state = app.state::<Updates>();
    let mut snapshot = state.snapshot.lock().unwrap();
    update(&mut snapshot);
    let _ = app.emit("desktop-update", snapshot.clone());
}
#[derive(Debug)]
enum MetadataError {
    Network,
    Http(u16),
    Invalid(String),
}
impl std::fmt::Display for MetadataError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Network => write!(f, "网络连接失败或超时，请检查网络后重试"),
            Self::Http(404) => write!(f, "更新资源不存在（HTTP 404）"),
            Self::Http(403 | 429) => write!(f, "请求被拒绝或触发限流，请稍后重试"),
            Self::Http(status) => write!(f, "更新服务响应异常（HTTP {status}）"),
            Self::Invalid(reason) => write!(f, "更新响应无效：{reason}"),
        }
    }
}
fn server_metadata_error(error: MetadataError) -> String {
    match error {
        MetadataError::Http(404) => "更新接口未部署或服务器地址不正确（HTTP 404）".into(),
        other => other.to_string(),
    }
}
async fn metadata(
    http: &reqwest::Client,
    url: &str,
    limit: usize,
) -> Result<Vec<u8>, MetadataError> {
    let response = http
        .get(url)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|_| MetadataError::Network)?;
    if !response.status().is_success() {
        return Err(MetadataError::Http(response.status().as_u16()));
    }
    response_bytes(response, limit)
        .await
        .map_err(MetadataError::Invalid)
}
async fn response_bytes(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > limit {
            return Err("更新响应过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
async fn github(http: &reqwest::Client) -> Result<Option<Envelope>, String> {
    // Desktop releases deliberately are not GitHub's global `latest` (CLI shares this repo).
    let bytes = metadata(
        http,
        "https://api.github.com/repos/pi-ixel/Awesome-Agent-Workflow/releases?per_page=100",
        4 * 1024 * 1024,
    )
    .await
    .map_err(|e| e.to_string())?;
    let releases: Vec<serde_json::Value> =
        serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let mut candidates = Vec::new();
    for release in releases {
        if release["draft"].as_bool() != Some(false)
            || release["prerelease"].as_bool() != Some(false)
        {
            continue;
        }
        let Some(tag) = release["tag_name"].as_str() else {
            continue;
        };
        let Some(version) = tag
            .strip_prefix("desktop-v")
            .and_then(|s| Version::parse(s).ok())
        else {
            continue;
        };
        if !version.pre.is_empty() || !version.build.is_empty() {
            continue;
        }
        if release["assets"]
            .as_array()
            .is_some_and(|a| a.iter().any(|a| a["name"] == "desktop-update.json"))
        {
            candidates.push(version);
        }
    }
    let Some(version) = candidates.into_iter().max() else {
        return Ok(None);
    };
    let bytes = metadata(
        http,
        &format!("{REPO}/releases/download/desktop-v{version}/desktop-update.json"),
        MAX_METADATA,
    )
    .await
    .map_err(|e| e.to_string())?;
    let envelope: Envelope =
        serde_json::from_slice(&bytes).map_err(|_| "签名清单格式无效".to_string())?;
    if verify(&envelope, public_key())?.version != version.to_string() {
        return Err("发布标签与签名版本不一致".into());
    }
    Ok(Some(envelope))
}
async fn cached_server(
    http: &reqwest::Client,
    settings: &Preferences,
) -> Result<Option<Envelope>, String> {
    if !settings.acceleration || settings.server.is_empty() {
        return Ok(None);
    }
    let bytes = metadata(
        http,
        &format!("{}/api/v1/desktop/latest", settings.server),
        MAX_METADATA,
    )
    .await
    .map_err(server_metadata_error)?;
    serde_json::from_slice(&bytes).map_err(|_| "签名清单格式无效".into())
}
async fn verify_file(path: &Path, data: &Manifest) -> Result<(), String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| e.to_string())?;
    if file.metadata().await.map_err(|e| e.to_string())?.len() != data.size {
        return Err("安装包大小不匹配".into());
    }
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
    }
    if format!("{:x}", digest.finalize()) != data.sha256 {
        return Err("安装包哈希验证失败".into());
    }
    Ok(())
}
async fn download_file(
    http: &reqwest::Client,
    url: &str,
    data: &Manifest,
    path: &Path,
    report: impl Fn(u8),
) -> Result<(), String> {
    let mut response = http
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let mut file = tokio::fs::File::create(path)
        .await
        .map_err(|e| e.to_string())?;
    let mut count = 0;
    let mut progress = 0;
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        count += chunk.len() as u64;
        if count > data.size {
            return Err("安装包超过签名大小".into());
        }
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        let next = (count * 100 / data.size) as u8;
        if next > progress {
            progress = next;
            report(next);
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    verify_file(path, data).await
}
async fn download(
    app: &AppHandle,
    http: &reqwest::Client,
    url: &str,
    data: &Manifest,
    path: &Path,
) -> Result<(), String> {
    download_file(http, url, data, path, |progress| {
        change(app, |s| s.progress = progress)
    })
    .await
}
async fn contribute(app: AppHandle, envelope: Envelope, path: PathBuf) {
    let service = app.state::<Updates>();
    let Ok(_lock) = service.upload.try_lock() else {
        return;
    };
    let settings = service.snapshot.lock().unwrap().preferences.clone();
    if !settings.acceleration || !settings.contribute || settings.server.is_empty() {
        return;
    }
    let result: Result<(), String> = async {
        let data = verify(&envelope, public_key())?;
        verify_file(&path, &data).await?;
        let http = client()?;
        let response = http
            .post(format!("{}/api/v1/desktop/uploads", settings.server))
            .json(&envelope)
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        let claim: serde_json::Value =
            serde_json::from_slice(&response_bytes(response, MAX_METADATA).await?)
                .map_err(|e| e.to_string())?;
        match claim["status"].as_str() {
            Some("ready" | "busy") => return Ok(()),
            Some("upload") => {}
            _ => return Err("上传资格响应无效".into()),
        }
        let token = claim["token"].as_str().ok_or("上传资格响应无效")?;
        let file = tokio::fs::File::open(&path)
            .await
            .map_err(|e| e.to_string())?;
        http.put(format!(
            "{}/api/v1/desktop/uploads/{}",
            settings.server, data.sha256
        ))
        .bearer_auth(token)
        .header(reqwest::header::CONTENT_LENGTH, data.size)
        .body(reqwest::Body::wrap_stream(
            tokio_util::io::ReaderStream::new(file),
        ))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
        Ok(())
    }
    .await;
    change(&app, |s| s.upload_error = result.err());
}
async fn check(app: &AppHandle, download_requested: bool) -> Result<(), String> {
    let service = app.state::<Updates>();
    let Ok(_lock) = service.check.try_lock() else {
        return Ok(());
    };
    if *service.frozen.lock().unwrap() {
        return Ok(());
    }
    if public_key().is_empty() {
        return Err("此构建未配置更新验证公钥，请安装正式发布版本".into());
    }
    if !cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        return Err("首期更新仅支持 Windows x64".into());
    }
    change(app, |s| {
        s.phase = "checking".into();
        s.error = None;
        s.source_messages.clear();
    });
    let settings = service.snapshot.lock().unwrap().preferences.clone();
    let http = client()?;
    let (gh, server) = tokio::join!(github(&http), cached_server(&http, &settings));
    let mut candidates = Vec::new();
    let mut messages = Vec::new();
    let mut failures = Vec::new();
    for (source, envelope) in [(false, gh), (true, server)] {
        let name = if source { "加速服务器" } else { "GitHub" };
        match envelope {
            Ok(Some(envelope)) => match verify(&envelope, public_key()) {
                Ok(data) => {
                    messages.push(format!("{name}：已验证版本 {}", data.version));
                    candidates.push((data, envelope, source));
                }
                Err(error) => {
                    let message = format!("{name}：{error}，已拒绝此更新");
                    messages.push(message.clone());
                    failures.push(message);
                }
            },
            Ok(None) => messages.push(format!(
                "{name}：{}",
                if !source {
                    "尚未发布带签名的 Desktop 版本"
                } else if !settings.acceleration || settings.server.is_empty() {
                    "未启用"
                } else {
                    "尚无已缓存的安装包"
                }
            )),
            Err(error) => {
                let message = format!("{name}：{error}");
                messages.push(message.clone());
                failures.push(message);
            }
        }
    }
    change(app, |s| s.source_messages = messages);
    let Some((data, envelope, _source)) = candidates
        .iter()
        .max_by_key(|(m, _, _)| Version::parse(&m.version).unwrap())
        .cloned()
    else {
        if !failures.is_empty() {
            return Err(failures.join("；"));
        }
        change(app, |s| {
            s.phase = if s.ready.is_some() {
                "ready"
            } else {
                "no-release"
            }
            .into()
        });
        return Ok(());
    };
    let ready = service.snapshot.lock().unwrap().ready.clone();
    if Version::parse(&data.version).unwrap() <= Version::parse(env!("CARGO_PKG_VERSION")).unwrap()
        || ready.as_ref().is_some_and(|m| {
            Version::parse(&m.version).unwrap() >= Version::parse(&data.version).unwrap()
        })
    {
        change(app, |s| {
            s.available = None;
            s.phase = if s.ready.is_some() {
                "ready"
            } else {
                "up-to-date"
            }
            .into()
        });
        return Ok(());
    }
    if !service.snapshot.lock().unwrap().installed {
        change(app, |s| {
            s.available = None;
            s.ready = Some(data);
            s.phase = "manual".into();
        });
        return Ok(());
    }
    // Read the live preference after metadata I/O, so disabling auto-download takes effect.
    let auto_download = service.snapshot.lock().unwrap().preferences.auto_download;
    change(app, |s| s.available = Some(data.clone()));
    if !should_download(auto_download, download_requested) {
        change(app, |s| {
            s.phase = if s.ready.is_some() {
                "ready"
            } else {
                "available"
            }
            .into()
        });
        return Ok(());
    }
    let dir = folder(app)?;
    let path = dir.join(format!("{}.exe", data.sha256));
    let temporary = dir.join("download.part");
    change(app, |s| {
        s.phase = "downloading".into();
        s.progress = 0;
    });
    if verify_file(&path, &data).await.is_err() {
        let server_has = candidates
            .iter()
            .any(|(m, _, server)| *server && m.sha256 == data.sha256);
        let from_server = if server_has {
            download(
                app,
                &http,
                &format!(
                    "{}/api/v1/desktop/packages/{}",
                    settings.server, data.sha256
                ),
                &data,
                &temporary,
            )
            .await
        } else {
            Err("服务器缺少安装包".into())
        };
        if from_server.is_err() {
            if let Err(error) = download(
                app,
                &http,
                &format!(
                    "{REPO}/releases/download/desktop-v{}/{}",
                    data.version, data.file_name
                ),
                &data,
                &temporary,
            )
            .await
            {
                let _ = tokio::fs::remove_file(&temporary).await;
                return Err(error);
            }
        }
        tokio::fs::rename(&temporary, &path)
            .await
            .map_err(|e| e.to_string())?;
    }
    // Only swap the ready target after the replacement is fully verified.
    let encoded = serde_json::to_vec(&envelope).map_err(|e| e.to_string())?;
    tokio::fs::write(dir.join("ready.json.tmp"), encoded)
        .await
        .map_err(|e| e.to_string())?;
    tokio::fs::rename(dir.join("ready.json.tmp"), dir.join("ready.json"))
        .await
        .map_err(|e| e.to_string())?;
    *service.ready_envelope.lock().unwrap() = Some(envelope.clone());
    change(app, |s| {
        s.ready = Some(data.clone());
        s.available = None;
        s.phase = "ready".into();
        s.progress = 100;
    });
    if let Some(old) = ready.filter(|old| old.sha256 != data.sha256) {
        let _ = tokio::fs::remove_file(dir.join(format!("{}.exe", old.sha256))).await;
    }
    Ok(())
}
fn should_download(auto_download: bool, download_requested: bool) -> bool {
    auto_download || download_requested
}
async fn run_check(app: &AppHandle, download_requested: bool) {
    if let Err(error) = check(app, download_requested).await {
        change(app, |s| {
            s.error = Some(error);
            s.phase = if s.ready.is_some() { "ready" } else { "error" }.into();
        });
    }
    // A previous upload failure is retried even when both metadata sources are offline.
    let envelope = app
        .state::<Updates>()
        .ready_envelope
        .lock()
        .unwrap()
        .clone();
    if let Some(envelope) = envelope {
        if let (Ok(data), Ok(dir)) = (verify(&envelope, public_key()), folder(app)) {
            tauri::async_runtime::spawn(contribute(
                app.clone(),
                envelope,
                dir.join(format!("{}.exe", data.sha256)),
            ));
        }
    }
}
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let service = app.state::<Updates>();
        let initialization = service.check.lock().await;
        if let Ok(dir) = folder(&app) {
            if let Ok(bytes) = tokio::fs::read(dir.join("preferences.json")).await {
                if let Ok(settings) = serde_json::from_slice::<Preferences>(&bytes) {
                    if validate_preferences(&settings).is_ok() {
                        change(&app, |s| s.preferences = settings);
                    }
                }
            }
            if let Ok(bytes) = tokio::fs::read(dir.join("ready.json")).await {
                if let Ok(envelope) = serde_json::from_slice::<Envelope>(&bytes) {
                    if let Ok(data) = verify(&envelope, public_key()) {
                        if Version::parse(&data.version).unwrap()
                            > Version::parse(env!("CARGO_PKG_VERSION")).unwrap()
                            && verify_file(&dir.join(format!("{}.exe", data.sha256)), &data)
                                .await
                                .is_ok()
                        {
                            *app.state::<Updates>().ready_envelope.lock().unwrap() = Some(envelope);
                            change(&app, |s| {
                                s.ready = Some(data);
                                s.phase = "ready".into();
                            });
                        }
                    }
                }
            }
            let keep = service
                .snapshot
                .lock()
                .unwrap()
                .ready
                .as_ref()
                .map(|m| format!("{}.exe", m.sha256));
            if let Ok(mut entries) = tokio::fs::read_dir(&dir).await {
                while let Ok(Some(entry)) = entries.next_entry().await {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    let package = name.strip_suffix(".exe").is_some_and(|stem| {
                        stem.len() == 64 && stem.bytes().all(|b| b.is_ascii_hexdigit())
                    });
                    if (package && keep.as_deref() != Some(&name))
                        || matches!(name.as_str(), "download.part" | "ready.json.tmp")
                    {
                        let _ = tokio::fs::remove_file(entry.path()).await;
                    }
                }
            }
        }
        drop(initialization);
        // Startup check is independent of UI/preload. Network waits never block the window.
        let enabled = service.snapshot.lock().unwrap().preferences.auto_check;
        if enabled {
            run_check(&app, false).await;
        }
        loop {
            let settings = service.snapshot.lock().unwrap().preferences.clone();
            tokio::select! {
                _ = service.schedule_changed.notified() => continue,
                _ = tokio::time::sleep(Duration::from_secs(u64::from(settings.check_interval_minutes) * 60)), if settings.auto_check => {
                    // A setting may change as the timer fires.
                    let enabled = service.snapshot.lock().unwrap().preferences.auto_check;
                    if enabled { run_check(&app, false).await; }
                }
            }
        }
    });
}
fn valid_server(value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Ok(());
    }
    let url = reqwest::Url::parse(value).map_err(|_| "服务器地址必须是完整 URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("服务器地址无效".into());
    }
    Ok(())
}
#[tauri::command]
pub fn update_status(state: State<'_, Updates>) -> Snapshot {
    state.snapshot.lock().unwrap().clone()
}
#[tauri::command]
pub async fn update_check(app: AppHandle) {
    run_check(&app, false).await;
}
#[tauri::command]
pub async fn update_download(app: AppHandle) {
    run_check(&app, true).await;
}
fn validate_preferences(preferences: &Preferences) -> Result<(), String> {
    valid_server(&preferences.server)?;
    if !(1..=1440).contains(&preferences.check_interval_minutes) {
        return Err("检查间隔必须为 1–1440 分钟".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn update_preferences(
    app: AppHandle,
    mut preferences: Preferences,
) -> Result<(), String> {
    preferences.server = preferences.server.trim().trim_end_matches('/').into();
    validate_preferences(&preferences)?;
    let service = app.state::<Updates>();
    let _lock = service.preferences_lock.lock().await;
    let dir = folder(&app)?;
    tokio::fs::write(
        dir.join("preferences.json.tmp"),
        serde_json::to_vec(&preferences).unwrap(),
    )
    .await
    .map_err(|e| e.to_string())?;
    tokio::fs::rename(
        dir.join("preferences.json.tmp"),
        dir.join("preferences.json"),
    )
    .await
    .map_err(|e| e.to_string())?;
    change(&app, |s| s.preferences = preferences);
    service.schedule_changed.notify_one();
    Ok(())
}
#[tauri::command]
pub async fn update_prepare(app: AppHandle, version: String) -> Result<(), String> {
    let service = app.state::<Updates>();
    let _lock = service.check.lock().await;
    if installed_location().is_none() {
        return Err("便携版请手动下载并替换".into());
    }
    let env = service
        .ready_envelope
        .lock()
        .unwrap()
        .clone()
        .ok_or("没有可安装的更新")?;
    let data = verify(&env, public_key())?;
    if data.version != version {
        return Err("更新版本已变化，请重新确认".into());
    }
    verify_file(&folder(&app)?.join(format!("{}.exe", data.sha256)), &data).await?;
    *service.frozen.lock().unwrap() = true;
    change(&app, |s| s.phase = "installing".into());
    Ok(())
}
#[tauri::command]
pub fn update_cancel(app: AppHandle) {
    *app.state::<Updates>().frozen.lock().unwrap() = false;
    change(&app, |s| s.phase = "ready".into());
}
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    let service = app.state::<Updates>();
    if !*service.frozen.lock().unwrap() {
        return Err("请先确认更新版本".into());
    }
    let env = service
        .ready_envelope
        .lock()
        .unwrap()
        .clone()
        .ok_or("没有可安装的更新")?;
    let data = verify(&env, public_key())?;
    let path = folder(&app)?.join(format!("{}.exe", data.sha256));
    verify_file(&path, &data).await?;
    let location = installed_location().ok_or("无法确认安装位置，请手动更新")?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Tauri NSIS: passive progress, restart, preserve shortcuts and exact installation path.
        // NSIS requires /D last and unquoted, including paths containing spaces.
        std::process::Command::new(&path)
            .args(["/P", "/R", "/UPDATE"])
            .raw_arg(nsis_destination(&location)?)
            .spawn()
            .map_err(|e| format!("启动安装器失败：{e}"))?;
        app.exit(0);
    }
    #[cfg(not(windows))]
    {
        let _ = location;
        return Err("仅支持 Windows 安装版".into());
    }
    #[allow(unreachable_code)]
    Ok(())
}
#[tauri::command]
pub fn update_open_folder(app: AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("explorer.exe")
            .arg(folder(&app)?)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn installed_location() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        use winreg::{RegKey, enums::*};
        let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
        let parent = exe.parent()?;
        for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
            for flags in [KEY_READ | KEY_WOW64_64KEY, KEY_READ | KEY_WOW64_32KEY] {
                let Ok(key) = RegKey::predef(hive).open_subkey_with_flags(
                    "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AAW Desktop",
                    flags,
                ) else {
                    continue;
                };
                let Ok(location) = key.get_value::<String, _>("InstallLocation") else {
                    continue;
                };
                let location = PathBuf::from(location.trim_matches('"'));
                let Ok(canonical) = location.canonicalize() else {
                    continue;
                };
                if canonical == parent && location.is_absolute() {
                    return Some(location);
                }
            }
        }
    }
    None
}

fn nsis_destination(location: &Path) -> Result<String, String> {
    let value = location.to_str().ok_or("安装路径编码无效")?;
    if !location.is_absolute() || value.contains(['"', '\r', '\n']) {
        return Err("安装路径无效".into());
    }
    let value = value.strip_prefix(r"\\?\").unwrap_or(value);
    let value = value
        .strip_prefix("UNC\\")
        .map(|p| format!(r"\\{p}"))
        .unwrap_or_else(|| value.into());
    Ok(format!("/D={value}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{Ed25519KeyPair, KeyPair};
    #[test]
    fn source_errors_distinguish_missing_api_network_and_invalid_signature() {
        assert!(server_metadata_error(MetadataError::Http(404)).contains("接口未部署"));
        assert!(MetadataError::Network.to_string().contains("网络连接失败"));
        assert!(MetadataError::Http(429).to_string().contains("限流"));
        assert!(MetadataError::Http(503).to_string().contains("HTTP 503"));
    }
    #[tokio::test]
    async fn empty_server_cache_and_disabled_acceleration_are_not_errors() {
        let http = client().unwrap();
        let settings = Preferences {
            server: serve(b"null").await,
            ..Preferences::default()
        };
        assert!(cached_server(&http, &settings).await.unwrap().is_none());
        let settings = Preferences {
            server: "http://127.0.0.1:1".into(),
            acceleration: false,
            ..Preferences::default()
        };
        assert!(cached_server(&http, &settings).await.unwrap().is_none());
    }
    #[test]
    fn local_build_includes_the_release_verification_key() {
        assert_eq!(STANDARD.decode(public_key()).unwrap().len(), 32);
    }
    #[test]
    fn preferences_migrate_and_roundtrip_with_validated_interval() {
        let mut settings: Preferences = serde_json::from_str(
            r#"{"server":"http://localhost:8000","acceleration":false,"contribute":false}"#,
        )
        .unwrap();
        assert!(settings.auto_check && settings.auto_download);
        assert_eq!(settings.check_interval_minutes, 30);
        assert!(!settings.acceleration);
        settings.auto_check = false;
        settings.auto_download = false;
        settings.check_interval_minutes = 60;
        let restored: Preferences =
            serde_json::from_slice(&serde_json::to_vec(&settings).unwrap()).unwrap();
        assert!(!restored.auto_check && !restored.auto_download);
        assert_eq!(restored.check_interval_minutes, 60);
        assert!(validate_preferences(&restored).is_ok());
        for invalid in [0, 1441, u32::MAX] {
            settings.check_interval_minutes = invalid;
            assert!(validate_preferences(&settings).is_err());
        }
    }
    #[test]
    fn manual_download_overrides_preference_but_check_does_not() {
        assert!(!should_download(false, false));
        assert!(should_download(false, true));
        assert!(should_download(true, false));
    }
    #[cfg(windows)]
    #[test]
    fn nsis_keeps_spaces_without_quotes_or_extended_prefix() {
        assert_eq!(
            nsis_destination(Path::new(r"\\?\C:\Program Files\AAW Desktop")).unwrap(),
            r"/D=C:\Program Files\AAW Desktop"
        );
        assert!(nsis_destination(Path::new("relative")).is_err());
        assert!(nsis_destination(Path::new("C:\\bad\"path")).is_err());
    }
    fn signed() -> (Envelope, String) {
        let key = Ed25519KeyPair::from_seed_unchecked(&[7; 32]).unwrap();
        let payload = serde_json::json!({"schema":1,"version":"0.2.0","platform":"windows-x86_64",
            "kind":"nsis","file_name":"AAW-Desktop-0.2.0-windows-x64-setup.exe","size":3,
            "sha256":format!("{:x}",Sha256::digest(b"abc")),"notes":"hello"});
        let bytes = serde_json::to_vec(&payload).unwrap();
        (
            Envelope {
                payload: STANDARD.encode(&bytes),
                signature: STANDARD.encode(key.sign(&bytes).as_ref()),
            },
            STANDARD.encode(key.public_key().as_ref()),
        )
    }
    #[test]
    fn signed_manifest_is_bound_to_version_and_platform() {
        let (mut envelope, key) = signed();
        assert_eq!(verify(&envelope, &key).unwrap().version, "0.2.0");
        assert!(verify(&envelope, "").is_err());
        envelope.payload = STANDARD.encode(b"{}");
        assert!(verify(&envelope, &key).is_err());
    }
    #[test]
    fn server_settings_reject_credentials_and_non_http_schemes() {
        for value in [
            "file:///tmp",
            "https://user:pass@example.com",
            "https://example.com?q=secret",
            "invalid",
        ] {
            assert!(valid_server(value).is_err());
        }
        assert!(valid_server("http://127.0.0.1:8000").is_ok());
        assert!(valid_server("https://example.com/telemetry").is_ok());
    }
    #[tokio::test]
    async fn cached_package_is_reverified_not_trusted_by_filename() {
        let (env, key) = signed();
        let manifest = verify(&env, &key).unwrap();
        let path = std::env::temp_dir().join(format!("aaw-update-test-{}", std::process::id()));
        tokio::fs::write(&path, b"abc").await.unwrap();
        assert!(verify_file(&path, &manifest).await.is_ok());
        tokio::fs::write(&path, b"bad").await.unwrap();
        assert!(verify_file(&path, &manifest).await.is_err());
        tokio::fs::remove_file(path).await.unwrap();
    }
    async fn serve(body: &'static [u8]) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 4096];
            let _ = stream.read(&mut buffer).await;
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            stream.write_all(body).await.unwrap();
        });
        url
    }
    #[tokio::test]
    async fn downloads_enforce_signed_size_hash_and_metadata_limits() {
        let (env, key) = signed();
        let data = verify(&env, &key).unwrap();
        let http = client().unwrap();
        let path = std::env::temp_dir().join(format!("aaw-download-test-{}", std::process::id()));
        assert!(
            download_file(&http, &serve(b"abc").await, &data, &path, |_| {})
                .await
                .is_ok()
        );
        assert!(
            download_file(&http, &serve(b"tampered").await, &data, &path, |_| {})
                .await
                .is_err()
        );
        assert!(
            download_file(&http, &serve(b"bad").await, &data, &path, |_| {})
                .await
                .is_err()
        );
        assert!(
            metadata(&http, &serve(b"oversized").await, 2)
                .await
                .is_err()
        );
        tokio::fs::remove_file(path).await.unwrap();
    }
}
