//! Capture immutable local or HTTP(S) artifact content for one workflow run.
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};

const MAX_BYTES: u64 = 25 * 1024 * 1024;
pub struct Captured {
    pub source: String,
    pub sha256: String,
    pub content: Vec<u8>,
    pub media_type: String,
}
pub fn capture(project: &Path, reference: &str) -> Result<Captured, String> {
    if reference.trim().is_empty() {
        return Err("ARTIFACT_REFERENCE_REQUIRED".into());
    }
    let (source, media_type, mut reader): (String, String, Box<dyn Read>) =
        if reference.starts_with("http://") || reference.starts_with("https://") {
            let url = reqwest::Url::parse(reference).map_err(|_| "ARTIFACT_INVALID_URL")?;
            if !url.username().is_empty() || url.password().is_some() {
                return Err("ARTIFACT_URL_CREDENTIALS_UNSUPPORTED".into());
            }
            let client = reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(30))
                .redirect(reqwest::redirect::Policy::limited(5))
                .build()
                .map_err(|_| "ARTIFACT_HTTP_UNAVAILABLE")?;
            let response = client
                .get(url.clone())
                .send()
                .map_err(|_| "ARTIFACT_HTTP_FAILED")?
                .error_for_status()
                .map_err(|_| "ARTIFACT_HTTP_FAILED")?;
            if response.content_length().is_some_and(|n| n > MAX_BYTES) {
                return Err("ARTIFACT_TOO_LARGE".into());
            }
            let media = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/octet-stream")
                .to_owned();
            let mut visible = url;
            visible.set_query(None);
            visible.set_fragment(None);
            (visible.to_string(), media, Box::new(response))
        } else {
            let path = if reference.starts_with("file:") {
                reqwest::Url::parse(reference)
                    .map_err(|_| "ARTIFACT_INVALID_URL")?
                    .to_file_path()
                    .map_err(|_| "ARTIFACT_INVALID_PATH")?
            } else {
                PathBuf::from(reference)
            };
            let path = if path.is_absolute() {
                path
            } else {
                project.join(path)
            };
            let path = std::fs::canonicalize(path).map_err(|_| "ARTIFACT_FILE_UNAVAILABLE")?;
            let file = std::fs::File::open(&path).map_err(|_| "ARTIFACT_FILE_UNAVAILABLE")?;
            if !file
                .metadata()
                .map_err(|_| "ARTIFACT_FILE_UNAVAILABLE")?
                .is_file()
            {
                return Err("ARTIFACT_NOT_A_FILE".into());
            }
            (
                path.to_string_lossy().into_owned(),
                "application/octet-stream".into(),
                Box::new(file),
            )
        };
    let mut content = Vec::new();
    reader
        .by_ref()
        .take(MAX_BYTES + 1)
        .read_to_end(&mut content)
        .map_err(|_| "ARTIFACT_READ_FAILED")?;
    if content.len() as u64 > MAX_BYTES {
        return Err("ARTIFACT_TOO_LARGE".into());
    }
    let sha256 = format!("{:x}", Sha256::digest(&content));
    Ok(Captured {
        source,
        sha256,
        content,
        media_type,
    })
}
