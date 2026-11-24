use crate::codeagent_history::{self, path_key};
use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::BufReader,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant, UNIX_EPOCH},
};
use tauri::Manager;

static DELETION: Mutex<()> = Mutex::new(());

#[derive(Clone, Deserialize, Serialize)]
struct Plan {
    cwd: String,
    session_id: String,
    project: Option<String>,
    directory_created: Option<u128>,
    transcript_revision: Option<String>,
}

fn metadata(path: &Path) -> Result<Option<fs::Metadata>, String> {
    match fs::symlink_metadata(path) {
        Ok(value) => {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if value.file_attributes() & 0x400 != 0 {
                    return Err("拒绝删除目录联接或重解析点".into());
                }
            }
            if value.file_type().is_symlink() {
                return Err("拒绝删除符号链接".into());
            }
            Ok(Some(value))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

// 检查子项期间禁止 Windows 目录被重命名或替换。
fn directory_guard(path: &Path) -> Result<File, String> {
    let meta = metadata(path)?.ok_or("会话目录已变化")?;
    if !meta.is_dir() {
        return Err("会话目录类型不匹配".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options
            .custom_flags(0x0200_0000 | 0x0020_0000)
            .share_mode(3);
    }
    let guard = options.open(path).map_err(|e| e.to_string())?;
    // 句柄取得前目录可能变化；持锁后再次检查，避免跟随新换入的重解析点。
    if !metadata(path)?.ok_or("会话目录已变化")?.is_dir() {
        return Err("会话目录类型不匹配".into());
    }
    Ok(guard)
}

fn created(meta: &fs::Metadata) -> Result<u128, String> {
    meta.created()
        .map_err(|e| e.to_string())?
        .duration_since(UNIX_EPOCH)
        .map(|t| t.as_nanos())
        .map_err(|e| e.to_string())
}

fn verify(path: &Path, sid: &str, cwd: &str) -> Result<bool, String> {
    if let Some(meta) = metadata(path)? {
        if !meta.is_file() {
            return Err("会话历史不是普通文件".into());
        }
    }
    let result = match codeagent_history::verify(path, sid, cwd) {
        Err("unknown-header" | "incomplete-header")
            if path
                .parent()
                .and_then(Path::file_name)
                .and_then(|p| p.to_str())
                == Some(codeagent_history::project_slug(cwd).as_str()) =>
        {
            verify_without_init(path, sid, cwd)
        }
        result => result,
    };
    result.map_err(|reason| format!("会话历史无法核验：{reason}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryIdentity {
    #[serde(rename = "type")]
    kind: String,
    subtype: Option<String>,
    #[serde(default, deserialize_with = "present_string")]
    session_id: Option<String>,
    #[serde(default, deserialize_with = "present_string")]
    cwd: Option<String>,
}

fn present_string<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

fn verify_without_init(path: &Path, sid: &str, cwd: &str) -> Result<bool, &'static str> {
    let start = Instant::now();
    let before = revision(path).map_err(|_| "stat-failed")?;
    let file = File::open(path).map_err(|_| "candidate-unreadable")?;
    if file.metadata().map_err(|_| "stat-failed")?.len() > codeagent_history::MAX_FILE {
        return Err("file-limit");
    }
    let mut reader = BufReader::new(file);
    let mut total = 0;
    let mut has_session_evidence = false;
    let cwd_key = path_key(cwd);
    loop {
        if start.elapsed() > Duration::from_secs(5) {
            return Err("read-timeout");
        }
        let bytes = codeagent_history::line(&mut reader)?;
        if bytes.is_empty() {
            break;
        }
        let is_first = total == 0;
        total += bytes.len() as u64;
        if total > codeagent_history::MAX_FILE {
            return Err("file-limit");
        }
        if bytes.trim_ascii_start().first() != Some(&b'{') {
            return Err("invalid-jsonl");
        }
        let record: HistoryIdentity =
            serde_json::from_slice(&bytes).map_err(|_| "invalid-jsonl")?;
        // 首行声明为 init 时必须通过原有严格核验。
        if is_first && record.kind == "system" && record.subtype.as_deref() == Some("init") {
            return Err("invalid-init");
        }
        let session_id = record.session_id.as_deref();
        if session_id.is_some_and(|value| value != sid)
            || record
                .cwd
                .as_deref()
                .is_some_and(|value| path_key(value) != cwd_key)
        {
            return Ok(false);
        }
        if matches!(
            record.kind.as_str(),
            "user" | "last-prompt" | "queue-operation"
        ) && session_id == Some(sid)
        {
            has_session_evidence = true;
        }
    }
    if revision(path).map_err(|_| "stat-failed")? != before {
        return Err("source-changed");
    }
    if !has_session_evidence {
        return Err("missing-session-id");
    }
    Ok(true)
}

fn revision(path: &Path) -> Result<String, String> {
    revision_of(&metadata(path)?.ok_or("会话文件已变化")?)
}

fn revision_of(meta: &fs::Metadata) -> Result<String, String> {
    Ok(format!(
        "{}:{}:{}",
        created(meta)?,
        meta.len(),
        meta.modified()
            .map_err(|e| e.to_string())?
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
    ))
}

fn locate(root: &Path, sid: &str, cwd: &str, exclude: Option<&str>) -> Result<Plan, String> {
    let mut result = Plan {
        cwd: cwd.into(),
        session_id: sid.into(),
        project: None,
        directory_created: None,
        transcript_revision: None,
    };
    let Some(_) = metadata(root)? else {
        return Ok(result);
    };
    let _guard = directory_guard(root)?;
    let start = Instant::now();
    for (index, entry) in fs::read_dir(root).map_err(|e| e.to_string())?.enumerate() {
        if index >= 4096 || start.elapsed() > Duration::from_secs(10) {
            return Err("会话目录扫描未完成，请稍后重试".into());
        }
        let entry = entry.map_err(|e| e.to_string())?;
        if exclude.is_some_and(|name| entry.file_name() == name) {
            continue;
        }
        let Some(meta) = metadata(&entry.path())? else {
            continue;
        };
        if !meta.is_dir() {
            continue;
        }
        let _project = directory_guard(&entry.path())?;
        let transcript = entry.path().join(format!("{sid}.jsonl"));
        let sidecar = entry.path().join(sid);
        let existing = metadata(&transcript)?;
        if let Some(meta) = existing {
            let before = revision_of(&meta)?;
            if !verify(&transcript, sid, cwd)? {
                return Err("同一会话 ID 对应其他项目或历史格式无法核验".into());
            }
            if revision(&transcript)? != before {
                return Err("会话文件身份已变化".into());
            }
            if result.project.is_some() {
                return Err("找到多份同一会话，无法确定删除目标".into());
            }
            result.project = Some(
                entry
                    .file_name()
                    .into_string()
                    .map_err(|_| "项目目录名无效")?,
            );
            result.transcript_revision = Some(before);
            result.directory_created = metadata(&sidecar)?.as_ref().map(created).transpose()?;
        } else if metadata(&sidecar)?.is_some() {
            // 历史文件已不存在时，只能依据先前核验过的删除记录处理附属目录。
            return Err("存在无法核验归属的会话附属目录".into());
        }
    }
    Ok(result)
}

fn remove_tree(path: &Path, depth: usize, count: &mut usize) -> Result<(), String> {
    if depth > 64 || *count >= 100_000 {
        return Err("附属文件超过删除上限".into());
    }
    let Some(meta) = metadata(path)? else {
        return Ok(());
    };
    *count += 1;
    if meta.is_dir() {
        let guard = directory_guard(path)?;
        for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
            remove_tree(&entry.map_err(|e| e.to_string())?.path(), depth + 1, count)?;
        }
        drop(guard);
        fs::remove_dir(path).map_err(|e| e.to_string())
    } else if meta.is_file() {
        remove_file(path, None)
    } else {
        Err("会话目录包含不支持的文件类型".into())
    }
}

fn remove_file(path: &Path, expected_revision: Option<&str>) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000).share_mode(4);
    }
    let guard = options
        .open(path)
        .map_err(|e| format!("文件仍被占用或无法访问：{e}"))?;
    let meta = metadata(path)?.ok_or("待删除文件已变化")?;
    if !meta.is_file() {
        return Err("待删除文件不是普通文件".into());
    }
    if let Some(expected) = expected_revision {
        if revision_of(&meta)? != expected
            || revision_of(&guard.metadata().map_err(|e| e.to_string())?)? != expected
        {
            return Err("会话文件身份已变化".into());
        }
    }
    fs::remove_file(path).map_err(|e| e.to_string())
}

#[cfg(windows)]
fn process_running(pid: u32, registry_time: Option<std::time::SystemTime>) -> Result<bool, String> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, FILETIME, GetLastError},
        System::Threading::{
            GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        },
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return if GetLastError() == 87 {
                Ok(false)
            } else {
                Err("无法核验外部会话进程".into())
            };
        }
        let mut exit = 0;
        let ok = GetExitCodeProcess(handle, &mut exit);
        let mut birth: FILETIME = std::mem::zeroed();
        let mut ended: FILETIME = std::mem::zeroed();
        let mut kernel: FILETIME = std::mem::zeroed();
        let mut user: FILETIME = std::mem::zeroed();
        let times = GetProcessTimes(handle, &mut birth, &mut ended, &mut kernel, &mut user);
        CloseHandle(handle);
        if ok == 0 || times == 0 {
            return Err("无法核验外部会话进程".into());
        }
        if let Some(recorded) = registry_time {
            let ticks = (u64::from(birth.dwHighDateTime) << 32) | u64::from(birth.dwLowDateTime);
            if let Some(unix_ticks) = ticks.checked_sub(116_444_736_000_000_000) {
                let started = UNIX_EPOCH
                    + Duration::from_secs(unix_ticks / 10_000_000)
                    + Duration::from_nanos((unix_ticks % 10_000_000) * 100);
                // 进程启动晚于注册记录，说明该 PID 已被其他进程复用。
                if started > recorded {
                    return Ok(false);
                }
            }
        }
        Ok(exit == 259)
    }
}

fn check_external(home: &Path, sid: &str) -> Result<(), String> {
    let registry = home.join(".cac/sessions");
    let Some(_) = metadata(&registry)? else {
        return Ok(());
    };
    let _guard = directory_guard(&registry)?;
    for (index, entry) in fs::read_dir(registry)
        .map_err(|e| e.to_string())?
        .enumerate()
    {
        if index >= 4096 {
            return Err("活跃会话检查超过上限".into());
        }
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().extension().and_then(|v| v.to_str()) != Some("json") {
            continue;
        }
        let Some(meta) = metadata(&entry.path())? else {
            continue;
        };
        if !meta.is_file() || meta.len() > 64 * 1024 {
            return Err("活跃会话记录无法核验".into());
        }
        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(entry.path()).map_err(|e| e.to_string())?)
                .map_err(|_| "活跃会话记录损坏")?;
        if value["sessionId"] != sid {
            continue;
        }
        let pid = value["pid"]
            .as_u64()
            .and_then(|p| u32::try_from(p).ok())
            .ok_or("外部会话 PID 无效")?;
        #[cfg(windows)]
        if process_running(pid, meta.modified().ok())? {
            return Err("CodeAgent 正在其他窗口使用此会话，请关闭后重试".into());
        }
        #[cfg(not(windows))]
        {
            let _ = pid;
            return Err("无法核验外部会话，请关闭 CodeAgent 后重试".into());
        }
    }
    Ok(())
}

fn save_plan(path: &Path, plan: &Plan) -> Result<(), String> {
    use std::io::Write;
    let temporary = path.with_extension("tmp");
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&temporary)
        .map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec(plan).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(temporary, path).map_err(|e| e.to_string())
}

fn delete(home: &Path, journal: &Path, sid: &str, cwd: &str) -> Result<(), String> {
    if sid.is_empty()
        || sid.len() > 128
        || !sid.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        || cwd.is_empty()
    {
        return Err("删除目标标识无效".into());
    }
    let _guard = DELETION.lock().map_err(|e| e.to_string())?;
    let cac = home.join(".cac");
    let root = cac.join("projects");
    // 删除期间始终防止祖先目录被替换。
    let _home = directory_guard(home)?;
    let _cac = metadata(&cac)?.map(|_| directory_guard(&cac)).transpose()?;
    let _root = metadata(&root)?
        .map(|_| directory_guard(&root))
        .transpose()?;
    fs::create_dir_all(journal).map_err(|e| e.to_string())?;
    let key = format!(
        "{:x}.json",
        Sha256::digest(format!("{}\0{sid}", path_key(cwd)).as_bytes())
    );
    let journal_path = journal.join(key);
    let mut lock_options = OpenOptions::new();
    lock_options
        .read(true)
        .write(true)
        .create(true)
        .truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        lock_options.share_mode(0);
    }
    let _lock = lock_options
        .open(journal_path.with_extension("lock"))
        .map_err(|_| "其他窗口正在删除此会话，请稍后重试")?;
    let saved = metadata(&journal_path)?
        .map(|_| {
            serde_json::from_slice::<Plan>(&fs::read(&journal_path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())
        })
        .transpose()?;
    if saved
        .as_ref()
        .is_some_and(|plan| plan.session_id != sid || path_key(&plan.cwd) != path_key(cwd))
    {
        return Err("删除记录身份不匹配".into());
    }
    check_external(home, sid)?;
    let plan = match saved {
        Some(plan) if plan.project.is_some() => plan,
        _ => {
            let plan = locate(&root, sid, cwd, None)?;
            if plan.project.is_none() {
                return Err("未找到可验证的 CodeAgent 历史".into());
            }
            save_plan(&journal_path, &plan)?;
            plan
        }
    };
    let (Some(project), Some(expected_revision)) = (plan.project, plan.transcript_revision) else {
        return Err("删除记录缺少文件身份".into());
    };
    if !matches!(
        Path::new(&project).components().next(),
        Some(std::path::Component::Normal(_))
    ) || Path::new(&project).components().count() != 1
        || project == "."
        || project == ".."
        || project.contains(['/', '\\'])
    {
        return Err("删除记录中的项目目录无效".into());
    }
    // 重新扫描其他项目，识别在首次定位之后或重试时出现的同 ID 文件。
    if locate(&root, sid, cwd, Some(&project))?.project.is_some() {
        return Err("找到多份同一会话，无法确定删除目标".into());
    }
    let project_path = root.join(project);
    let Some(_) = metadata(&project_path)? else {
        return Ok(());
    };
    let _project = directory_guard(&project_path)?;
    let transcript = project_path.join(format!("{sid}.jsonl"));
    let sidecar = project_path.join(sid);
    let history = if metadata(&transcript)?.is_some() {
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // 核验与清理附属文件期间，禁止其他句柄写入或替换历史。
            options.custom_flags(0x0020_0000).share_mode(1);
        }
        let file = options
            .open(&transcript)
            .map_err(|e| format!("会话历史仍被占用：{e}"))?;
        if revision_of(&file.metadata().map_err(|e| e.to_string())?)? != expected_revision
            || revision(&transcript)? != expected_revision
        {
            return Err("会话历史已被修改，请核验后再删除".into());
        }
        if !verify(&transcript, sid, cwd)? || revision(&transcript)? != expected_revision {
            return Err("会话文件身份已变化".into());
        }
        Some(file)
    } else {
        None
    };
    check_external(home, sid)?;
    if let Some(meta) = metadata(&sidecar)? {
        if !meta.is_dir() || Some(created(&meta)?) != plan.directory_created {
            return Err("附属目录身份已变化".into());
        }
        remove_tree(&sidecar, 0, &mut 0)?;
    }
    if let Some(history) = history {
        // 删除需先关闭禁止重命名的句柄，最后在删除句柄持有期间复核版本。
        drop(history);
        remove_file(&transcript, Some(&expected_revision))?;
    }
    if metadata(&transcript)?.is_some() || metadata(&sidecar)?.is_some() {
        return Err("会话仍有残留数据".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn agent_delete_session(
    app: tauri::AppHandle,
    agent_id: String,
    session_id: String,
    cwd: String,
) -> Result<(), String> {
    if agent_id != "codeagent" {
        return Err("此 Agent 不支持彻底删除会话".into());
    }
    #[cfg(feature = "migration-smoke")]
    let home = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("fixture-home");
    #[cfg(not(feature = "migration-smoke"))]
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let journal = crate::storage_location::data_dir(&app)?.join("session-deletions");
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let result = delete(&home, &journal, &session_id, &cwd);
        crate::diagnostics::log(
            if result.is_ok() { "info" } else { "warn" },
            "session-delete",
            "CodeAgent 文件删除结束",
            serde_json::json!({
                "succeeded": result.is_ok(),
                "durationMs": started.elapsed().as_millis(),
            }),
        );
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "aaw-delete-{}",
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let project = root.join(".cac/projects/old-unicode-目录");
        fs::create_dir_all(project.join("session-1/model-io")).unwrap();
        fs::write(project.join("session-1/model-io/data"), "private").unwrap();
        fs::write(project.join("session-1.jsonl"), "{\"type\":\"system\",\"subtype\":\"init\",\"sessionId\":\"session-1\",\"cwd\":\"D:/Repo\"}\n").unwrap();
        (root, project)
    }

    fn fixture_without_init(history: &str) -> (PathBuf, PathBuf) {
        let (home, project) = fixture();
        let slug = project.with_file_name("D--Repo");
        fs::rename(project, &slug).unwrap();
        fs::write(slug.join("session-1.jsonl"), history).unwrap();
        (home, slug)
    }

    #[test]
    fn deletes_history_without_init_or_cwd_and_retries_successfully() {
        let history = concat!(
            "{\"type\":\"queue-operation\",\"sessionId\":\"session-1\"}\n",
            "{\"type\":\"user\",\"sessionId\":\"session-1\",\"message\":{\"sessionId\":\"nested-value\"}}\n",
            "{\"type\":\"last-prompt\",\"sessionId\":\"session-1\"}\n",
            "{\"type\":\"assistant\"}\n",
        );
        let (home, project) = fixture_without_init(history);
        for _ in 0..2 {
            delete(&home, &home.join("journal"), "session-1", "D:/Repo").unwrap();
            assert!(!project.join("session-1.jsonl").exists());
            assert!(!project.join("session-1").exists());
        }
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn rejects_unverified_history_without_removing_transcript_or_sidecar() {
        let cases = [
            ("无会话 ID", "{\"type\":\"user\"}\n"),
            (
                "未知记录的 ID",
                "{\"type\":\"unknown\",\"sessionId\":\"session-1\"}\n",
            ),
            (
                "ID 冲突",
                "{\"type\":\"user\",\"sessionId\":\"session-1\"}\n{\"type\":\"assistant\",\"sessionId\":\"other\"}\n",
            ),
            (
                "重复 ID 字段",
                "{\"type\":\"user\",\"sessionId\":\"other\",\"sessionId\":\"session-1\"}\n",
            ),
            (
                "工作区冲突",
                "{\"type\":\"user\",\"sessionId\":\"session-1\",\"cwd\":\"D:/Other\"}\n",
            ),
            (
                "损坏记录",
                "{\"type\":\"user\",\"sessionId\":\"session-1\"}\ninvalid\n",
            ),
            (
                "截断记录",
                "{\"type\":\"user\",\"sessionId\":\"session-1\"}\n{\"type\":",
            ),
            (
                "无效 init",
                "{\"type\":\"system\",\"subtype\":\"init\",\"sessionId\":\"session-1\"}\n{\"type\":\"user\",\"sessionId\":\"session-1\"}\n",
            ),
            (
                "目录不匹配",
                "{\"type\":\"user\",\"sessionId\":\"session-1\"}\n",
            ),
        ];
        for (case, history) in cases {
            let (home, project) = fixture_without_init(history);
            let cwd = if case == "目录不匹配" {
                "D:/Other"
            } else {
                "D:/Repo"
            };
            assert!(
                delete(&home, &home.join("journal"), "session-1", cwd,).is_err(),
                "{case}",
            );
            assert_eq!(
                fs::read_to_string(project.join("session-1.jsonl")).unwrap(),
                history
            );
            assert!(project.join("session-1/model-io/data").exists());
            fs::remove_dir_all(home).unwrap();
        }
    }

    #[test]
    fn refuses_duplicate_or_changed_history_without_init() {
        let history =
            "{\"type\":\"last-prompt\",\"sessionId\":\"session-1\",\"cwd\":\"d:\\\\repo\"}\n";
        let (home, project) = fixture_without_init(history);
        let root = home.join(".cac/projects");
        let journal = home.join("journal");
        let transcript = project.join("session-1.jsonl");
        let other = root.join("other-project");
        fs::create_dir(&other).unwrap();
        let duplicate = other.join("session-1.jsonl");
        fs::write(&duplicate, "{\"type\":\"system\",\"subtype\":\"init\",\"sessionId\":\"session-1\",\"cwd\":\"D:/Repo\"}\n").unwrap();
        assert!(delete(&home, &journal, "session-1", "D:/Repo",).is_err());
        assert!(transcript.exists());
        assert!(duplicate.exists());
        fs::remove_file(duplicate).unwrap();

        let plan = locate(&root, "session-1", "D:/Repo", None).unwrap();
        let key = format!("{:x}.json", Sha256::digest(b"d:/repo\0session-1"));
        save_plan(&journal.join(key), &plan).unwrap();
        fs::write(
            &transcript,
            format!("{history}{{\"type\":\"assistant\"}}\n"),
        )
        .unwrap();
        let error = delete(&home, &journal, "session-1", "D:/Repo").unwrap_err();
        assert!(error.contains("修改"), "{error}");
        assert!(transcript.exists());
        assert!(project.join("session-1/model-io/data").exists());
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn directly_deletes_and_retry_is_idempotent() {
        let (home, project) = fixture();
        let journal = home.join("journal");
        delete(&home, &journal, "session-1", "d:\\repo").unwrap();
        assert!(!project.join("session-1.jsonl").exists());
        assert!(!project.join("session-1").exists());
        delete(&home, &journal, "session-1", "D:/Repo").unwrap();
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn missing_history_cannot_create_or_reuse_an_unverified_plan() {
        let (home, project) = fixture();
        let root = home.join(".cac/projects");
        let journal = home.join("journal");
        let key = format!("{:x}.json", Sha256::digest(b"d:/repo\0session-1"));
        let journal_path = journal.join(key);
        fs::remove_file(project.join("session-1.jsonl")).unwrap();
        fs::remove_dir_all(project.join("session-1")).unwrap();

        let delete_session = || delete(&home, &journal, "session-1", "D:/Repo");
        assert!(delete_session().unwrap_err().contains("未找到可验证"));
        assert!(!journal_path.exists());

        let empty = locate(&root, "session-1", "D:/Repo", None).unwrap();
        save_plan(&journal_path, &empty).unwrap();
        assert!(delete_session().unwrap_err().contains("未找到可验证"));
        fs::write(project.join("session-1.jsonl"), "{\"type\":\"system\",\"subtype\":\"init\",\"sessionId\":\"session-1\",\"cwd\":\"D:/Repo\"}\n").unwrap();
        delete_session().unwrap();
        delete_session().unwrap();
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn retry_checks_other_projects_even_when_the_planned_history_disappeared() {
        let (home, project) = fixture();
        let root = home.join(".cac/projects");
        let journal = home.join("journal");
        fs::create_dir_all(&journal).unwrap();
        let key = format!("{:x}.json", Sha256::digest(b"d:/repo\0session-1"));
        let plan = locate(&root, "session-1", "D:/Repo", None).unwrap();
        save_plan(&journal.join(key), &plan).unwrap();
        let other = root.join("new-project");
        fs::create_dir(&other).unwrap();
        fs::rename(
            project.join("session-1.jsonl"),
            other.join("session-1.jsonl"),
        )
        .unwrap();
        assert!(
            delete(&home, &journal, "session-1", "D:/Repo")
                .unwrap_err()
                .contains("多份")
        );
        assert!(other.join("session-1.jsonl").exists());
        assert!(project.join("session-1/model-io/data").exists());
        fs::remove_dir_all(home).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn keeps_sidecars_while_the_history_is_open_for_writing() {
        let (home, project) = fixture();
        let transcript = project.join("session-1.jsonl");
        let writer = OpenOptions::new().write(true).open(&transcript).unwrap();
        let delete_session = || delete(&home, &home.join("journal"), "session-1", "D:/Repo");
        assert!(delete_session().unwrap_err().contains("占用"));
        assert!(project.join("session-1/model-io/data").exists());
        drop(writer);
        delete_session().unwrap();
        fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn refuses_ambiguity_and_traversal() {
        let (home, project) = fixture();
        let other = home.join(".cac/projects/duplicate");
        fs::create_dir_all(&other).unwrap();
        fs::copy(
            project.join("session-1.jsonl"),
            other.join("session-1.jsonl"),
        )
        .unwrap();
        assert!(delete(&home, &home.join("journal"), "session-1", "D:/Repo",).is_err());
        assert!(delete(&home, &home.join("journal"), "../session-1", "D:/Repo",).is_err());
        assert!(project.join("session-1.jsonl").exists());
        fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn refuses_a_changed_source_and_resumes_a_partial_sidecar_cleanup() {
        let (home, project) = fixture();
        let root = home.join(".cac/projects");
        let journal = home.join("journal");
        fs::create_dir_all(&journal).unwrap();
        let plan = locate(&root, "session-1", "D:/Repo", None).unwrap();
        let key = format!("{:x}.json", Sha256::digest(b"d:/repo\0session-1"));
        save_plan(&journal.join(key), &plan).unwrap();
        use std::io::Write;
        OpenOptions::new()
            .append(true)
            .open(project.join("session-1.jsonl"))
            .unwrap()
            .write_all(b"changed\n")
            .unwrap();
        assert!(
            delete(&home, &journal, "session-1", "D:/Repo",)
                .unwrap_err()
                .contains("修改")
        );
        assert!(project.join("session-1/model-io/data").exists());
        fs::remove_dir_all(home).unwrap();

        let (home, project) = fixture();
        let journal = home.join("journal");
        fs::create_dir_all(&journal).unwrap();
        let plan = locate(&home.join(".cac/projects"), "session-1", "D:/Repo", None).unwrap();
        let key = format!("{:x}.json", Sha256::digest(b"d:/repo\0session-1"));
        save_plan(&journal.join(key), &plan).unwrap();
        fs::remove_file(project.join("session-1.jsonl")).unwrap();
        delete(&home, &journal, "session-1", "D:/Repo").unwrap();
        assert!(!project.join("session-1").exists());
        fs::remove_dir_all(home).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn refuses_reparse_directories_and_a_live_external_session() {
        let (home, project) = fixture();
        let outside = home.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("keep"), "keep").unwrap();
        // 创建目录联接不需要开发者模式。
        use std::os::windows::process::CommandExt;
        let junction = project.join("session-1/link");
        let link_script = home.join("junction.ps1");
        fs::write(&link_script, "param($LinkPath, $TargetPath)\nNew-Item -ItemType Junction -Path $LinkPath -Target $TargetPath -ErrorAction Stop | Out-Null").unwrap();
        let output = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(&link_script)
            .arg(&junction)
            .arg(&outside)
            .creation_flags(0x0800_0000)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(delete(&home, &home.join("journal"), "session-1", "D:/Repo",).is_err());
        assert!(outside.join("keep").exists());
        fs::remove_dir(junction).unwrap();
        let registry = home.join(".cac/sessions");
        fs::create_dir_all(&registry).unwrap();
        fs::write(
            registry.join("live.json"),
            serde_json::json!({
                "sessionId":"session-1","pid":std::process::id()
            })
            .to_string(),
        )
        .unwrap();
        assert!(
            delete(&home, &home.join("journal"), "session-1", "D:/Repo",)
                .unwrap_err()
                .contains("其他窗口")
        );
        assert!(project.join("session-1.jsonl").exists());
        File::options()
            .write(true)
            .open(registry.join("live.json"))
            .unwrap()
            .set_modified(UNIX_EPOCH)
            .unwrap();
        check_external(&home, "session-1").unwrap();
        fs::remove_dir_all(home).unwrap();
    }
}
