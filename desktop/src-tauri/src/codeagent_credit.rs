use serde::Serialize;

#[derive(Default)]
pub(crate) struct CreditQuota {
    #[cfg(windows)]
    cache: tokio::sync::Mutex<std::collections::HashMap<String, windows::CachedQuota>>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(crate) enum QuotaResult {
    #[cfg(windows)]
    Ready {
        snapshot: windows::Snapshot,
    },
    #[cfg(windows)]
    Stale {
        snapshot: windows::Snapshot,
    },
    #[cfg(windows)]
    SignInRequired,
    Unavailable,
    #[cfg(not(windows))]
    Unsupported,
}

#[derive(Serialize)]
pub(crate) struct TokenQuotaResult {
    #[serde(flatten)]
    result: QuotaResult,
    #[cfg(windows)]
    models: Vec<windows::Model>,
}

#[tauri::command]
pub(crate) async fn codeagent_credit_quota(
    webview: tauri::Webview,
    quota: tauri::State<'_, CreditQuota>,
) -> Result<QuotaResult, String> {
    if webview.label() != "main" {
        return Ok(QuotaResult::Unavailable);
    }
    #[cfg(windows)]
    {
        use tauri::Manager;
        Ok(windows::read(webview.app_handle(), &quota, windows::Query::Credit).await)
    }
    #[cfg(not(windows))]
    {
        let _ = quota;
        Ok(QuotaResult::Unsupported)
    }
}

#[tauri::command]
pub(crate) async fn codeagent_token_quota(
    webview: tauri::Webview,
    quota: tauri::State<'_, CreditQuota>,
    model_id: Option<String>,
) -> Result<TokenQuotaResult, String> {
    if webview.label() != "main" {
        return Ok(TokenQuotaResult {
            result: QuotaResult::Unavailable,
            #[cfg(windows)]
            models: Vec::new(),
        });
    }
    #[cfg(windows)]
    {
        use tauri::Manager;
        let app = webview.app_handle();
        let result = windows::read(app, &quota, windows::Query::Token(model_id)).await;
        let models = windows::result_models(app, &result).await;
        Ok(TokenQuotaResult { result, models })
    }
    #[cfg(not(windows))]
    {
        let _ = (quota, model_id);
        Ok(TokenQuotaResult {
            result: QuotaResult::Unsupported,
        })
    }
}

#[cfg(windows)]
mod windows {
    use super::{CreditQuota, QuotaResult};
    use base64::{Engine, engine::general_purpose::STANDARD};
    use reqwest::{StatusCode, header::HeaderValue};
    use serde::{Deserialize, Serialize};
    use serde_json::Value;
    use sha2::{Digest, Sha256};
    use std::{
        path::Path,
        ptr::null_mut,
        time::{Duration, Instant},
    };
    use tauri::Manager;
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
        },
    };

    const GREEN: &str = "https://snapengine.cida.cce.prod-szv-g.dragon.tools.huawei.com";
    const YELLOW: &str = "https://snapengine.cida.cce.prod-szv-y.dragon.tools.huawei.com";
    const REFRESH_INTERVAL: Duration = Duration::from_secs(60);
    const TOKEN_REFRESH_INTERVAL: Duration = Duration::from_secs(10);
    const MAX_RESPONSE_BYTES: usize = 128 * 1024;
    const MAX_SAVED_BYTES: u64 = 1024 * 1024;
    const MAX_SAVED_MODELS: usize = 128;
    const CREDIT_KINDS: &[&str] = &["CPM", "CPD_Peak", "CPD_Valley"];
    const TOKEN_KINDS: &[&str] = &["TPM", "TPH", "TPD"];

    pub(super) enum Query {
        Credit,
        Token(Option<String>),
    }

    #[derive(Clone, Serialize, Deserialize)]
    pub(crate) struct Model {
        value: String,
        label: String,
    }

    #[derive(Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub(crate) struct Snapshot {
        rows: Vec<Row>,
        fetched_at: i64,
        models: Vec<Model>,
        model_id: Option<String>,
    }

    #[derive(Clone, Serialize, Deserialize, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct Row {
        kind: String,
        used: f64,
        total: f64,
        reset_at: Option<String>,
        message: Option<String>,
    }

    pub(super) struct CachedQuota {
        fingerprint: [u8; 32],
        checked_at: Instant,
        result: QuotaResult,
    }

    #[derive(Default, Serialize, Deserialize)]
    struct SavedTokenQuotas {
        schema: u8,
        fingerprint: [u8; 32],
        entries: std::collections::BTreeMap<String, Snapshot>,
    }

    fn saved_token_quotas(path: &Path, fingerprint: &[u8; 32]) -> Option<SavedTokenQuotas> {
        if std::fs::metadata(path).ok()?.len() > MAX_SAVED_BYTES {
            return None;
        }
        let record: SavedTokenQuotas = crate::storage_preferences::read_record(path).ok()?;
        (record.schema == 1
            && &record.fingerprint == fingerprint
            && record.entries.len() <= MAX_SAVED_MODELS)
            .then_some(record)
    }

    fn valid_saved_snapshot(snapshot: &Snapshot, model_id: &str) -> bool {
        !model_id.is_empty()
            && model_id.len() <= 240
            && !model_id.chars().any(char::is_control)
            && snapshot.model_id.as_deref() == Some(model_id)
            && snapshot.fetched_at > 0
            && snapshot.rows.len() <= TOKEN_KINDS.len()
            && snapshot.rows.iter().enumerate().all(|(index, row)| {
                TOKEN_KINDS.contains(&row.kind.as_str())
                    && row.used.is_finite()
                    && row.used >= 0.0
                    && row.total.is_finite()
                    && row.total >= 0.0
                    && !snapshot.rows[..index]
                        .iter()
                        .any(|prior| prior.kind == row.kind)
            })
    }

    fn load_saved_token(path: &Path, fingerprint: &[u8; 32], model_id: &str) -> Option<Snapshot> {
        let mut snapshot = saved_token_quotas(path, fingerprint)?
            .entries
            .remove(model_id)?;
        if !valid_saved_snapshot(&snapshot, model_id) {
            return None;
        }
        snapshot.models.clear();
        Some(snapshot)
    }

    fn saved_models(path: &Path, fingerprint: &[u8; 32]) -> Vec<Model> {
        saved_token_quotas(path, fingerprint)
            .map(|record| {
                record
                    .entries
                    .into_iter()
                    .filter(|(id, snapshot)| valid_saved_snapshot(snapshot, id))
                    .map(|(id, _)| Model {
                        label: id.clone(),
                        value: id,
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn save_token(path: &Path, fingerprint: [u8; 32], snapshot: &Snapshot) -> Result<bool, String> {
        let Some(model_id) = snapshot.model_id.as_deref() else {
            return Ok(false);
        };
        if !valid_saved_snapshot(snapshot, model_id) {
            return Err("模型额度无效".into());
        }
        let mut record =
            saved_token_quotas(path, &fingerprint).unwrap_or_else(|| SavedTokenQuotas {
                schema: 1,
                fingerprint,
                entries: Default::default(),
            });
        let mut latest = snapshot.clone();
        // 缓存只保留模型计数；轮询时间、重置时间和展示元数据不触发磁盘写入。
        latest.models.clear();
        for row in &mut latest.rows {
            row.reset_at = None;
            row.message = None;
        }
        if record
            .entries
            .get(model_id)
            .is_some_and(|prior| valid_saved_snapshot(prior, model_id) && prior.rows == latest.rows)
        {
            return Ok(false);
        }
        record.entries.insert(model_id.to_owned(), latest);
        if record.entries.len() > MAX_SAVED_MODELS {
            if let Some(oldest) = record
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.fetched_at)
                .map(|(id, _)| id.clone())
            {
                record.entries.remove(&oldest);
            }
        }
        crate::storage_preferences::write_record(path, &record)?;
        Ok(true)
    }

    fn unprotect(encoded: &str) -> Option<String> {
        let mut encrypted = STANDARD.decode(encoded).ok()?;
        let input = CRYPT_INTEGER_BLOB {
            cbData: encrypted.len().try_into().ok()?,
            pbData: encrypted.as_mut_ptr(),
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        // DPAPI owns the returned allocation until LocalFree.
        let success = unsafe {
            CryptUnprotectData(
                &input,
                null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if output.pbData.is_null() {
            return None;
        }
        let result = unsafe {
            let token = (success != 0)
                .then(|| std::slice::from_raw_parts(output.pbData, output.cbData as usize))
                .and_then(|bytes| std::str::from_utf8(bytes).ok())
                .map(str::to_owned);
            LocalFree(output.pbData.cast());
            token
        };
        result
    }

    fn token_header(value: &str) -> Option<HeaderValue> {
        let value = value.trim();
        let plain;
        let value = if value.starts_with("AQAAANCMnd8BFdER") {
            plain = unprotect(value)?;
            plain.trim()
        } else {
            value
        };
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_graphic()) {
            return None;
        }
        let mut header = HeaderValue::from_str(value).ok()?;
        header.set_sensitive(true);
        Some(header)
    }

    async fn read_credentials(home: &Path) -> Result<HeaderValue, QuotaResult> {
        if let Some(token) = std::env::var("CODEAGENT3_X_AUTH_TOKEN")
            .ok()
            .and_then(|value| token_header(&value))
        {
            return Ok(token);
        }
        let raw = tokio::fs::read(home.join(".cac").join(".credentials.json"))
            .await
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    QuotaResult::SignInRequired
                } else {
                    QuotaResult::Unavailable
                }
            })?;
        let file: Value = serde_json::from_slice(&raw).map_err(|_| QuotaResult::Unavailable)?;
        let now = chrono::Utc::now().timestamp_millis();
        let candidates = [
            ("/idaasOAuth/xAuthToken", "/idaasOAuth/xAuthExpires"),
            ("/idaasOAuth/accessToken", "/idaasOAuth/expiresAt"),
            ("/devUCOAuth/accessToken", "/devUCOAuth/expiresAt"),
        ];
        candidates
            .into_iter()
            .find_map(|(field, expiry)| {
                if file
                    .pointer(expiry)
                    .and_then(Value::as_i64)
                    .is_some_and(|time| time <= now)
                {
                    return None;
                }
                token_header(file.pointer(field)?.as_str()?)
            })
            .ok_or(QuotaResult::SignInRequired)
    }

    fn parse_count(value: &Value) -> Option<f64> {
        let count = value
            .as_f64()
            .or_else(|| value.as_str()?.trim().parse().ok())?;
        (count.is_finite() && count >= 0.0).then_some(count)
    }

    fn parse_rows(value: &Value, kinds: &'static [&'static str]) -> Option<Vec<Row>> {
        let entries = value.get("quotas")?.as_array()?;
        let rows: Vec<_> = kinds
            .iter()
            .copied()
            .filter_map(|kind| {
                let mut matching = entries.iter().filter(|entry| entry["type"] == kind);
                let entry = matching.next()?;
                if matching.next().is_some() {
                    return None;
                }
                Some(Row {
                    kind: kind.to_owned(),
                    used: parse_count(&entry["used_quota"])?,
                    total: parse_count(&entry["total_quota"])?,
                    reset_at: entry["reset_at"]
                        .as_str()
                        .filter(|value| {
                            chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S")
                                .is_ok()
                        })
                        .map(str::to_owned),
                    message: entry["message_cn"]
                        .as_str()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(|value| value.chars().take(240).collect()),
                })
            })
            .collect();
        (entries.is_empty() || !rows.is_empty()).then_some(rows)
    }

    fn parse_models(config: &Value) -> Vec<Model> {
        let Some(encoded) = config["enterpriseModelOptionsCacheV3_5"].as_str() else {
            return Vec::new();
        };
        let decoded = encoded
            .strip_prefix("Q2FjaGVWXzU=")
            .and_then(|value| value.strip_suffix("RW5k"))
            .and_then(|value| STANDARD.decode(value).ok())
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        let Some(entries) = decoded.as_ref().and_then(Value::as_array) else {
            return Vec::new();
        };
        let mut models = Vec::new();
        let mut add = |id: &str, label: Option<&str>| {
            if id.is_empty()
                || id.len() > 240
                || id.chars().any(char::is_control)
                || id.to_ascii_lowercase().ends_with("-auto")
                || models.iter().any(|model: &Model| model.value == id)
                || models.len() >= 128
            {
                return;
            }
            models.push(Model {
                value: id.to_owned(),
                label: label
                    .filter(|label| !label.trim().is_empty())
                    .unwrap_or(id)
                    .chars()
                    .take(240)
                    .collect(),
            });
        };
        for entry in entries {
            if entry["isCustom"].as_bool() == Some(true) {
                continue;
            }
            if let Some(tiers) = entry
                .pointer("/tieredModelConfig/tiers")
                .and_then(Value::as_object)
            {
                for tier in tiers.values().filter_map(Value::as_str) {
                    add(tier, None);
                }
            } else if let Some(id) = entry["value"].as_str() {
                add(id, entry["label"].as_str());
            }
        }
        models
    }

    pub(super) async fn result_models(app: &tauri::AppHandle, result: &QuotaResult) -> Vec<Model> {
        match result {
            QuotaResult::Ready { snapshot } | QuotaResult::Stale { snapshot } => {
                snapshot.models.clone()
            }
            QuotaResult::SignInRequired => Vec::new(),
            // 额度接口失败时，仍允许用户切换到其它具体模型。
            _ => {
                let Ok(home) = app.path().home_dir() else {
                    return Vec::new();
                };
                tokio::fs::read(home.join(".cac.json"))
                    .await
                    .ok()
                    .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok())
                    .map(|config| parse_models(&config))
                    .unwrap_or_default()
            }
        }
    }

    enum FetchError {
        Authentication,
        Temporary,
        InvalidResponse,
    }

    fn quota_url(host: &str, model_id: Option<&str>) -> Result<reqwest::Url, FetchError> {
        let mut url = reqwest::Url::parse(host).map_err(|_| FetchError::InvalidResponse)?;
        let mut path = url
            .path_segments_mut()
            .map_err(|_| FetchError::InvalidResponse)?;
        path.clear().push("api").push("v1");
        if let Some(id) = model_id {
            path.push("models").push(id);
        }
        path.push("quota").push("usage");
        drop(path);
        Ok(url)
    }

    fn quota_client() -> reqwest::ClientBuilder {
        // 额度内网接口沿用 CodeAgent CLI 的直连方式。
        reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .https_only(true)
            .timeout(Duration::from_secs(4))
    }

    async fn fetch(
        token: HeaderValue,
        yellow_first: bool,
        model_id: Option<&str>,
    ) -> Result<Snapshot, FetchError> {
        let client = quota_client().build().map_err(|_| FetchError::Temporary)?;
        let hosts = if yellow_first {
            [YELLOW, GREEN]
        } else {
            [GREEN, YELLOW]
        };
        'hosts: for host in hosts {
            let mut response = match client
                .get(quota_url(host, model_id)?)
                .header("x-auth-token", token.clone())
                .send()
                .await
            {
                Ok(response) => response,
                Err(error) if error.is_timeout() || error.is_connect() => continue,
                Err(_) => return Err(FetchError::Temporary),
            };
            let status = response.status();
            if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
                return Err(FetchError::Authentication);
            }
            if status.is_server_error() {
                continue;
            }
            if status == StatusCode::TOO_MANY_REQUESTS {
                return Err(FetchError::Temporary);
            }
            if status != StatusCode::OK {
                return Err(FetchError::InvalidResponse);
            }
            let mut body = Vec::new();
            loop {
                let chunk = match response.chunk().await {
                    Ok(Some(chunk)) => chunk,
                    Ok(None) => break,
                    Err(error) if error.is_timeout() || error.is_connect() => continue 'hosts,
                    Err(_) => return Err(FetchError::Temporary),
                };
                if chunk.len() > MAX_RESPONSE_BYTES - body.len() {
                    return Err(FetchError::InvalidResponse);
                }
                body.extend_from_slice(&chunk);
            }
            let data = serde_json::from_slice(&body).map_err(|_| FetchError::InvalidResponse)?;
            let rows = parse_rows(
                &data,
                if model_id.is_some() {
                    TOKEN_KINDS
                } else {
                    CREDIT_KINDS
                },
            )
            .filter(|rows| model_id.is_some() || !rows.is_empty())
            .ok_or(FetchError::InvalidResponse)?;
            return Ok(Snapshot {
                rows,
                fetched_at: chrono::Utc::now().timestamp_millis(),
                models: Vec::new(),
                model_id: model_id.map(str::to_owned),
            });
        }
        Err(FetchError::Temporary)
    }

    pub(super) async fn read(
        app: &tauri::AppHandle,
        quota: &CreditQuota,
        query: Query,
    ) -> QuotaResult {
        let Ok(home) = app.path().home_dir() else {
            return QuotaResult::Unavailable;
        };
        let saved_path = crate::storage_location::data_dir(app).ok().map(|root| {
            root.join("configuration")
                .join("codeagent-token-quota.json")
        });
        let mut cache = quota.cache.lock().await;
        let token = match read_credentials(&home).await {
            Ok(token) => token,
            Err(result) => {
                cache.clear();
                return result;
            }
        };
        let fingerprint: [u8; 32] = Sha256::digest(token.as_bytes()).into();
        cache.retain(|_, cached| cached.fingerprint == fingerprint);
        let zone = tokio::fs::read(home.join(".cac.json"))
            .await
            .ok()
            .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok());
        let (model_id, models) = match query {
            Query::Credit => (None, Vec::new()),
            Query::Token(requested) => {
                let mut models = zone.as_ref().map(parse_models).unwrap_or_default();
                if models.is_empty() {
                    if let Some(path) = saved_path.clone() {
                        models =
                            tokio::task::spawn_blocking(move || saved_models(&path, &fingerprint))
                                .await
                                .unwrap_or_default();
                    }
                }
                cache.retain(|key, _| {
                    key.is_empty() || models.iter().any(|model| model.value == *key)
                });
                let selected = requested
                    .as_deref()
                    .and_then(|id| models.iter().find(|model| model.value == id))
                    .or_else(|| models.first())
                    .map(|model| model.value.clone());
                if selected.is_none() {
                    return QuotaResult::Ready {
                        snapshot: Snapshot {
                            rows: Vec::new(),
                            models,
                            model_id: None,
                            fetched_at: chrono::Utc::now().timestamp_millis(),
                        },
                    };
                }
                (selected, models)
            }
        };
        let key = model_id.as_deref().unwrap_or("");
        let previous = cache.get(key);
        let refresh_interval = if model_id.is_some() {
            TOKEN_REFRESH_INTERVAL
        } else {
            REFRESH_INTERVAL
        };
        if let Some(cached) =
            previous.filter(|cached| cached.checked_at.elapsed() < refresh_interval)
        {
            let mut result = cached.result.clone();
            if let QuotaResult::Ready { snapshot } | QuotaResult::Stale { snapshot } = &mut result {
                snapshot.models = models;
            }
            return result;
        }
        let saved = if previous.is_none() {
            match (saved_path.clone(), model_id.clone()) {
                (Some(path), Some(id)) => {
                    tokio::task::spawn_blocking(move || load_saved_token(&path, &fingerprint, &id))
                        .await
                        .ok()
                        .flatten()
                }
                _ => None,
            }
        } else {
            None
        };
        let yellow_first = zone
            .as_ref()
            .and_then(|value| value["enterpriseNetworkZoneCache"].as_str())
            == Some("yellow");
        let result = match fetch(token, yellow_first, model_id.as_deref()).await {
            Ok(mut snapshot) => {
                snapshot.models = models.clone();
                QuotaResult::Ready { snapshot }
            }
            Err(FetchError::Authentication) => QuotaResult::SignInRequired,
            Err(FetchError::Temporary | FetchError::InvalidResponse) => {
                let prior = match previous.map(|cached| &cached.result) {
                    Some(QuotaResult::Ready { snapshot } | QuotaResult::Stale { snapshot }) => {
                        Some(snapshot)
                    }
                    _ => saved.as_ref(),
                };
                match prior {
                    Some(snapshot) => {
                        let mut snapshot = snapshot.clone();
                        snapshot.models = models;
                        QuotaResult::Stale { snapshot }
                    }
                    _ => QuotaResult::Unavailable,
                }
            }
        };
        // 请求期间切换登录时，丢弃旧身份的数据。
        match read_credentials(&home).await {
            Ok(token) if fingerprint == <[u8; 32]>::from(Sha256::digest(token.as_bytes())) => {}
            Err(status) => {
                cache.clear();
                return status;
            }
            Ok(_) => {
                cache.clear();
                return QuotaResult::Unavailable;
            }
        }
        if matches!(result, QuotaResult::SignInRequired) {
            cache.clear();
            if let Some(path) = saved_path {
                let _ = tokio::fs::remove_file(path).await;
            }
            return result;
        }
        if model_id.is_some() {
            if let (Some(path), QuotaResult::Ready { snapshot }) = (saved_path, &result) {
                let snapshot = snapshot.clone();
                let _ =
                    tokio::task::spawn_blocking(move || save_token(&path, fingerprint, &snapshot))
                        .await;
            }
        }
        cache.insert(
            key.to_owned(),
            CachedQuota {
                fingerprint,
                checked_at: Instant::now(),
                result: result.clone(),
            },
        );
        result
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use serde_json::json;
        use windows_sys::Win32::Security::Cryptography::CryptProtectData;

        #[tokio::test]
        async fn quota_client_connects_directly_when_https_proxy_is_set() {
            use tokio::{io::AsyncReadExt, net::TcpListener};

            const TEST_CHILD: &str = "AAW_TEST_CODEAGENT_QUOTA_PROXY_CHILD";
            const TEST_NAME: &str = "codeagent_credit::windows::tests::quota_client_connects_directly_when_https_proxy_is_set";

            if let Some(proxy) = std::env::var_os(TEST_CHILD) {
                let proxy: std::net::SocketAddr = proxy.into_string().unwrap().parse().unwrap();
                let client = quota_client().resolve("quota.test", proxy).build().unwrap();
                // 监听器在读到首字节后关闭，所以 TLS 不会完成，也无需凭证。
                let _ = client
                    .get(format!("https://quota.test:{}/", proxy.port()))
                    .send()
                    .await;
                return;
            }

            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            // 只给子进程设置代理，避免污染同进程的其他网络测试。
            let mut child = tokio::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", TEST_NAME])
                .env(TEST_CHILD, address.to_string())
                .env("HTTPS_PROXY", format!("http://{address}"))
                .env_remove("NO_PROXY")
                .kill_on_drop(true)
                .spawn()
                .unwrap();

            let first_byte = tokio::time::timeout(Duration::from_secs(8), async {
                let (mut socket, _) = listener.accept().await.unwrap();
                socket.read_u8().await.unwrap()
            })
            .await
            .expect("额度客户端没有连接到本地监听器");
            assert!(child.wait().await.unwrap().success());
            assert_eq!(first_byte, 0x16, "直连应先发送 TLS 握手，而非代理 CONNECT");
        }

        struct DiskFixture(std::path::PathBuf);

        impl DiskFixture {
            fn new() -> Self {
                let root = std::env::temp_dir().join(format!(
                    "aaw-token-quota-{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_nanos()
                ));
                std::fs::create_dir(&root).unwrap();
                Self(root)
            }
            fn path(&self) -> std::path::PathBuf {
                self.0.join("quota.json")
            }
        }

        impl Drop for DiskFixture {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(self.path());
                let _ = std::fs::remove_dir(&self.0);
            }
        }

        fn saved_fixture(model_id: &str, used: f64) -> Snapshot {
            Snapshot {
                rows: parse_rows(
                    &json!({"quotas":[
                        {"type":"TPM", "used_quota":used, "total_quota":"2000000"},
                        {"type":"TPH", "used_quota":"100", "total_quota":"200000000"},
                        {"type":"TPD", "used_quota":"200", "total_quota":"600000000"}
                    ]}),
                    TOKEN_KINDS,
                )
                .unwrap(),
                fetched_at: 1794950400000,
                models: Vec::new(),
                model_id: Some(model_id.to_owned()),
            }
        }

        #[test]
        fn repeated_polls_write_once_and_changed_counts_replace_one_model_record() {
            let disk = DiskFixture::new();
            let path = disk.path();
            let mut snapshot = saved_fixture("model-a", 10.0);
            assert!(save_token(&path, [1; 32], &snapshot).unwrap());
            let original = std::fs::read(&path).unwrap();
            let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
            for index in 0..1000 {
                snapshot.fetched_at += 15_000;
                snapshot.rows[0].reset_at = Some(format!("window-{index}"));
                snapshot.rows[0].message = Some(format!("metadata-{index}"));
                assert!(!save_token(&path, [1; 32], &snapshot).unwrap());
            }
            assert_eq!(std::fs::read(&path).unwrap(), original);
            assert_eq!(
                std::fs::metadata(&path).unwrap().modified().unwrap(),
                modified
            );
            snapshot.rows[0].used = 20.0;
            assert!(save_token(&path, [1; 32], &snapshot).unwrap());
            assert_eq!(
                saved_token_quotas(&path, &[1; 32]).unwrap().entries.len(),
                1
            );
            assert_eq!(
                load_saved_token(&path, &[1; 32], "model-a").unwrap().rows[0].used,
                20.0
            );
            snapshot.rows[0].total = 3000000.0;
            assert!(save_token(&path, [1; 32], &snapshot).unwrap());
            assert_eq!(
                saved_token_quotas(&path, &[1; 32]).unwrap().entries.len(),
                1
            );
            assert_eq!(std::fs::read_dir(&disk.0).unwrap().count(), 1);
        }

        #[test]
        fn disk_cache_survives_memory_reset_and_isolates_login_and_models() {
            let disk = DiskFixture::new();
            let path = disk.path();
            save_token(&path, [1; 32], &saved_fixture("model-a", 10.0)).unwrap();
            save_token(&path, [1; 32], &saved_fixture("model-b", 20.0)).unwrap();
            // 只从文件读取，模拟退出后无内存状态的再次启动。
            assert_eq!(
                load_saved_token(&path, &[1; 32], "model-a").unwrap().rows[0].used,
                10.0
            );
            assert_eq!(
                load_saved_token(&path, &[1; 32], "model-b").unwrap().rows[0].used,
                20.0
            );
            assert!(load_saved_token(&path, &[1; 32], "other-model").is_none());
            assert!(load_saved_token(&path, &[2; 32], "model-a").is_none());
            assert_eq!(saved_models(&path, &[1; 32]).len(), 2);
            save_token(&path, [2; 32], &saved_fixture("model-b", 30.0)).unwrap();
            assert!(load_saved_token(&path, &[1; 32], "model-a").is_none());
            assert!(load_saved_token(&path, &[2; 32], "model-a").is_none());
            assert_eq!(
                saved_token_quotas(&path, &[2; 32]).unwrap().entries.len(),
                1
            );
            assert_eq!(std::fs::read_dir(&disk.0).unwrap().count(), 1);
        }

        #[test]
        fn cached_model_count_is_bounded_and_invalid_files_are_ignored() {
            let disk = DiskFixture::new();
            let path = disk.path();
            for index in 0..MAX_SAVED_MODELS + 12 {
                let mut snapshot = saved_fixture(&format!("model-{index:03}"), index as f64);
                snapshot.fetched_at += index as i64;
                save_token(&path, [1; 32], &snapshot).unwrap();
            }
            assert_eq!(
                saved_token_quotas(&path, &[1; 32]).unwrap().entries.len(),
                MAX_SAVED_MODELS
            );
            assert!(load_saved_token(&path, &[1; 32], "model-000").is_none());
            assert!(load_saved_token(&path, &[1; 32], "model-139").is_some());
            assert_eq!(std::fs::read_dir(&disk.0).unwrap().count(), 1);
            std::fs::write(&path, b"{broken").unwrap();
            assert!(load_saved_token(&path, &[1; 32], "model-139").is_none());
            save_token(&path, [1; 32], &saved_fixture("model-a", 42.0)).unwrap();
            let mut record = saved_token_quotas(&path, &[1; 32]).unwrap();
            record.entries.get_mut("model-a").unwrap().rows[0].used = -1.0;
            crate::storage_preferences::write_record(&path, &record).unwrap();
            assert!(load_saved_token(&path, &[1; 32], "model-a").is_none());
            assert!(saved_models(&path, &[1; 32]).is_empty());
        }

        #[test]
        fn normalizes_model_windows_by_type_instead_of_response_order() {
            let rows = parse_rows(
                &json!({"quotas": [
                    {"type":"TPD", "used_quota":"3630932", "total_quota":"400000000"},
                    {"type":"TPM", "used_quota":"236571", "total_quota":"2000000"},
                    {"type":"TPH", "used_quota":"453761", "total_quota":"200000000"}
                ]}),
                TOKEN_KINDS,
            )
            .unwrap();
            assert_eq!(
                rows.iter().map(|row| row.kind.as_str()).collect::<Vec<_>>(),
                ["TPM", "TPH", "TPD"]
            );
            assert_eq!(rows[0].used, 236571.0);
            assert_eq!(rows[2].total, 400000000.0);
            assert!(
                parse_rows(
                    &json!({"quotas":[
                        {"type":"TPM", "used_quota":"NaN", "total_quota":"100"}
                    ]}),
                    TOKEN_KINDS
                )
                .is_none()
            );
            assert!(
                parse_rows(
                    &json!({"quotas":[
                        {"type":"TPM", "used_quota":"0", "total_quota":"100"},
                        {"type":"TPM", "used_quota":"0", "total_quota":"200"}
                    ]}),
                    TOKEN_KINDS
                )
                .is_none()
            );
        }

        #[test]
        fn resolves_concrete_auto_tiers_without_inventing_an_auto_quota() {
            let list = json!([
                {"value":"GLM-5.3-Auto", "tieredModelConfig":{"tiers":{
                    "large":"GLM-5.3-CodeAgent", "small":"deepseek-v4.1-flash-1017"
                }}},
                {"value":"GLM-5.3-CodeAgent"},
                {"value":"private-provider", "isCustom":true},
                {"value":"other-Auto"}
            ]);
            let encoded = format!(
                "Q2FjaGVWXzU={}RW5k",
                STANDARD.encode(serde_json::to_vec(&list).unwrap())
            );
            let models = parse_models(&json!({"enterpriseModelOptionsCacheV3_5":encoded}));
            assert_eq!(
                models
                    .iter()
                    .map(|model| model.value.as_str())
                    .collect::<Vec<_>>(),
                ["GLM-5.3-CodeAgent", "deepseek-v4.1-flash-1017"]
            );
            assert!(parse_models(&json!({"enterpriseModelOptionsCacheV3_5":"broken"})).is_empty());
        }

        #[test]
        fn encodes_model_ids_as_a_single_path_segment() {
            let url = quota_url(YELLOW, Some("model/name ?#")).ok().unwrap();
            assert_eq!(
                url.host_str(),
                Some("snapengine.cida.cce.prod-szv-y.dragon.tools.huawei.com")
            );
            assert_eq!(
                url.path(),
                "/api/v1/models/model%2Fname%20%3F%23/quota/usage"
            );
            assert!(url.query().is_none());
            assert!(url.fragment().is_none());
            assert_eq!(
                quota_url(GREEN, None).ok().unwrap().path(),
                "/api/v1/quota/usage"
            );
        }

        #[test]
        fn normalizes_only_unique_valid_account_rows() {
            let rows = parse_rows(&json!({
                "quotas": [
                    {"type": "unknown", "used_quota": 1, "total_quota": 2},
                    {"type": "CPD_Valley", "used_quota": "", "total_quota": 5},
                    {"type": "CPM", "used_quota": "1.5", "total_quota": 10, "reset_at": "2026-12-01 00:00:00"},
                    {"type": "CPD_Peak", "used_quota": 0, "total_quota": 8}
                ]
            }), CREDIT_KINDS).unwrap();
            assert_eq!(
                rows.iter().map(|row| row.kind.as_str()).collect::<Vec<_>>(),
                ["CPM", "CPD_Peak"]
            );
            assert_eq!(rows[0].used, 1.5);
            assert_eq!(rows[0].reset_at.as_deref(), Some("2026-12-01 00:00:00"));
            assert_eq!(rows[1].used, 0.0);
            assert!(
                parse_rows(&json!({"quotas": []}), CREDIT_KINDS)
                    .unwrap()
                    .is_empty()
            );
        }

        #[test]
        fn decrypts_a_current_user_test_token_without_accepting_broken_encrypted_values() {
            let mut token = *b"local-dpapi-test-token";
            let input = CRYPT_INTEGER_BLOB {
                cbData: token.len() as u32,
                pbData: token.as_mut_ptr(),
            };
            let mut output = CRYPT_INTEGER_BLOB::default();
            let encrypted = unsafe {
                assert_ne!(
                    CryptProtectData(
                        &input,
                        std::ptr::null(),
                        std::ptr::null(),
                        std::ptr::null(),
                        std::ptr::null(),
                        CRYPTPROTECT_UI_FORBIDDEN,
                        &mut output,
                    ),
                    0
                );
                let encoded = STANDARD.encode(std::slice::from_raw_parts(
                    output.pbData,
                    output.cbData as usize,
                ));
                LocalFree(output.pbData.cast());
                encoded
            };
            let header = token_header(&encrypted).unwrap();
            assert_eq!(header.as_bytes(), token);
            assert!(header.is_sensitive());
            assert!(token_header("AQAAANCMnd8BFdER-invalid").is_none());
        }
    }
}
