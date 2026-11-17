use serde::Serialize;

#[derive(Default)]
pub(crate) struct CreditQuota {
    #[cfg(windows)]
    cache: tokio::sync::Mutex<Option<windows::CachedQuota>>,
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

#[tauri::command]
pub(crate) async fn codeagent_credit_quota(
    window: tauri::WebviewWindow,
    quota: tauri::State<'_, CreditQuota>,
) -> Result<QuotaResult, String> {
    if window.label() != "main" {
        return Ok(QuotaResult::Unavailable);
    }
    #[cfg(windows)]
    return Ok(windows::read(&window, &quota).await);
    #[cfg(not(windows))]
    {
        let _ = quota;
        Ok(QuotaResult::Unsupported)
    }
}

#[cfg(windows)]
mod windows {
    use super::{CreditQuota, QuotaResult};
    use base64::{engine::general_purpose::STANDARD, Engine};
    use reqwest::{header::HeaderValue, StatusCode};
    use serde::Serialize;
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
            CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };

    const GREEN: &str =
        "https://snapengine.cida.cce.prod-szv-g.dragon.tools.huawei.com/api/v1/quota/usage";
    const YELLOW: &str =
        "https://snapengine.cida.cce.prod-szv-y.dragon.tools.huawei.com/api/v1/quota/usage";
    const REFRESH_INTERVAL: Duration = Duration::from_secs(60);
    const MAX_RESPONSE_BYTES: usize = 128 * 1024;

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub(crate) struct Snapshot {
        rows: Vec<Row>,
        fetched_at: i64,
    }

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Row {
        kind: &'static str,
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

    fn parse_rows(value: &Value) -> Option<Vec<Row>> {
        let entries = value.get("quotas")?.as_array()?;
        let rows: Vec<_> = ["CPM", "CPD_Peak", "CPD_Valley"]
            .into_iter()
            .filter_map(|kind| {
                let mut matching = entries.iter().filter(|entry| entry["type"] == kind);
                let entry = matching.next()?;
                if matching.next().is_some() {
                    return None;
                }
                Some(Row {
                    kind,
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
        (!rows.is_empty()).then_some(rows)
    }

    enum FetchError {
        Authentication,
        Temporary,
        InvalidResponse,
    }

    async fn fetch(token: HeaderValue, yellow_first: bool) -> Result<Snapshot, FetchError> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .https_only(true)
            .timeout(Duration::from_secs(4))
            .build()
            .map_err(|_| FetchError::Temporary)?;
        let hosts = if yellow_first {
            [YELLOW, GREEN]
        } else {
            [GREEN, YELLOW]
        };
        'hosts: for host in hosts {
            let mut response = match client
                .get(host)
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
            let rows = parse_rows(&data).ok_or(FetchError::InvalidResponse)?;
            return Ok(Snapshot {
                rows,
                fetched_at: chrono::Utc::now().timestamp_millis(),
            });
        }
        Err(FetchError::Temporary)
    }

    pub(super) async fn read(window: &tauri::WebviewWindow, quota: &CreditQuota) -> QuotaResult {
        let Ok(home) = window.path().home_dir() else {
            return QuotaResult::Unavailable;
        };
        let mut cache = quota.cache.lock().await;
        let token = match read_credentials(&home).await {
            Ok(token) => token,
            Err(result) => {
                *cache = None;
                return result;
            }
        };
        let fingerprint: [u8; 32] = Sha256::digest(token.as_bytes()).into();
        let previous = cache
            .as_ref()
            .filter(|cached| cached.fingerprint == fingerprint);
        if let Some(cached) =
            previous.filter(|cached| cached.checked_at.elapsed() < REFRESH_INTERVAL)
        {
            return cached.result.clone();
        }
        let zone = tokio::fs::read(home.join(".cac.json"))
            .await
            .ok()
            .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok());
        let yellow_first = zone
            .as_ref()
            .and_then(|value| value["enterpriseNetworkZoneCache"].as_str())
            == Some("yellow");
        let result = match fetch(token, yellow_first).await {
            Ok(snapshot) => QuotaResult::Ready { snapshot },
            Err(FetchError::Authentication) => QuotaResult::SignInRequired,
            Err(FetchError::Temporary | FetchError::InvalidResponse) => {
                match previous.map(|cached| &cached.result) {
                    Some(QuotaResult::Ready { snapshot } | QuotaResult::Stale { snapshot }) => {
                        QuotaResult::Stale {
                            snapshot: snapshot.clone(),
                        }
                    }
                    _ => QuotaResult::Unavailable,
                }
            }
        };
        // Drop results from a login that changed before the request completed.
        match read_credentials(&home).await {
            Ok(token) if fingerprint == <[u8; 32]>::from(Sha256::digest(token.as_bytes())) => {}
            Err(status) => {
                *cache = None;
                return status;
            }
            Ok(_) => {
                *cache = None;
                return QuotaResult::Unavailable;
            }
        }
        *cache = Some(CachedQuota {
            fingerprint,
            checked_at: Instant::now(),
            result: result.clone(),
        });
        result
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use serde_json::json;
        use windows_sys::Win32::Security::Cryptography::CryptProtectData;

        #[test]
        fn normalizes_only_unique_valid_account_rows() {
            let rows = parse_rows(&json!({
                "quotas": [
                    {"type": "unknown", "used_quota": 1, "total_quota": 2},
                    {"type": "CPD_Valley", "used_quota": "", "total_quota": 5},
                    {"type": "CPM", "used_quota": "1.5", "total_quota": 10, "reset_at": "2026-12-01 00:00:00"},
                    {"type": "CPD_Peak", "used_quota": 0, "total_quota": 8}
                ]
            })).unwrap();
            assert_eq!(
                rows.iter().map(|row| row.kind).collect::<Vec<_>>(),
                ["CPM", "CPD_Peak"]
            );
            assert_eq!(rows[0].used, 1.5);
            assert_eq!(rows[0].reset_at.as_deref(), Some("2026-12-01 00:00:00"));
            assert_eq!(rows[1].used, 0.0);
            assert!(parse_rows(&json!({"quotas": []})).is_none());
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
