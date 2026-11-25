use super::*;
use crate::codeagent_history::{MAX_FILE, line, resolve};
use serde_json::Value;
use std::time::SystemTime;

// Only offsets and identities survive a read. File contents are fetched for the selected turn.
#[derive(Default)]
struct Stream {
    offset: u64,
    created: Option<SystemTime>,
    modified: Option<SystemTime>,
    parents: BTreeMap<String, String>,
    calls: BTreeMap<String, String>,
    ambiguous: BTreeSet<String>,
    results: BTreeMap<String, u64>,
    edits: BTreeMap<String, Vec<(String, u64)>>,
}

impl Stream {
    fn index(&mut self, reader: &mut BufReader<File>, side: bool) -> Result<(), String> {
        let meta = reader.get_ref().metadata().map_err(|e| e.to_string())?;
        let created = meta.created().ok();
        let modified = meta.modified().ok();
        if self.created != created
            || meta.len() < self.offset
            || (meta.len() == self.offset && self.modified != modified)
        {
            *self = Self::default();
        }
        self.created = created;
        self.modified = modified;
        reader
            .seek(SeekFrom::Start(self.offset))
            .map_err(|e| e.to_string())?;
        let end = meta.len();
        while self.offset < end {
            let bytes = match line(reader) {
                Ok(bytes) if bytes.is_empty() => break,
                Ok(bytes) => bytes,
                Err("incomplete-line") => break,
                Err(err) => return Err(err.into()),
            };
            let row: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            let pos = self.offset;
            self.offset += bytes.len() as u64;
            let summary = row["isCompactSummary"] == true;
            let prompt =
                if !summary && row["type"] == "user" && (row["isUserPrompt"] == true || side) {
                    row["promptId"].as_str()
                } else {
                    None
                }
                .or_else(|| {
                    self.parents
                        .get(row["parentUuid"].as_str()?)
                        .map(String::as_str)
                })
                .map(str::to_owned);
            if let (Some(uuid), Some(prompt)) = (row["uuid"].as_str(), prompt.as_ref()) {
                self.parents.insert(uuid.into(), prompt.clone());
            }
            if summary || (!side && row["isSidechain"] == true) {
                continue;
            }
            for block in row["message"]["content"].as_array().into_iter().flatten() {
                if block["type"] == "tool_use" && row["type"] == "assistant" {
                    if let (Some(id), Some(prompt)) = (block["id"].as_str(), prompt.as_ref()) {
                        if self.calls.insert(id.into(), prompt.clone()).is_some() {
                            self.ambiguous.insert(id.into());
                        }
                        if matches!(block["name"].as_str(), Some("Edit" | "Write")) {
                            self.edits
                                .entry(prompt.clone())
                                .or_default()
                                .push((id.into(), pos));
                        }
                    }
                } else if block["type"] == "tool_result"
                    && row["type"] == "user"
                    && block["is_error"] != true
                {
                    if let Some(id) = block["tool_use_id"].as_str() {
                        self.results.insert(id.into(), pos);
                    }
                }
            }
        }
        Ok(())
    }
}

fn row_at(reader: &mut BufReader<File>, pos: u64) -> Result<Value, String> {
    reader
        .seek(SeekFrom::Start(pos))
        .map_err(|e| e.to_string())?;
    serde_json::from_slice(&line(reader)?).map_err(|e| e.to_string())
}

struct Edit {
    old: Option<String>,
    new: String,
    whole: bool,
}

fn edit(block: &Value, result: &Value) -> Option<Edit> {
    let input = &block["input"];
    let details = &result["toolUseResult"];
    match block["name"].as_str()? {
        "Write" => {
            let old = details["originalFile"].as_str().map(str::to_owned);
            let whole = old.is_some() || details["type"] == "create";
            Some(Edit {
                old,
                new: input["content"].as_str()?.into(),
                whole,
            })
        }
        "Edit" => {
            let old = input["old_string"].as_str()?;
            let new = input["new_string"].as_str()?;
            if let Some(original) = details["originalFile"].as_str() {
                if !old.is_empty()
                    && (original.matches(old).count() == 1
                        || (input["replace_all"] == true && original.contains(old)))
                {
                    return Some(Edit {
                        old: Some(original.into()),
                        new: original.replace(old, new),
                        whole: true,
                    });
                }
            }
            Some(Edit {
                old: Some(old.into()),
                new: new.into(),
                whole: false,
            })
        }
        _ => None,
    }
}

type Streams = BTreeMap<PathBuf, Stream>;
type Index = Arc<Mutex<Streams>>;
static INDEXES: OnceLock<Mutex<BTreeMap<PathBuf, Index>>> = OnceLock::new();

fn collect(
    main: &Path,
    root: &Path,
    ids: &[String],
    streams: &mut Streams,
) -> Result<BTreeMap<String, Vec<Edit>>, String> {
    let mut paths = vec![main.to_owned()];
    let subs = main.with_extension("").join("subagents");
    if [subs.as_path(), main.with_extension("").as_path()]
        .iter()
        .any(|p| fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink()))
    {
        return Err("linked-subagents".into());
    }
    match fs::read_dir(subs) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry.map_err(|e| e.to_string())?;
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with("agent-")
                    && !name.starts_with("agent-acompact-")
                    && name.ends_with(".jsonl")
                    && entry.file_type().is_ok_and(|t| t.is_file())
                {
                    paths.push(entry.path());
                    if paths.len() > 128 {
                        return Err("subagent-limit".into());
                    }
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(e) => return Err(e.to_string()),
    }
    streams.retain(|path, _| paths.contains(path));
    let mut readers = Vec::new();
    let mut total = 0;
    for path in &paths {
        let file = File::open(path).map_err(|e| e.to_string())?;
        total += file.metadata().map_err(|e| e.to_string())?.len();
        if total > MAX_FILE {
            return Err("session-size-limit".into());
        }
        let mut reader = BufReader::new(file);
        streams
            .entry(path.clone())
            .or_default()
            .index(&mut reader, path != main)?;
        readers.push(reader);
    }
    if ids.iter().any(|id| streams[main].ambiguous.contains(id)) {
        return Ok(BTreeMap::new());
    }
    let prompts: BTreeSet<_> = ids
        .iter()
        .filter_map(|id| streams[main].calls.get(id))
        .collect();
    if prompts.len() != 1 {
        return Ok(BTreeMap::new());
    }
    let prompt = *prompts.first().unwrap();
    let mut files: BTreeMap<String, Vec<Edit>> = BTreeMap::new();
    let mut sources = BTreeMap::new();
    let mut content_bytes = 0;
    for (path, mut reader) in paths.iter().zip(readers) {
        let stream = &streams[path];
        for (id, pos) in stream.edits.get(prompt).into_iter().flatten() {
            if stream.ambiguous.contains(id) {
                continue;
            }
            let Some(result_pos) = stream.results.get(id) else {
                continue;
            };
            let row = row_at(&mut reader, *pos)?;
            let Some(block) = row["message"]["content"]
                .as_array()
                .and_then(|blocks| blocks.iter().find(|b| b["id"].as_str() == Some(id)))
            else {
                continue;
            };
            let Some(raw) = block["input"]["file_path"].as_str() else {
                continue;
            };
            let Ok(key) = evidence_path(root, raw) else {
                continue;
            };
            let result = row_at(&mut reader, *result_pos)?;
            if !result["message"]["content"]
                .as_array()
                .is_some_and(|blocks| {
                    blocks.iter().any(|block| {
                        block["type"] == "tool_result"
                            && block["tool_use_id"].as_str() == Some(id)
                            && block["is_error"] != true
                    })
                })
            {
                continue;
            }
            let Some(mut change) = edit(block, &result) else {
                continue;
            };
            content_bytes += change.old.as_ref().map_or(0, String::len) + change.new.len();
            if content_bytes > 8 * 1024 * 1024 {
                return Err("turn-content-limit".into());
            }
            if sources
                .insert(key.clone(), path)
                .is_some_and(|prev| prev != path)
            {
                change.whole = false;
            }
            files.entry(key).or_default().push(change);
        }
    }
    Ok(files)
}

fn version(text: String) -> Version {
    Version {
        hash: Some(digest(text.as_bytes())),
        text: Some(text),
        notice: None,
    }
}

pub(super) fn record(
    root: &Path,
    directory: &Path,
    boundary: &Boundary,
    request: &Request,
) -> Result<Vec<Record>, String> {
    let logs = std::env::home_dir()
        .ok_or("missing-home")?
        .join(".cac/projects");
    record_from(&logs, root, directory, boundary, request)
}

fn record_from(
    logs: &Path,
    root: &Path,
    directory: &Path,
    boundary: &Boundary,
    request: &Request,
) -> Result<Vec<Record>, String> {
    let sid = &request.session_id;
    if sid.is_empty()
        || sid.len() > 128
        || !sid.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("invalid-session-id".into());
    }
    let user = request.user_id.clone().ok_or("missing-user")?;
    // Session-owned directory + stable message identity makes repeated completion idempotent.
    let hash = Sha256::digest(user.as_bytes());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&hash[..16]);
    let id = uuid::Uuid::from_bytes(bytes).to_string();
    let Some(main) = resolve(logs, sid, &request.cwd, Instant::now())? else {
        return Ok(vec![]);
    };
    let index = {
        let mut indexes = INDEXES
            .get_or_init(Default::default)
            .lock()
            .map_err(|e| e.to_string())?;
        if indexes.len() >= 4 && !indexes.contains_key(&main) {
            indexes.pop_first();
        }
        indexes.entry(main.clone()).or_default().clone()
    };
    let target = directory.join(format!("{id}.json"));
    if let Some(previous) = load_summary(&target)? {
        if previous.has_journal || previous.record.can_undo || !previous.record.results.is_empty() {
            return Ok(vec![previous.record]);
        }
    }
    let edits = collect(
        &main,
        root,
        request.tool_ids.as_deref().unwrap_or_default(),
        &mut *index.lock().map_err(|e| e.to_string())?,
    )?;
    if edits.is_empty() {
        return Ok(vec![]);
    }
    let mut baseline = Snapshot::default();
    let mut end = Snapshot::default();
    let mut files = vec![];
    for (key, ops) in edits {
        let first = &ops[0];
        let last = ops.last().unwrap();
        let whole = ops.iter().all(|op| op.whole)
            && ops.windows(2).all(|w| w[1].old.as_ref() == Some(&w[0].new));
        if whole && first.old.as_ref() == Some(&last.new) {
            continue;
        }
        let (before, after, added, removed) = if whole {
            if let Some(old) = &first.old {
                baseline.files.insert(key.clone(), version(old.clone()));
            }
            end.files.insert(key.clone(), version(last.new.clone()));
            let (a, r) = line_counts(first.old.as_deref().unwrap_or(""), &last.new);
            (first.old.clone(), last.new.clone(), a, r)
        } else {
            (None, String::new(), None, None)
        };
        let can_restore = whole
            && after.len() <= FILE_LIMIT as usize
            && before
                .as_ref()
                .is_none_or(|text| text.len() <= FILE_LIMIT as usize);
        let uncertain_write = !whole && first.old.is_none();
        let fragments = if whole {
            vec![]
        } else {
            ops.into_iter().map(|op| (op.old, op.new)).collect()
        };
        files.push(Change {
            path: key,
            fragments,
            old_path: None,
            kind: if uncertain_write {
                "written"
            } else if whole && before.is_none() {
                "added"
            } else {
                "modified"
            }
            .into(),
            before,
            after: whole.then_some(after),
            added,
            removed,
            notice: (!whole).then(|| "已确认的工具编辑片段".into()),
            can_restore,
        });
    }
    if files.is_empty() && !target.exists() {
        return Ok(vec![]);
    }
    let stored = Stored {
        baseline,
        final_state: Some(end),
        owner: owner().into(),
        undo: None,
        previous_undo: None,
        unresolved: BTreeMap::new(),
        requires_dispatch: false,
        record: Record {
            id,
            locked: boundary.submitted.as_ref() != Some(&user),
            user_id: user,
            started_at: request.started_at.unwrap_or_else(now),
            ended_at: Some(now()),
            status: request.status.clone().unwrap_or_else(|| "completed".into()),
            snapshot_state: Some("saved".into()),
            unknown_reason: None,
            concurrent: false,
            has_operations: true,
            incomplete: vec![],
            files,
            unverified: vec![],
            restored: vec![],
            can_undo: false,
            results: vec![],
            details_deferred: false,
            submission: boundary.sequence,
        },
    };
    save(&target, &stored)?;
    Ok(vec![Summary::from(&stored).record])
}

#[cfg(test)]
mod benchmark;
#[cfg(test)]
mod tests;
