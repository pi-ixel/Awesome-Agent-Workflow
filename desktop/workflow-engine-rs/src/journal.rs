//! SQLite checkpoint store for workflow runs and their execution evidence.
//! ADR 023 P4：journal 只剩合同类数据（runs/checkpoint、结果候选、产物、
//! 重试授权与审计）。会话托管类表（workflow_inputs / session_events /
//! session_log_state / workflow_interactions）已随 P2/P3 移交宿主，引擎侧
//! 建表语句删除；旧库文件中遗留的这些表不迁移、不再写入，只读保留原样。
use crate::{Action, ProcessOutput, Workflow};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeSet,
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const APPLICATION_ID: i64 = 0x41415752;
const VERSION: i64 = 9;
type Result<T> = std::result::Result<T, String>;
fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
/// Keep failure diagnostics bounded and printable: control characters out,
/// length capped so a pathological error cannot bloat every checkpoint.
fn sanitize_detail(detail: &str) -> Option<String> {
    let cleaned: String = detail
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(2000).collect())
}

pub struct Journal {
    db: Connection,
}

/// Non-secret execution inputs. The workflow definition and resolved knowledge
/// are persisted in the run checkpoint; credentials stay in the host.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RunSnapshot {
    /// Digest only; runtime command, MCP headers and environment stay in memory.
    #[serde(default)]
    pub execution_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLink {
    pub actor: String,
    pub session_id: String,
    pub site: String,
    pub ordinal: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeRecord {
    pub site_id: String,
    pub ordinal: u32,
    pub actor: String,
    pub status: String,
    pub scope: Value,
    pub call_path: Vec<String>,
    pub phase_id: Option<String>,
    pub result: Option<Value>,
    /// 这一轮已结束但还没有结果，引擎在等用户经会话回复（只在 running 记录上出现）。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub awaiting_input: bool,
    /// 开始等待的时刻（毫秒时间戳）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub awaiting_input_since: Option<i64>,
}

impl RunSnapshot {
    fn validate(&self) -> Result<()> {
        if self
            .execution_hash
            .as_ref()
            .is_some_and(|s| !valid_sha256(s))
        {
            return Err("INVALID_RUN_SNAPSHOT".into());
        }
        Ok(())
    }
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
impl Journal {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let mut db = Connection::open(path).map_err(err)?;
        db.busy_timeout(Duration::from_secs(5)).map_err(err)?;
        db.pragma_update(None, "foreign_keys", true).map_err(err)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let id: i64 = tx
            .pragma_query_value(None, "application_id", |row| row.get(0))
            .map_err(err)?;
        let version: i64 = tx
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(err)?;
        if id == 0 {
            let tables:i64=tx.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",[],|row|row.get(0)).map_err(err)?;
            if tables != 0 || version != 0 {
                return Err("DATABASE_NOT_RUST_WORKFLOW".into());
            }
            tx.pragma_update(None, "application_id", APPLICATION_ID)
                .map_err(err)?;
        } else if id != APPLICATION_ID {
            return Err("DATABASE_NOT_RUST_WORKFLOW".into());
        }
        if version > VERSION {
            return Err("DATABASE_VERSION_UNSUPPORTED".into());
        }
        tx.execute_batch("CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, project TEXT NOT NULL, revision INTEGER NOT NULL, checkpoint TEXT NOT NULL, owner TEXT, updated_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS runs_project ON runs(project,updated_at); CREATE TABLE IF NOT EXISTS run_snapshots (run_id TEXT PRIMARY KEY REFERENCES runs(id), snapshot TEXT NOT NULL); CREATE TABLE IF NOT EXISTS process_outputs (run_id TEXT NOT NULL REFERENCES runs(id), site TEXT NOT NULL, ordinal INTEGER NOT NULL, output TEXT NOT NULL, PRIMARY KEY(run_id,site,ordinal)); CREATE TABLE IF NOT EXISTS actor_sessions (run_id TEXT NOT NULL REFERENCES runs(id), actor TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY(run_id,actor), UNIQUE(run_id,session_id)); CREATE TABLE IF NOT EXISTS action_sessions (run_id TEXT NOT NULL REFERENCES runs(id), site TEXT NOT NULL, ordinal INTEGER NOT NULL, actor TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY(run_id,site,ordinal), FOREIGN KEY(run_id,actor) REFERENCES actor_sessions(run_id,actor)); CREATE TABLE IF NOT EXISTS owner_process (run_id TEXT PRIMARY KEY REFERENCES runs(id), owner TEXT NOT NULL, pid INTEGER NOT NULL, started TEXT NOT NULL); CREATE TABLE IF NOT EXISTS lease_recovery_audit (run_id TEXT NOT NULL REFERENCES runs(id), owner TEXT NOT NULL, pid INTEGER NOT NULL, started TEXT NOT NULL, reason TEXT NOT NULL, recovered_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS action_records (run_id TEXT NOT NULL REFERENCES runs(id), site TEXT NOT NULL, ordinal INTEGER NOT NULL, actor TEXT NOT NULL, status TEXT NOT NULL, result TEXT, PRIMARY KEY(run_id,site,ordinal));").map_err(err)?;
        // ADR 023 P4：workflow_inputs / session_events / session_log_state /
        // workflow_interactions 的建表语句已删除；二期-2 起宿主也是纯内存
        // 簿记（消息/事件真相归 Desktop 原生存储），引擎库与宿主侧都没有
        // 这类表。旧版本创建的库文件里这些表仍存在：不迁移、不写入、只读
        // 保留，以免触碰旧运行数据。
        tx.execute_batch("CREATE TABLE IF NOT EXISTS result_candidates (id TEXT PRIMARY KEY,run_id TEXT NOT NULL,site TEXT NOT NULL,ordinal INTEGER NOT NULL,result TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,FOREIGN KEY(run_id,site,ordinal) REFERENCES action_records(run_id,site,ordinal)); CREATE INDEX IF NOT EXISTS result_candidates_action ON result_candidates(run_id,site,ordinal,created_at);").map_err(err)?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS action_context (run_id TEXT NOT NULL,site TEXT NOT NULL,ordinal INTEGER NOT NULL,scope TEXT NOT NULL,PRIMARY KEY(run_id,site,ordinal),FOREIGN KEY(run_id,site,ordinal) REFERENCES action_records(run_id,site,ordinal));").map_err(err)?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS action_auto_retries (run_id TEXT NOT NULL,site TEXT NOT NULL,ordinal INTEGER NOT NULL,first_attempt TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(run_id,site,ordinal),FOREIGN KEY(run_id,site,ordinal) REFERENCES action_records(run_id,site,ordinal));").map_err(err)?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS action_call_path (run_id TEXT NOT NULL,site TEXT NOT NULL,ordinal INTEGER NOT NULL,phase TEXT NOT NULL,path TEXT NOT NULL,PRIMARY KEY(run_id,site,ordinal),FOREIGN KEY(run_id,site,ordinal) REFERENCES action_records(run_id,site,ordinal));").map_err(err)?;
        // 等待用户回复的呈现标记：一轮结束仍无结果、引擎挂起等下一个轮次边界时写入，
        // 边界到达即删除。只用于呈现，不参与调度与恢复。
        tx.execute_batch("CREATE TABLE IF NOT EXISTS action_awaiting_input (run_id TEXT NOT NULL,site TEXT NOT NULL,ordinal INTEGER NOT NULL,since INTEGER NOT NULL,PRIMARY KEY(run_id,site,ordinal),FOREIGN KEY(run_id,site,ordinal) REFERENCES action_records(run_id,site,ordinal));").map_err(err)?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS workflow_artifacts (run_id TEXT NOT NULL REFERENCES runs(id),id TEXT NOT NULL,source TEXT NOT NULL,sha256 TEXT NOT NULL,media_type TEXT NOT NULL,content BLOB NOT NULL,PRIMARY KEY(run_id,id));").map_err(err)?;
        tx.pragma_update(None, "user_version", VERSION)
            .map_err(err)?;
        tx.commit().map_err(err)?;
        Ok(Self { db })
    }

    pub fn create(&mut self, id: &str, project: &str, workflow: &Workflow) -> Result<()> {
        if id.trim().is_empty() || project.trim().is_empty() {
            return Err("INVALID_RUN_ID_OR_PROJECT".into());
        }
        if workflow.version != 1 || !workflow.inflight.is_empty() {
            return Err("INVALID_NEW_WORKFLOW".into());
        }
        let checkpoint = serde_json::to_string(workflow).map_err(err)?;
        self.db.execute("INSERT INTO runs(id,project,revision,checkpoint,updated_at) VALUES (?1,?2,0,?3,?4)",params![id,project,checkpoint,now()]).map_err(err)?;
        Ok(())
    }

    /// Create the run and its immutable definition/configuration snapshot in
    /// one transaction, before any action is dispatched.
    pub fn create_with_snapshot(
        &mut self,
        id: &str,
        project: &str,
        workflow: &Workflow,
        snapshot: &RunSnapshot,
    ) -> Result<()> {
        if id.trim().is_empty() || project.trim().is_empty() {
            return Err("INVALID_RUN_ID_OR_PROJECT".into());
        }
        if workflow.version != 1
            || workflow.stage != crate::Stage::Running
            || !workflow.inflight.is_empty()
        {
            return Err("INVALID_NEW_WORKFLOW".into());
        }
        snapshot.validate()?;
        let checkpoint = serde_json::to_string(workflow).map_err(err)?;
        let snapshot = serde_json::to_string(snapshot).map_err(err)?;
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        tx.execute(
            "INSERT INTO runs(id,project,revision,checkpoint,updated_at) VALUES (?1,?2,0,?3,?4)",
            params![id, project, checkpoint, now()],
        )
        .map_err(err)?;
        tx.execute(
            "INSERT INTO run_snapshots(run_id,snapshot) VALUES (?1,?2)",
            params![id, snapshot],
        )
        .map_err(err)?;
        tx.commit().map_err(err)?;
        Ok(())
    }

    pub fn load_snapshot(&self, id: &str, project: &str) -> Result<RunSnapshot> {
        let text: Option<String> = self.db.query_row("SELECT s.snapshot FROM run_snapshots s JOIN runs r ON r.id=s.run_id WHERE r.id=?1 AND r.project=?2", params![id,project], |row| row.get(0)).optional().map_err(err)?;
        let snapshot: RunSnapshot =
            serde_json::from_str(&text.ok_or("RUN_SNAPSHOT_NOT_FOUND")?).map_err(err)?;
        snapshot.validate()?;
        Ok(snapshot)
    }

    /// Associate a real ACP session with an in-flight action. An actor keeps
    /// its original session across repair and re-review actions; replacing a
    /// session silently would lose the conversation context.
    pub fn link_session(
        &mut self,
        id: &str,
        project: &str,
        owner: &str,
        site: &str,
        ordinal: u32,
        session_id: &str,
    ) -> Result<()> {
        if session_id.trim().is_empty() {
            return Err("INVALID_SESSION_ID".into());
        }
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let (_, workflow) = read_owned(&tx, id, project, owner)?;
        let action = workflow
            .action(site, ordinal)
            .ok_or("ACTION_NOT_IN_FLIGHT")?;
        if action.input["__node"]["kind"] != "agent" {
            return Err("NOT_AN_AGENT_ACTION".into());
        }
        let existing: Option<String> = tx
            .query_row(
                "SELECT session_id FROM actor_sessions WHERE run_id=?1 AND actor=?2",
                params![id, action.actor],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?;
        if existing.as_deref().is_some_and(|s| s != session_id) {
            return Err("ACTOR_SESSION_MISMATCH".into());
        }
        tx.execute(
            "INSERT OR IGNORE INTO actor_sessions(run_id,actor,session_id) VALUES (?1,?2,?3)",
            params![id, action.actor, session_id],
        )
        .map_err(err)?;
        let saved: Option<(String,String)> = tx.query_row("SELECT actor,session_id FROM action_sessions WHERE run_id=?1 AND site=?2 AND ordinal=?3", params![id,site,ordinal], |r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(err)?;
        if saved
            .as_ref()
            .is_some_and(|(actor, session)| actor != &action.actor || session != session_id)
        {
            return Err("ACTION_SESSION_MISMATCH".into());
        }
        tx.execute("INSERT OR IGNORE INTO action_sessions(run_id,site,ordinal,actor,session_id) VALUES (?1,?2,?3,?4,?5)", params![id,site,ordinal,action.actor,session_id]).map_err(err)?;
        tx.commit().map_err(err)?;
        Ok(())
    }

    pub fn session_links(&self, id: &str, project: &str) -> Result<Vec<SessionLink>> {
        // Check existence even when there are no links, preserving scope.
        self.load(id, project)?;
        let mut statement = self.db.prepare("SELECT a.actor,a.session_id,a.site,a.ordinal FROM action_sessions a JOIN runs r ON r.id=a.run_id WHERE r.id=?1 AND r.project=?2 ORDER BY a.rowid").map_err(err)?;
        let rows = statement
            .query_map(params![id, project], |row| {
                Ok(SessionLink {
                    actor: row.get(0)?,
                    session_id: row.get(1)?,
                    site: row.get(2)?,
                    ordinal: row.get(3)?,
                })
            })
            .map_err(err)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)
    }

    pub fn actor_session(&self, id: &str, project: &str, actor: &str) -> Result<Option<String>> {
        self.load(id, project)?;
        self.db.query_row("SELECT a.session_id FROM actor_sessions a JOIN runs r ON r.id=a.run_id WHERE r.id=?1 AND r.project=?2 AND a.actor=?3",params![id,project,actor],|row|row.get(0)).optional().map_err(err)
    }

    pub fn record_result_candidate(
        &mut self,
        id: &str,
        project: &str,
        owner: &str,
        action: &Action,
        candidate_id: &str,
        result: &Value,
    ) -> Result<()> {
        let text = serde_json::to_string(result).map_err(err)?;
        if text.len() > 4 * 1024 * 1024 {
            return Err("RESULT_TOO_LARGE".into());
        }
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let (_, workflow) = read_owned(&tx, id, project, owner)?;
        if workflow.action(&action.site, action.ordinal) != Some(action) {
            return Err("ACTION_NOT_IN_FLIGHT".into());
        }
        tx.execute("INSERT INTO result_candidates(id,run_id,site,ordinal,result,state,created_at) VALUES (?1,?2,?3,?4,?5,'submitted',?6)",params![candidate_id,id,action.site,action.ordinal,text,now()]).map_err(err)?;
        tx.commit().map_err(err)
    }

    /// 标记 / 清除「这一轮在等用户回复」。标记要求动作仍在执行中且调用方持有租约；
    /// 清除总是允许（幂等）。
    pub fn set_awaiting_input(
        &mut self,
        id: &str,
        project: &str,
        owner: &str,
        action: &Action,
        waiting: bool,
    ) -> Result<()> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let (_, workflow) = read_owned(&tx, id, project, owner)?;
        if waiting {
            if workflow.action(&action.site, action.ordinal) != Some(action) {
                return Err("ACTION_NOT_IN_FLIGHT".into());
            }
            tx.execute("INSERT OR IGNORE INTO action_awaiting_input(run_id,site,ordinal,since) VALUES (?1,?2,?3,?4)",params![id,action.site,action.ordinal,now()]).map_err(err)?;
        } else {
            tx.execute("DELETE FROM action_awaiting_input WHERE run_id=?1 AND site=?2 AND ordinal=?3",params![id,action.site,action.ordinal]).map_err(err)?;
        }
        tx.commit().map_err(err)
    }

    pub fn result_candidates(
        &self,
        id: &str,
        project: &str,
        site: &str,
        ordinal: u32,
    ) -> Result<Vec<Value>> {
        self.load(id, project)?;
        let mut stmt=self.db.prepare("SELECT id,result,state,created_at FROM result_candidates WHERE run_id=?1 AND site=?2 AND ordinal=?3 ORDER BY rowid").map_err(err)?;
        let rows = stmt
            .query_map(params![id, site, ordinal], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })
            .map_err(err)?;
        rows.map(|row| { let (cid,text,state,created)=row.map_err(err)?; Ok(serde_json::json!({"id":cid,"result":serde_json::from_str::<Value>(&text).map_err(err)?,"state":state,"createdAt":created})) }).collect()
    }

    pub fn load(&self, id: &str, project: &str) -> Result<(i64, Workflow)> {
        let row: Option<(i64, String)> = self
            .db
            .query_row(
                "SELECT revision,checkpoint FROM runs WHERE id=?1 AND project=?2",
                params![id, project],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(err)?;
        let (revision, text) = row.ok_or("RUN_NOT_FOUND")?;
        let workflow: Workflow = serde_json::from_str(&text).map_err(err)?;
        if workflow.version != 1 {
            return Err("UNSUPPORTED_CHECKPOINT_VERSION".into());
        }
        Ok((revision, workflow))
    }

    pub fn project_for_run(&self, id: &str) -> Result<String> {
        self.db
            .query_row("SELECT project FROM runs WHERE id=?1", params![id], |row| {
                row.get(0)
            })
            .optional()
            .map_err(err)?
            .ok_or_else(|| "RUN_NOT_FOUND".into())
    }

    pub fn list_runs(&self, project: &str) -> Result<Vec<(String, Workflow)>> {
        let mut stmt=self.db.prepare("SELECT id,checkpoint FROM runs WHERE project=?1 ORDER BY updated_at DESC LIMIT 100").map_err(err)?;
        let rows = stmt
            .query_map(params![project], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(err)?;
        let mut result = Vec::new();
        for row in rows {
            let (id, text) = row.map_err(err)?;
            let workflow = serde_json::from_str(&text).map_err(err)?;
            result.push((id, workflow));
        }
        Ok(result)
    }

    pub fn has_lease(&self, id: &str, project: &str) -> Result<bool> {
        self.db
            .query_row(
                "SELECT owner IS NOT NULL FROM runs WHERE id=?1 AND project=?2",
                params![id, project],
                |row| row.get(0),
            )
            .optional()
            .map_err(err)?
            .ok_or_else(|| "RUN_NOT_FOUND".into())
    }

    /// The host generates an unpredictable owner token. An existing lease is
    /// never stolen automatically; crash recovery must verify process identity.
    pub fn claim(&mut self, id: &str, project: &str, owner: &str) -> Result<()> {
        if owner.trim().is_empty() {
            return Err("INVALID_LEASE_OWNER".into());
        }
        let n = self
            .db
            .execute(
                "UPDATE runs SET owner=?3 WHERE id=?1 AND project=?2 AND owner IS NULL",
                params![id, project, owner],
            )
            .map_err(err)?;
        if n != 1 {
            return Err("RUN_NOT_FOUND_OR_CLAIMED".into());
        }
        Ok(())
    }

    /// Atomically record a process identity with the lease. The service must
    /// own a kill-on-close job/process group for all descendants.
    pub fn claim_process(&mut self, id: &str, project: &str, owner: &str, pid: u32) -> Result<()> {
        if owner.trim().is_empty() {
            return Err("INVALID_LEASE_OWNER".into());
        }
        let started = crate::process_identity::identity(pid)?.to_string();
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let changed = tx
            .execute(
                "UPDATE runs SET owner=?3 WHERE id=?1 AND project=?2 AND owner IS NULL",
                params![id, project, owner],
            )
            .map_err(err)?;
        if changed != 1 {
            return Err("RUN_NOT_FOUND_OR_CLAIMED".into());
        }
        tx.execute(
            "INSERT INTO owner_process(run_id,owner,pid,started) VALUES (?1,?2,?3,?4)",
            params![id, owner, pid, started],
        )
        .map_err(err)?;
        tx.commit().map_err(err)?;
        Ok(())
    }

    /// Only free a dead owner's lease. In-flight actions remain unknown and
    /// must still be reconciled or explicitly authorized for one retry.
    pub fn recover_abandoned(&mut self, id: &str, project: &str, reason: &str) -> Result<()> {
        // POSIX process groups alone do not guarantee descendants terminate
        // when the service dies; do not reclaim until the host can prove that.
        #[cfg(not(windows))]
        {
            let _ = (id, project, reason);
            return Err("PROCESS_TREE_LIVENESS_UNVERIFIED".into());
        }
        #[cfg(windows)]
        {
            if reason.trim().is_empty() {
                return Err("EVIDENCE_REQUIRED".into());
            }
            let tx = self
                .db
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(err)?;
            let lease:Option<(String,u32,String)>=tx.query_row("SELECT o.owner,o.pid,o.started FROM owner_process o JOIN runs r ON r.id=o.run_id WHERE r.id=?1 AND r.project=?2 AND r.owner=o.owner",params![id,project],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional().map_err(err)?;
            let (owner, pid, started) = lease.ok_or("ABANDONED_LEASE_NOT_FOUND")?;
            let start = started
                .parse::<u64>()
                .map_err(|_| "PROCESS_IDENTITY_INVALID")?;
            if crate::process_identity::verify(pid, start)?
                == crate::process_identity::ProcessState::AliveSame
            {
                return Err("OWNER_PROCESS_STILL_ALIVE".into());
            }
            tx.execute("INSERT INTO lease_recovery_audit(run_id,owner,pid,started,reason,recovered_at) VALUES (?1,?2,?3,?4,?5,?6)",params![id,owner,pid,started,reason.trim(),now()]).map_err(err)?;
            tx.execute(
                "DELETE FROM owner_process WHERE run_id=?1 AND owner=?2",
                params![id, owner],
            )
            .map_err(err)?;
            let changed = tx
                .execute(
                    "UPDATE runs SET owner=NULL WHERE id=?1 AND project=?2 AND owner=?3",
                    params![id, project, owner],
                )
                .map_err(err)?;
            if changed != 1 {
                return Err("RUN_LEASE_MISMATCH".into());
            }
            tx.commit().map_err(err)?;
            Ok(())
        }
    }

    /// Release only after the host has stopped all owned processes and actions.
    pub fn release(&mut self, id: &str, project: &str, owner: &str) -> Result<()> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let n = tx
            .execute(
                "UPDATE runs SET owner=NULL WHERE id=?1 AND project=?2 AND owner=?3",
                params![id, project, owner],
            )
            .map_err(err)?;
        if n != 1 {
            return Err("RUN_LEASE_MISMATCH".into());
        }
        tx.execute(
            "DELETE FROM owner_process WHERE run_id=?1 AND owner=?2",
            params![id, owner],
        )
        .map_err(err)?;
        tx.commit().map_err(err)?;
        Ok(())
    }

    /// Persist in-flight actions before exposing them to an executor.
    pub fn dispatch(&mut self, id: &str, project: &str, owner: &str) -> Result<Vec<Action>> {
        self.dispatch_inner(id, project, owner, false)
    }
    /// Only the currently leased executor can issue additional ready actions.
    pub fn dispatch_ready(&mut self, id: &str, project: &str, owner: &str) -> Result<Vec<Action>> {
        self.dispatch_inner(id, project, owner, true)
    }
    fn dispatch_inner(
        &mut self,
        id: &str,
        project: &str,
        owner: &str,
        allow_inflight: bool,
    ) -> Result<Vec<Action>> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let (revision, mut workflow) = read_owned(&tx, id, project, owner)?;
        let known: BTreeSet<String> = workflow
            .graph
            .all_skipped()
            .iter()
            .map(|record| Action::key(&record.site, record.ordinal))
            .collect();
        let actions = if allow_inflight {
            workflow.dispatch_ready()?
        } else {
            workflow.dispatch()?
        };
        for record in workflow
            .graph
            .all_skipped()
            .iter()
            .filter(|record| !known.contains(&Action::key(&record.site, record.ordinal)))
        {
            tx.execute("INSERT INTO action_records(run_id,site,ordinal,actor,status) VALUES (?1,?2,?3,?4,'skipped')",params![id,record.site,record.ordinal,record.actor]).map_err(err)?;
            tx.execute(
                "INSERT INTO action_context(run_id,site,ordinal,scope) VALUES (?1,?2,?3,?4)",
                params![
                    id,
                    record.site,
                    record.ordinal,
                    serde_json::to_string(&record.scope).map_err(err)?
                ],
            )
            .map_err(err)?;
            tx.execute("INSERT INTO action_call_path(run_id,site,ordinal,phase,path) VALUES (?1,?2,?3,?4,?5)",params![id,record.site,record.ordinal,record.phase,serde_json::to_string(&record.call_path).map_err(err)?]).map_err(err)?;
        }
        for action in &actions {
            tx.execute("INSERT INTO action_records(run_id,site,ordinal,actor,status) VALUES (?1,?2,?3,?4,'running')",params![id,action.site,action.ordinal,action.actor]).map_err(err)?;
            tx.execute(
                "INSERT INTO action_context(run_id,site,ordinal,scope) VALUES (?1,?2,?3,?4)",
                params![
                    id,
                    action.site,
                    action.ordinal,
                    serde_json::to_string(&action.input["__scope"]).map_err(err)?
                ],
            )
            .map_err(err)?;
            tx.execute("INSERT INTO action_call_path(run_id,site,ordinal,phase,path) VALUES (?1,?2,?3,?4,?5)",
                params![id,action.site,action.ordinal,action.input["__phase"].as_str().ok_or("MISSING_ACTION_PHASE")?,serde_json::to_string(&action.input["__callPath"]).map_err(err)?]).map_err(err)?;
        }
        write_checkpoint(&tx, id, project, owner, revision, &workflow)?;
        tx.commit().map_err(err)?;
        Ok(actions)
    }
    pub fn complete(
        &mut self,
        id: &str,
        project: &str,
        owner: &str,
        site: &str,
        ordinal: u32,
        result: Value,
    ) -> Result<()> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let (revision, mut workflow) = read_owned(&tx, id, project, owner)?;
        let action = workflow
            .action(site, ordinal)
            .ok_or("ACTION_NOT_IN_FLIGHT")?
            .clone();
        if let Err(error) = workflow.complete(site, ordinal, result.clone()) {
            let text = serde_json::to_string(&result).map_err(err)?;
            tx.execute("UPDATE action_records SET status='failed',result=?4 WHERE run_id=?1 AND site=?2 AND ordinal=?3 AND status='running'",params![id,site,ordinal,text]).map_err(err)?;
            tx.commit().map_err(err)?;
            return Err(error);
        }
        record_completion(&tx, id, &action, &result)?;
        write_checkpoint(&tx, id, project, owner, revision, &workflow)?;
        tx.commit().map_err(err)?;
        Ok(())
    }

    pub fn complete_python(
        &mut self,
        id: &str,
        project: &str,
        owner: &str,
        site: &str,
        ordinal: u32,
        output: ProcessOutput,
    ) -> Result<()> {
        self.finish_python(id, project, owner, site, ordinal, output, None)
    }
    pub fn reconcile_python(
        &mut self,
        id: &str,
        project: &str,
        owner: &str,
        site: &str,
        ordinal: u32,
        evidence: &str,
        output: ProcessOutput,
    ) -> Result<()> {
        self.finish_python(id, project, owner, site, ordinal, output, Some(evidence))
    }
    fn finish_python(
        &mut self,
        id: &str,
        project: &str,
        owner: &str,
        site: &str,
        ordinal: u32,
        output: ProcessOutput,
        evidence: Option<&str>,
    ) -> Result<()> {
        if output.stdout.len().saturating_add(output.stderr.len()) > 4 * 1024 * 1024 {
            return Err("PROCESS_OUTPUT_TOO_LARGE_OUTCOME_UNKNOWN".into());
        }
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let (revision, mut workflow) = read_owned(&tx, id, project, owner)?;
        let action = workflow
            .action(site, ordinal)
            .ok_or("ACTION_NOT_IN_FLIGHT")?
            .clone();
        let applied = if let Some(evidence) = evidence {
            workflow.reconcile_python(site, ordinal, evidence, output.clone())
        } else {
            workflow.complete_python(site, ordinal, output.clone())
        };
        if let Err(error) = applied {
            if evidence.is_none() {
                let candidate = uuid::Uuid::new_v4().to_string();
                let text = serde_json::to_string(&output).map_err(err)?;
                tx.execute("INSERT INTO result_candidates(id,run_id,site,ordinal,result,state,created_at) VALUES (?1,?2,?3,?4,?5,'submitted',?6)",params![candidate,id,site,ordinal,text,now()]).map_err(err)?;
                tx.execute("UPDATE action_records SET status='failed',result=?4 WHERE run_id=?1 AND site=?2 AND ordinal=?3 AND status='running'",params![id,site,ordinal,text]).map_err(err)?;
                tx.execute("INSERT INTO process_outputs(run_id,site,ordinal,output) VALUES (?1,?2,?3,?4) ON CONFLICT(run_id,site,ordinal) DO UPDATE SET output=excluded.output",params![id,site,ordinal,text]).map_err(err)?;
                tx.commit().map_err(err)?;
            }
            return Err(error);
        }
        let result = if output.exit_code == 0 {
            serde_json::from_str::<Value>(&output.stdout)
                .unwrap_or_else(|_| serde_json::json!({"process":output}))
        } else {
            serde_json::json!({"process":output})
        };
        record_completion(&tx, id, &action, &result)?;
        tx.execute(
            "INSERT INTO process_outputs(run_id,site,ordinal,output) VALUES (?1,?2,?3,?4) ON CONFLICT(run_id,site,ordinal) DO UPDATE SET output=excluded.output",
            params![
                id,
                site,
                ordinal,
                serde_json::to_string(&output).map_err(err)?
            ],
        )
        .map_err(err)?;
        write_checkpoint(&tx, id, project, owner, revision, &workflow)?;
        tx.commit().map_err(err)?;
        Ok(())
    }
    pub fn process_output(
        &self,
        id: &str,
        project: &str,
        site: &str,
        ordinal: u32,
    ) -> Result<ProcessOutput> {
        let text: Option<String> = self.db.query_row("SELECT o.output FROM process_outputs o JOIN runs r ON r.id=o.run_id WHERE r.id=?1 AND r.project=?2 AND o.site=?3 AND o.ordinal=?4", params![id,project,site,ordinal], |row|row.get(0)).optional().map_err(err)?;
        serde_json::from_str(&text.ok_or("PROCESS_OUTPUT_NOT_FOUND")?).map_err(err)
    }
    /// Call only after verifying the previous action is not still executing.
    pub fn record_automatic_retry(
        &mut self,
        id: &str,
        project: &str,
        owner: &str,
        action: &Action,
        first: &Value,
    ) -> Result<bool> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let (_, workflow) = read_owned(&tx, id, project, owner)?;
        let current = workflow
            .action(&action.site, action.ordinal)
            .ok_or("ACTION_NOT_IN_FLIGHT")?;
        if current.input["__node"]["kind"] != "python"
            || current.input["__node"]["safeToRetry"] != true
        {
            return Err("AUTOMATIC_RETRY_NOT_PERMITTED".into());
        }
        let changed=tx.execute("INSERT OR IGNORE INTO action_auto_retries(run_id,site,ordinal,first_attempt,created_at) VALUES (?1,?2,?3,?4,?5)",params![id,action.site,action.ordinal,serde_json::to_string(first).map_err(err)?,now()]).map_err(err)?;
        tx.commit().map_err(err)?;
        Ok(changed == 1)
    }
    pub fn authorize_retry(
        &mut self,
        id: &str,
        project: &str,
        owner: &str,
        site: &str,
        ordinal: u32,
        evidence: &str,
    ) -> Result<()> {
        self.change(id, project, owner, |workflow| {
            workflow.authorize_retry(site, ordinal, evidence)
        })
    }
    pub fn record_runtime_failure(
        &mut self,
        id: &str,
        project: &str,
        owner: &str,
        code: &str,
        detail: &str,
    ) -> Result<()> {
        if code.is_empty()
            || code.len() > 80
            || !code
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
        {
            return Err("INVALID_FAILURE_CODE".into());
        }
        let detail = sanitize_detail(detail);
        self.change(id, project, owner, |workflow| {
            workflow.failure = Some(code.into());
            workflow.failure_detail = detail.clone();
            Ok(())
        })
    }
    pub fn clear_runtime_failure(&mut self, id: &str, project: &str, owner: &str) -> Result<()> {
        self.change(id, project, owner, |workflow| {
            workflow.failure = None;
            workflow.failure_detail = None;
            Ok(())
        })
    }
    /// Record startup failures only when no executor owns the run. An existing
    /// failure from the executor remains the more specific authoritative one.
    pub fn record_inactive_failure(
        &mut self,
        id: &str,
        project: &str,
        code: &str,
        detail: &str,
    ) -> Result<bool> {
        if code.is_empty()
            || code.len() > 80
            || !code
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
        {
            return Err("INVALID_FAILURE_CODE".into());
        }
        let detail = sanitize_detail(detail);
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let row: Option<(i64, String)> = tx
            .query_row(
                "SELECT revision,checkpoint FROM runs WHERE id=?1 AND project=?2 AND owner IS NULL",
                params![id, project],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(err)?;
        let Some((revision, text)) = row else {
            return Ok(false);
        };
        let mut workflow: Workflow = serde_json::from_str(&text).map_err(err)?;
        if workflow.failure.is_some() {
            return Ok(false);
        }
        workflow.failure = Some(code.into());
        workflow.failure_detail = detail;
        let checkpoint = serde_json::to_string(&workflow).map_err(err)?;
        let changed=tx.execute("UPDATE runs SET revision=?3,checkpoint=?4,updated_at=?5 WHERE id=?1 AND project=?2 AND owner IS NULL AND revision=?6",params![id,project,revision+1,checkpoint,now(),revision]).map_err(err)?;
        if changed != 1 {
            return Err("RUN_REVISION_CHANGED".into());
        }
        tx.commit().map_err(err)?;
        Ok(true)
    }
    /// Consumed authorization is durable before the action is returned.
    pub fn consume_retry(
        &mut self,
        id: &str,
        project: &str,
        owner: &str,
        site: &str,
        ordinal: u32,
    ) -> Result<Action> {
        self.change(id, project, owner, |workflow| {
            workflow.consume_retry(site, ordinal)
        })
    }

    /// Consume every required authorization atomically before any action is
    /// exposed to a resumed executor. A second crash needs new authorization.
    pub fn prepare_resume(&mut self, id: &str, project: &str, owner: &str) -> Result<Vec<Action>> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let (revision, mut workflow) = read_owned(&tx, id, project, owner)?;
        let actions: Vec<Action> = workflow.inflight.values().cloned().collect();
        if actions.iter().any(|action| {
            !workflow
                .retry_approvals
                .contains(&Action::key(&action.site, action.ordinal))
        }) {
            return Err("UNKNOWN_ACTION_REQUIRES_RECONCILIATION".into());
        }
        for action in &actions {
            workflow.consume_retry(&action.site, action.ordinal)?;
            tx.execute("UPDATE action_records SET status='running' WHERE run_id=?1 AND site=?2 AND ordinal=?3 AND status='failed'",params![id,action.site,action.ordinal]).map_err(err)?;
        }
        write_checkpoint(&tx, id, project, owner, revision, &workflow)?;
        tx.commit().map_err(err)?;
        Ok(actions)
    }
    #[allow(clippy::too_many_arguments)]
    pub fn reconcile(
        &mut self,
        id: &str,
        project: &str,
        owner: &str,
        site: &str,
        ordinal: u32,
        evidence: &str,
        result: Value,
    ) -> Result<()> {
        // A scan must be reconciled from actual process output, not a
        // hand-written pass/fail object.
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let (revision, mut workflow) = read_owned(&tx, id, project, owner)?;
        let action = workflow
            .action(site, ordinal)
            .ok_or("ACTION_NOT_IN_FLIGHT")?
            .clone();
        workflow.reconcile(site, ordinal, evidence, result.clone())?;
        record_completion(&tx, id, &action, &result)?;
        write_checkpoint(&tx, id, project, owner, revision, &workflow)?;
        tx.commit().map_err(err)?;
        Ok(())
    }

    pub fn nodes(&self, id: &str, project: &str) -> Result<Vec<NodeRecord>> {
        self.load(id, project)?;
        let mut stmt=self.db.prepare("SELECT a.site,a.ordinal,a.actor,a.status,a.result,ctx.scope,c.path,c.phase,w.since FROM action_records a JOIN runs r ON r.id=a.run_id LEFT JOIN action_context ctx ON ctx.run_id=a.run_id AND ctx.site=a.site AND ctx.ordinal=a.ordinal LEFT JOIN action_call_path c ON c.run_id=a.run_id AND c.site=a.site AND c.ordinal=a.ordinal LEFT JOIN action_awaiting_input w ON w.run_id=a.run_id AND w.site=a.site AND w.ordinal=a.ordinal WHERE r.id=?1 AND r.project=?2 ORDER BY a.rowid").map_err(err)?;
        let rows = stmt
            .query_map(params![id, project], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, u32>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<i64>>(8)?,
                ))
            })
            .map_err(err)?;
        let mut result = Vec::new();
        for row in rows {
            let (site_id, ordinal, actor, status, text, scope, call_path, phase_id, since) =
                row.map_err(err)?;
            // 残留标记（进程中途退出没来得及清）只在仍在执行的记录上才算数。
            let since = since.filter(|_| status == "running");
            result.push(NodeRecord {
                site_id,
                ordinal,
                actor,
                status,
                scope: scope
                    .map(|s| serde_json::from_str(&s).map_err(err))
                    .transpose()?
                    .unwrap_or_else(|| serde_json::json!({})),
                call_path: call_path
                    .map(|s| serde_json::from_str(&s).map_err(err))
                    .transpose()?
                    .unwrap_or_default(),
                phase_id,
                result: text
                    .map(|s| serde_json::from_str(&s).map_err(err))
                    .transpose()?,
                awaiting_input: since.is_some(),
                awaiting_input_since: since,
            });
        }
        Ok(result)
    }

    pub fn store_artifact(
        &self,
        run_id: &str,
        project: &str,
        artifact: &crate::artifact::Captured,
    ) -> Result<Value> {
        self.load(run_id, project)?;
        let id = uuid::Uuid::new_v4().to_string();
        self.db.execute("INSERT INTO workflow_artifacts(run_id,id,source,sha256,media_type,content) VALUES (?1,?2,?3,?4,?5,?6)",params![run_id,id,artifact.source,artifact.sha256,artifact.media_type,artifact.content]).map_err(err)?;
        Ok(
            serde_json::json!({"uri":format!("workflow-artifact://{id}"),"source":artifact.source,"sha256":artifact.sha256,"mediaType":artifact.media_type,"size":artifact.content.len()}),
        )
    }
    pub fn read_artifact(
        &self,
        run_id: &str,
        project: &str,
        id: &str,
        offset: usize,
        length: usize,
    ) -> Result<Value> {
        use base64::Engine;
        if length == 0 || length > 64 * 1024 {
            return Err("INVALID_ARTIFACT_READ_LENGTH".into());
        }
        self.load(run_id, project)?;
        let row: Option<(String, Vec<u8>)> = self
            .db
            .query_row(
                "SELECT sha256,content FROM workflow_artifacts WHERE run_id=?1 AND id=?2",
                params![run_id, id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(err)?;
        let (sha, content) = row.ok_or("ARTIFACT_NOT_FOUND")?;
        if offset > content.len() {
            return Err("INVALID_ARTIFACT_OFFSET".into());
        }
        let end = offset.saturating_add(length).min(content.len());
        Ok(
            serde_json::json!({"sha256":sha,"offset":offset,"nextOffset":end,"size":content.len(),"text":std::str::from_utf8(&content[offset..end]).ok(),"base64":base64::engine::general_purpose::STANDARD.encode(&content[offset..end])}),
        )
    }

    fn change<T>(
        &mut self,
        id: &str,
        project: &str,
        owner: &str,
        f: impl FnOnce(&mut Workflow) -> Result<T>,
    ) -> Result<T> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let (revision, mut workflow) = read_owned(&tx, id, project, owner)?;
        let result = f(&mut workflow)?;
        let checkpoint = serde_json::to_string(&workflow).map_err(err)?;
        let changed=tx.execute("UPDATE runs SET revision=?4,checkpoint=?5,updated_at=?6 WHERE id=?1 AND project=?2 AND owner=?3 AND revision=?7",params![id,project,owner,revision+1,checkpoint,now(),revision]).map_err(err)?;
        if changed != 1 {
            return Err("RUN_LEASE_OR_REVISION_CHANGED".into());
        }
        tx.commit().map_err(err)?;
        Ok(result)
    }
}

fn read_owned(
    tx: &Transaction<'_>,
    id: &str,
    project: &str,
    owner: &str,
) -> Result<(i64, Workflow)> {
    let row: Option<(i64, String)> = tx
        .query_row(
            "SELECT revision,checkpoint FROM runs WHERE id=?1 AND project=?2 AND owner=?3",
            params![id, project, owner],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(err)?;
    let (revision, text) = row.ok_or("RUN_LEASE_MISMATCH")?;
    let workflow: Workflow = serde_json::from_str(&text).map_err(err)?;
    if workflow.version != 1 {
        return Err("UNSUPPORTED_CHECKPOINT_VERSION".into());
    }
    Ok((revision, workflow))
}

fn write_checkpoint(
    tx: &Transaction<'_>,
    id: &str,
    project: &str,
    owner: &str,
    revision: i64,
    workflow: &Workflow,
) -> Result<()> {
    let checkpoint = serde_json::to_string(workflow).map_err(err)?;
    let changed=tx.execute("UPDATE runs SET revision=?4,checkpoint=?5,updated_at=?6 WHERE id=?1 AND project=?2 AND owner=?3 AND revision=?7",params![id,project,owner,revision+1,checkpoint,now(),revision]).map_err(err)?;
    if changed != 1 {
        return Err("RUN_LEASE_OR_REVISION_CHANGED".into());
    }
    Ok(())
}

fn record_completion(
    tx: &Transaction<'_>,
    id: &str,
    action: &Action,
    result: &Value,
) -> Result<()> {
    let text = serde_json::to_string(result).map_err(err)?;
    let changed=tx.execute("UPDATE action_records SET status='completed',result=?5 WHERE run_id=?1 AND site=?2 AND ordinal=?3 AND actor=?4 AND status IN ('running','failed')",params![id,action.site,action.ordinal,action.actor,text]).map_err(err)?;
    if changed != 1 {
        return Err("ACTION_RECORD_MISMATCH".into());
    }
    tx.execute("UPDATE result_candidates SET state=CASE WHEN id=(SELECT id FROM result_candidates WHERE run_id=?1 AND site=?2 AND ordinal=?3 AND result=?4 ORDER BY rowid DESC LIMIT 1) THEN 'applied' ELSE 'superseded' END WHERE run_id=?1 AND site=?2 AND ordinal=?3 AND state='submitted'",params![id,action.site,action.ordinal,text]).map_err(err)?;
    Ok(())
}
