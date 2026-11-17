//! Read-only, bounded CodeAgent history evidence. Never return/log message text.
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tauri::Manager;

const MAX_FILE: u64 = 64 * 1024 * 1024;
const MAX_LINE: u64 = 8 * 1024 * 1024;
const MAX_USERS: usize = 20_000;
const MAX_DIRS: usize = 512;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserEvidence {
    digest: String,
    bytes: usize,
    compact: bool,
    source_id: String,
}
#[derive(Serialize)]
pub struct HistoryEvidence {
    version: String,
    users: Vec<UserEvidence>,
}

// Same lexical identity as shared/panelPaths.ts (not filesystem canonicalization).
fn path_key(path: &str) -> String {
    let path = path.replace('\\', "/");
    let root = if path.starts_with("//") {
        "//"
    } else if path.starts_with('/') {
        "/"
    } else {
        ""
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in path[root.len()..].split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|p| !p.ends_with(':')) {
                    parts.pop();
                }
            }
            _ => parts.push(part),
        }
    }
    let mut result = format!("{root}{}", parts.join("/"));
    let drive = result
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_alphabetic)
        && result.as_bytes().get(1) == Some(&b':');
    if drive && result.len() == 2 {
        result.push('/');
    }
    if drive || result.starts_with("//") {
        result.to_lowercase()
    } else {
        result
    }
}
fn line(reader: &mut impl BufRead) -> Result<Vec<u8>, &'static str> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_LINE + 1)
        .read_until(b'\n', &mut bytes)
        .map_err(|_| "read-failed")?;
    if bytes.len() as u64 > MAX_LINE {
        return Err("line-limit");
    }
    // A trailing partial line is not evidence of a complete transcript.
    if !bytes.is_empty() && bytes.last() != Some(&b'\n') {
        return Err("incomplete-line");
    }
    Ok(bytes)
}
fn verify(path: &Path, sid: &str, cwd: &str) -> Result<bool, &'static str> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err("candidate-unreadable"),
        Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
            return Err("candidate-not-regular");
        }
        Ok(_) => {}
    }
    let file = File::open(path).map_err(|_| "candidate-unreadable")?;
    let mut bytes = Vec::new();
    if BufReader::new(file)
        .take(16 * 1024 + 1)
        .read_until(b'\n', &mut bytes)
        .is_err()
        || bytes.len() > 16 * 1024
        || bytes.last() != Some(&b'\n')
    {
        return Err("incomplete-header");
    }
    let init: Value = serde_json::from_slice(&bytes).map_err(|_| "invalid-header")?;
    if init["type"] != "system"
        || init["subtype"] != "init"
        || !init["sessionId"].is_string()
        || !init["cwd"].is_string()
    {
        return Err("unknown-header");
    }
    Ok(init["sessionId"] == sid
        && init["cwd"]
            .as_str()
            .is_some_and(|p| path_key(p) == path_key(cwd)))
}
fn resolve(
    root: &Path,
    sid: &str,
    cwd: &str,
    start: Instant,
) -> Result<Option<PathBuf>, &'static str> {
    let slug = regex::Regex::new(r"[^\p{L}\p{N}]")
        .unwrap()
        .replace_all(cwd, "-")
        .into_owned();
    let direct = root.join(slug).join(format!("{sid}.jsonl"));
    if direct
        .parent()
        .is_some_and(|p| fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink()))
    {
        return Err("linked-project");
    }
    if verify(&direct, sid, cwd)? {
        return Ok(Some(direct));
    }
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return Ok(None),
    };
    let mut found = None;
    for (index, entry) in entries.enumerate() {
        if index >= MAX_DIRS || start.elapsed() > Duration::from_secs(3) {
            return Err("scan-limit");
        }
        let entry = entry.map_err(|_| "scan-incomplete")?;
        let kind = entry.file_type().map_err(|_| "scan-incomplete")?;
        if kind.is_symlink() {
            return Err("scan-incomplete");
        }
        if !kind.is_dir() {
            continue;
        }
        let candidate = entry.path().join(format!("{sid}.jsonl"));
        if verify(&candidate, sid, cwd)? {
            if found.is_some() {
                return Err("ambiguous-path");
            }
            found = Some(candidate);
        }
    }
    Ok(found)
}
fn user_text(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_owned());
    }
    let blocks = value.as_array()?;
    let mut text = String::new();
    for block in blocks {
        if block["type"] == "text" {
            text.push_str(block["text"].as_str()?);
        } else if !matches!(block["type"].as_str(), Some("image" | "tool_result")) {
            return None;
        }
    }
    Some(text)
}
fn read(root: &Path, sid: &str, cwd: &str) -> Result<Option<HistoryEvidence>, &'static str> {
    if sid.is_empty()
        || sid.len() > 128
        || !sid.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        || cwd.is_empty()
    {
        return Ok(None);
    }
    let start = Instant::now();
    let Some(path) = resolve(root, sid, cwd, start)? else {
        return Ok(None);
    };
    let file = File::open(&path).map_err(|_| "open-failed")?;
    let before = file.metadata().map_err(|_| "stat-failed")?;
    if before.len() > MAX_FILE {
        return Err("file-limit");
    }
    let mut reader = BufReader::new(file);
    let mut hash = Sha256::new();
    let mut total = 0;
    let mut users = Vec::new();
    let mut ordinal = 0;
    loop {
        if start.elapsed() > Duration::from_secs(5) {
            return Err("read-timeout");
        }
        let bytes = line(&mut reader)?;
        if bytes.is_empty() {
            break;
        }
        total += bytes.len() as u64;
        if total > MAX_FILE {
            return Err("file-limit");
        }
        hash.update(&bytes);
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| "invalid-jsonl")?;
        if !value["type"].is_string()
            || (value["message"]["role"] == "user" && value["type"] != "user")
        {
            return Err("unknown-record-shape");
        }
        if ordinal == 0
            && !(value["type"] == "system"
                && value["subtype"] == "init"
                && value["sessionId"] == sid
                && value["cwd"]
                    .as_str()
                    .is_some_and(|p| path_key(p) == path_key(cwd)))
        {
            return Err("identity-changed");
        }
        ordinal += 1;
        if value["type"] != "user" {
            continue;
        }
        if users.len() >= MAX_USERS {
            return Err("user-limit");
        }
        let content = &value["message"]["content"];
        let text = user_text(content).ok_or("unknown-user-content")?;
        let text_only = content.is_string()
            || content
                .as_array()
                .is_some_and(|blocks| blocks.iter().all(|b| b["type"] == "text"));
        users.push(UserEvidence {
            digest: format!("{:x}", Sha256::digest(text.as_bytes())),
            bytes: text.len(),
            compact: value["isCompactSummary"] == true && text_only && !text.is_empty(),
            source_id: value["uuid"]
                .as_str()
                .filter(|s| s.len() <= 256)
                .map(str::to_owned)
                .unwrap_or_else(|| format!("line-{ordinal}")),
        });
    }
    let after = fs::metadata(&path).map_err(|_| "stat-failed")?;
    if total != before.len()
        || before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
    {
        return Err("source-changed");
    }
    Ok(Some(HistoryEvidence {
        version: format!("{:x}", hash.finalize()),
        users,
    }))
}

#[tauri::command]
pub async fn agent_history_evidence(
    app: tauri::AppHandle,
    agent_id: String,
    session_id: String,
    cwd: String,
) -> Result<Option<HistoryEvidence>, String> {
    if agent_id != "codeagent" {
        return Ok(None);
    }
    let root = app
        .path()
        .home_dir()
        .map_err(|_| "home-unavailable")?
        .join(".cac")
        .join("projects");
    tauri::async_runtime::spawn_blocking(move || {
        read(&root, &session_id, &cwd).map_err(str::to_owned)
    })
    .await
    .map_err(|_| "reader-failed".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "aaw-history-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn log(&self, dir: &str, cwd: &str, tail: &str) -> PathBuf {
            let path = self.0.join(dir).join("session-1.jsonl");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let init = serde_json::json!({"type":"system", "subtype":"init", "sessionId":"session-1", "cwd":cwd});
            fs::write(&path, format!("{init}\n{tail}")).unwrap();
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn message(text: &str, compact: bool) -> String {
        format!(
            "{}\n",
            serde_json::json!({"type":"user","isCompactSummary":compact,"message":{"content":text}})
        )
    }
    #[test]
    fn unicode_slug_and_full_evidence_including_duplicate_real_users() {
        let f = Fixture::new();
        let cwd = "G:\\08-设计\\26.1";
        f.log(
            "G--08-设计-26-1",
            cwd,
            &(message("摘要", true) + &message("摘要", false)),
        );
        let e = read(&f.0, "session-1", cwd).unwrap().unwrap();
        assert_eq!(e.users.len(), 2);
        assert!(e.users[0].compact);
        assert!(!e.users[1].compact);
        assert_eq!(e.users[0].digest, e.users[1].digest);
        assert_eq!(e.users[0].bytes, 6);
        let wire = serde_json::to_string(&e).unwrap();
        assert!(!wire.contains("摘要"));
    }
    #[test]
    fn fallback_checks_cwd_and_requires_a_unique_path() {
        let f = Fixture::new();
        f.log("old-slug", "D:\\Repo", &message("summary", true));
        assert!(read(&f.0, "session-1", "d:/repo/").unwrap().is_some());
        assert!(read(&f.0, "session-1", "D:/other").unwrap().is_none());
        f.log("duplicate", "D:\\Repo", &message("summary", true));
        assert_eq!(
            read(&f.0, "session-1", "d:/repo/").err(),
            Some("ambiguous-path")
        );
    }
    #[test]
    fn partial_or_corrupt_jsonl_is_not_partial_evidence() {
        let f = Fixture::new();
        f.log(
            "D--repo",
            "D:/repo",
            &(message("summary", true) + "{\"type\":\"user\""),
        );
        assert_eq!(
            read(&f.0, "session-1", "D:/repo").err(),
            Some("incomplete-line")
        );
        f.log(
            "D--repo",
            "D:/repo",
            &(message("summary", true) + "not-json\n"),
        );
        assert_eq!(
            read(&f.0, "session-1", "D:/repo").err(),
            Some("invalid-jsonl")
        );
    }
    #[test]
    fn large_tool_result_preserves_complete_summary_evidence() {
        let f = Fixture::new();
        let tool = serde_json::json!({"type":"assistant", "payload":"x".repeat(2_638_388)});
        let tail = format!("{tool}\n{}", message("summary", true));
        let path = f.log("D--repo", "D:/repo", &tail);
        let evidence = read(&f.0, "session-1", "D:/repo").unwrap().unwrap();
        assert_eq!(evidence.users.len(), 1);
        assert!(evidence.users[0].compact);
        assert_eq!(evidence.version, format!("{:x}", Sha256::digest(fs::read(path).unwrap())));
    }
    #[test]
    fn oversized_files_and_lines_fail_before_allocating_entire_file() {
        let f = Fixture::new();
        let p = f.log("D--repo", "D:/repo", "");
        File::options()
            .write(true)
            .open(&p)
            .unwrap()
            .set_len(MAX_FILE + 1)
            .unwrap();
        assert_eq!(read(&f.0, "session-1", "D:/repo").err(), Some("file-limit"));
        f.log(
            "D--repo",
            "D:/repo",
            &message(&"x".repeat(MAX_LINE as usize), true),
        );
        assert_eq!(read(&f.0, "session-1", "D:/repo").err(), Some("line-limit"));
    }
    #[test]
    fn unknown_user_content_disables_evidence_and_attachments_are_not_compactions() {
        let f = Fixture::new();
        f.log("D--repo", "D:/repo", "{\"type\":\"user\",\"isCompactSummary\":true,\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"summary\"},{\"type\":\"image\"}]}}\n");
        assert!(!read(&f.0, "session-1", "D:/repo").unwrap().unwrap().users[0].compact);
        f.log(
            "D--repo",
            "D:/repo",
            "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"unknown\"}]}}\n",
        );
        assert_eq!(
            read(&f.0, "session-1", "D:/repo").err(),
            Some("unknown-user-content")
        );
    }
    #[test]
    fn changed_file_changes_evidence_version_and_source_is_never_modified() {
        let f = Fixture::new();
        let p = f.log("D--repo", "D:/repo", &message("first", true));
        let before = fs::read(&p).unwrap();
        let a = read(&f.0, "session-1", "D:/repo").unwrap().unwrap();
        assert_eq!(fs::read(&p).unwrap(), before);
        f.log(
            "D--repo",
            "D:/repo",
            &(message("first", true) + &message("second", false)),
        );
        let b = read(&f.0, "session-1", "D:/repo").unwrap().unwrap();
        assert_ne!(a.version, b.version);
    }
    #[test]
    fn scan_limit_and_invalid_ids_never_resolve() {
        let f = Fixture::new();
        for i in 0..=MAX_DIRS {
            fs::create_dir(f.0.join(format!("project-{i}"))).unwrap();
        }
        assert_eq!(read(&f.0, "session-1", "D:/repo").err(), Some("scan-limit"));
        assert!(read(&f.0, "../session-1", "D:/repo").unwrap().is_none());
    }

    #[test]
    fn path_identity_matches_shared_normalization() {
        assert_eq!(path_key("D:\\repo\\.\\child\\..\\"), "d:/repo");
        assert_eq!(path_key("D:\\"), "d:/");
        assert_eq!(path_key("\\\\SERVER\\Share\\"), "//server/share");
        assert_eq!(path_key("/Users/A/./repo/"), "/Users/A/repo");
        assert_ne!(path_key("/Users/A/repo"), path_key("/users/a/repo"));
    }

    #[test]
    fn unreadable_candidate_and_unknown_user_shape_never_prove_uniqueness() {
        let f = Fixture::new();
        f.log("old-slug", "D:/repo", &message("summary", true));
        let corrupt = f.log("other-slug", "D:/repo", "");
        fs::write(corrupt, "{invalid header}\n").unwrap();
        assert_eq!(
            read(&f.0, "session-1", "D:/repo").err(),
            Some("invalid-header")
        );
        f.log("D--repo", "D:/repo", "{\"type\":\"new-user-type\",\"message\":{\"role\":\"user\",\"content\":\"summary\"}}\n");
        assert_eq!(
            read(&f.0, "session-1", "D:/repo").err(),
            Some("unknown-record-shape")
        );
    }
}
