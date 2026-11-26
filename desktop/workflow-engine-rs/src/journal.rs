//! SQLite checkpoint store for workflow runs and their execution evidence.
//! ADR 023 P4：journal 只剩合同类数据（runs/checkpoint、结果候选、产物、
//! 重试授权与审计）。会话托管类表（workflow_inputs / session_events /
//! session_log_state / workflow_interactions）已随 P2/P3 移交宿主，引擎侧
//! 建表语句删除；旧库文件中遗留的这些表不迁移、不再写入，只读保留原样。
use crate::{
    Action, ProcessOutput, Workflow,
    session_host::{SessionState, TurnOutcome},
    intervention::{
        AffectedNode, CheckpointInfo, CleanupFile, CleanupProblem, InterventionPlan,
        InterventionRequest, IrreversibleNode,
    },
};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const APPLICATION_ID: i64 = 0x41415752;
const VERSION: i64 = 12;
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desktop_owner: Option<DesktopRunOwner>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRunOwner {
    pub project: String,
    pub agent_id: String,
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
    /// 这一步在会话里最近一轮的情况（ADR 040 轮次记录）：`working`（还没
    /// 结束）或它的结束方式 `completed` / `cancelled` / `failed`。只在
    /// running 记录上出现。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<String>,
    /// 最近一轮结束的时刻（毫秒时间戳）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_ended_at: Option<i64>,
    /// 已经交了结果、还没被采用（只在 running 记录上出现）。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub submitted: bool,
    /// 进入该动作所在步骤时的检查点（ADR 031）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<i64>,
    /// 人工干预留下的标记：`superseded`（被回退作废）或 `skipped`（被人工跳过）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mark: Option<String>,
    /// 开始执行的时刻（毫秒时间戳，ADR 035）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    /// 结束的时刻；仍在执行时没有。失败后重试会清掉，重新计时到再次结束。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    /// 已结束的等待累计时长（毫秒，两轮之间会话空着的时间），只算运行在执行的时段；
    /// 当前这一次等待只含已结束的执行时段里的部分，正在执行的这段由界面接着算。
    #[serde(default, skip_serializing_if = "is_zero")]
    pub waited_ms: i64,
}

fn is_zero(value: &i64) -> bool {
    *value == 0
}

/// 一份会话报告在轮次记录里新记下的事实（推给界面与通知，ADR 040）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnFact {
    pub run_id: String,
    pub project: String,
    pub site: String,
    pub ordinal: u32,
    pub kind: TurnFactKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnFactKind {
    /// 会话里开始了一轮（用户在会话里接着说了）。
    Started { turn: u64 },
    /// 一轮结束了；`awaiting`：正常停下却没交结果，在等你回复。
    Ended { turn: u64, outcome: TurnOutcome, awaiting: bool },
}

/// 这一步在会话里的一轮（ADR 040 轮次记录）。轮次编号是宿主给的（这一轮
/// 开始时会话状态的序号），跨页面重载单调递增。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnRecord {
    pub turn: u64,
    pub session_id: String,
    /// 这一轮是工作流发说明开始的（不是用户在会话里发起的）。
    pub prompted: bool,
    /// 还没看到它结束时为空（例如运行在这一轮中途被停止）。
    pub outcome: Option<TurnOutcome>,
}

struct TurnTimes {
    started_at: Option<i64>,
    ended_at: Option<i64>,
    outcome: Option<String>,
}

/// 会让运行在界面上的样子变化的表（ADR 040）：这些表上的任何写入都由触发器把
/// `run_changes` 里这次运行的版本号加一，服务据此推送新状态——不靠写入方记得。
const CHANGE_TRACKED: &[(&str, &str)] = &[
    ("runs", "id"),
    ("action_records", "run_id"),
    ("result_candidates", "run_id"),
    ("action_turns", "run_id"),
    ("action_sessions", "run_id"),
    ("actor_sessions", "run_id"),
    ("action_marks", "run_id"),
    ("run_info", "run_id"),
    ("run_archive", "run_id"),
    ("interventions", "run_id"),
    ("step_checkpoints", "run_id"),
    ("lease_recovery_audit", "run_id"),
];

fn change_triggers() -> String {
    // 列名不叫 run_id：删除运行时按 run_id 清表，版本号要留下来让服务看到「删了」。
    let mut sql = String::from("CREATE TABLE IF NOT EXISTS run_changes (run TEXT PRIMARY KEY, version INTEGER NOT NULL);");
    for (table, column) in CHANGE_TRACKED {
        for (event, row) in [("INSERT", "NEW"), ("UPDATE", "NEW"), ("DELETE", "OLD")] {
            sql.push_str(&format!(
                "CREATE TRIGGER IF NOT EXISTS {table}_changed_{name} AFTER {event} ON {table} BEGIN INSERT INTO run_changes(run,version) VALUES ({row}.{column},1) ON CONFLICT(run) DO UPDATE SET version=version+1; END;",
                name = event.to_lowercase(),
            ));
        }
    }
    sql
}

impl RunSnapshot {
    fn validate(&self) -> Result<()> {
        if self
            .execution_hash
            .as_ref()
            .is_some_and(|s| !valid_sha256(s))
            || self.desktop_owner.as_ref().is_some_and(|owner|
                owner.project.trim().is_empty() || owner.agent_id.trim().is_empty())
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
/// 运行的呈现信息（`run_info` 表 + `runs.updated_at`）。
#[derive(Debug, Clone, Default)]
pub struct RunInfo {
    pub title: String,
    pub created_at: Option<i64>,
    pub updated_at: i64,
    /// 归档时刻（ADR 036）；没归档为 None。
    pub archived_at: Option<i64>,
    /// 这一段执行从何时开始（运行在执行时）。
    pub active_since: Option<i64>,
    /// 最近一次停下的时刻（执行时段结束）。
    pub stopped_at: Option<i64>,
    /// 全部执行时段（起，止；正在执行的没有止），界面据此只算执行时的用时。
    pub spans: Vec<(i64, Option<i64>)>,
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
        // ADR 040：旧版的「等你回复」标记表（靠写入方记得清除，进程中途退出会留下
        // 残留）由轮次记录取代；等不等你从轮次记录算出来。
        tx.execute_batch("DROP TRIGGER IF EXISTS action_times_wait; DROP TABLE IF EXISTS action_awaiting_input;").map_err(err)?;
        // ADR 040 轮次记录：这一步在会话里的每一轮、它怎么结束的（宿主如实报告）。
        // 运行在执行的时段（有属主的时段）：等待、用时只算这些时段里的（停着的时间不计）。
        // 租约的取得与释放都经过 runs.owner，由触发器记下，不靠各处写入方记得。
        tx.execute_batch("CREATE TABLE IF NOT EXISTS run_spans (run_id TEXT NOT NULL,started_at INTEGER NOT NULL,ended_at INTEGER);             CREATE INDEX IF NOT EXISTS run_spans_run ON run_spans(run_id,started_at);             CREATE TRIGGER IF NOT EXISTS run_spans_open AFTER UPDATE OF owner ON runs WHEN OLD.owner IS NULL AND NEW.owner IS NOT NULL BEGIN UPDATE run_spans SET ended_at=started_at WHERE run_id=NEW.id AND ended_at IS NULL; INSERT INTO run_spans(run_id,started_at) VALUES (NEW.id,CAST(unixepoch('subsec')*1000 AS INTEGER)); END;             CREATE TRIGGER IF NOT EXISTS run_spans_close AFTER UPDATE OF owner ON runs WHEN OLD.owner IS NOT NULL AND NEW.owner IS NULL BEGIN UPDATE run_spans SET ended_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE run_id=NEW.id AND ended_at IS NULL; END;").map_err(err)?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS action_turns (run_id TEXT NOT NULL,site TEXT NOT NULL,ordinal INTEGER NOT NULL,turn INTEGER NOT NULL,session_id TEXT NOT NULL,prompted INTEGER NOT NULL DEFAULT 0,started_at INTEGER,ended_at INTEGER,outcome TEXT,error TEXT,PRIMARY KEY(run_id,site,ordinal,turn),FOREIGN KEY(run_id,site,ordinal) REFERENCES action_records(run_id,site,ordinal));").map_err(err)?;
        // 运行的显示信息：标题（默认取需求首行）与创建时间。只用于呈现。
        tx.execute_batch("CREATE TABLE IF NOT EXISTS run_info (run_id TEXT PRIMARY KEY REFERENCES runs(id),title TEXT NOT NULL,created_at INTEGER NOT NULL);").map_err(err)?;
        // ADR 039：在会话里发起的运行，第一个 Agent 步骤接着用发起它的会话。
        tx.execute_batch("CREATE TABLE IF NOT EXISTS run_entry_sessions (run_id TEXT PRIMARY KEY REFERENCES runs(id),session_id TEXT NOT NULL);").map_err(err)?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS workflow_artifacts (run_id TEXT NOT NULL REFERENCES runs(id),id TEXT NOT NULL,source TEXT NOT NULL,sha256 TEXT NOT NULL,media_type TEXT NOT NULL,content BLOB NOT NULL,PRIMARY KEY(run_id,id));").map_err(err)?;
        // ADR 031：步骤检查点、动作所属步骤、作废 / 人工跳过标记、干预审计、会话重置。
        tx.execute_batch("CREATE TABLE IF NOT EXISTS step_checkpoints (seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES runs(id),prefix TEXT NOT NULL,call_path TEXT NOT NULL,phase TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,superseded_by INTEGER); CREATE INDEX IF NOT EXISTS step_checkpoints_run ON step_checkpoints(run_id,seq); CREATE TABLE IF NOT EXISTS action_steps (run_id TEXT NOT NULL,site TEXT NOT NULL,ordinal INTEGER NOT NULL,checkpoint INTEGER,clock INTEGER NOT NULL,PRIMARY KEY(run_id,site,ordinal),FOREIGN KEY(run_id,site,ordinal) REFERENCES action_records(run_id,site,ordinal)); CREATE TABLE IF NOT EXISTS action_marks (run_id TEXT NOT NULL,site TEXT NOT NULL,ordinal INTEGER NOT NULL,mark TEXT NOT NULL,intervention INTEGER NOT NULL,PRIMARY KEY(run_id,site,ordinal),FOREIGN KEY(run_id,site,ordinal) REFERENCES action_records(run_id,site,ordinal)); CREATE TABLE IF NOT EXISTS interventions (id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES runs(id),kind TEXT NOT NULL,detail TEXT NOT NULL,created_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS actor_session_resets (run_id TEXT NOT NULL REFERENCES runs(id),actor TEXT NOT NULL,intervention INTEGER NOT NULL,PRIMARY KEY(run_id,actor));").map_err(err)?;
        // ADR 035：节点用时只用于呈现。由触发器跟随状态变化记录，任何写入路径都不会漏记。
        tx.execute_batch("CREATE TABLE IF NOT EXISTS action_times (run_id TEXT NOT NULL,site TEXT NOT NULL,ordinal INTEGER NOT NULL,started_at INTEGER NOT NULL,ended_at INTEGER,waited_ms INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(run_id,site,ordinal)); \
            CREATE TRIGGER IF NOT EXISTS action_times_start AFTER INSERT ON action_records WHEN NEW.status='running' BEGIN INSERT OR IGNORE INTO action_times(run_id,site,ordinal,started_at) VALUES (NEW.run_id,NEW.site,NEW.ordinal,CAST(unixepoch('subsec')*1000 AS INTEGER)); END; \
            CREATE TRIGGER IF NOT EXISTS action_times_status AFTER UPDATE OF status ON action_records WHEN NEW.status<>OLD.status BEGIN UPDATE action_times SET ended_at=CASE WHEN NEW.status='running' THEN NULL ELSE CAST(unixepoch('subsec')*1000 AS INTEGER) END WHERE run_id=NEW.run_id AND site=NEW.site AND ordinal=NEW.ordinal; END;").map_err(err)?;
        // ADR 036：归档只用于呈现（从列表与侧栏隐藏），不影响运行本身。
        tx.execute_batch("CREATE TABLE IF NOT EXISTS run_archive (run_id TEXT PRIMARY KEY REFERENCES runs(id),archived_at INTEGER NOT NULL);").map_err(err)?;
        tx.execute_batch(&change_triggers()).map_err(err)?;
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

    pub fn desktop_owner(&self, id: &str, project: &str) -> Result<Option<DesktopRunOwner>> {
        match self.load_snapshot(id, project) {
            Ok(snapshot) => Ok(snapshot.desktop_owner),
            Err(error) if error == "RUN_SNAPSHOT_NOT_FOUND" => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub fn assign_desktop_owner(&mut self, id: &str, project: &str, owner: DesktopRunOwner) -> Result<()> {
        let tx = self.db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(err)?;
        let raw: String = tx.query_row(
            "SELECT s.snapshot FROM run_snapshots s JOIN runs r ON r.id=s.run_id WHERE r.id=?1 AND r.project=?2",
            params![id, project], |row| row.get(0),
        ).map_err(err)?;
        let mut snapshot: RunSnapshot = serde_json::from_str(&raw).map_err(err)?;
        if let Some(existing) = snapshot.desktop_owner.as_ref() {
            return if existing == &owner { Ok(()) } else { Err("RUN_PROJECT_MISMATCH".into()) };
        }
        snapshot.desktop_owner = Some(owner);
        snapshot.validate()?;
        tx.execute("UPDATE run_snapshots SET snapshot=?2 WHERE run_id=?1",
            params![id, serde_json::to_string(&snapshot).map_err(err)?]).map_err(err)?;
        tx.commit().map_err(err)
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
        let reset = tx
            .execute(
                "DELETE FROM actor_session_resets WHERE run_id=?1 AND actor=?2",
                params![id, action.actor],
            )
            .map_err(err)?
            == 1;
        if reset {
            // 回退时选了「丢弃重做」：这个角色换成新会话，旧动作仍指向原来的会话。
            tx.execute(
                "UPDATE actor_sessions SET session_id=?3 WHERE run_id=?1 AND actor=?2",
                params![id, action.actor, session_id],
            )
            .map_err(err)?;
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
        self.db.query_row("SELECT a.session_id FROM actor_sessions a JOIN runs r ON r.id=a.run_id WHERE r.id=?1 AND r.project=?2 AND a.actor=?3 AND NOT EXISTS (SELECT 1 FROM actor_session_resets x WHERE x.run_id=a.run_id AND x.actor=a.actor)",params![id,project,actor],|row|row.get(0)).optional().map_err(err)
    }

    /// 发起这次运行的会话（ADR 039）。
    pub fn set_entry_session(&mut self, id: &str, session_id: &str) -> Result<()> {
        self.db
            .execute("INSERT OR REPLACE INTO run_entry_sessions(run_id,session_id) VALUES(?1,?2)", params![id, session_id])
            .map(|_| ())
            .map_err(err)
    }

    /// 还没有任何角色会话时，第一个 Agent 步骤接着用发起运行的会话（ADR 039）；
    /// 一旦有角色占用了会话，入口会话就已经用过了。
    pub fn unclaimed_entry_session(&self, id: &str, project: &str) -> Result<Option<String>> {
        self.load(id, project)?;
        self.db.query_row("SELECT e.session_id FROM run_entry_sessions e WHERE e.run_id=?1 AND NOT EXISTS (SELECT 1 FROM actor_sessions a WHERE a.run_id=e.run_id)",params![id],|row|row.get(0)).optional().map_err(err)
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

    /// 运行停着（没有进程持有租约）时 Agent 交上来的结果：这一步仍在执行中就记为
    /// 候选，继续运行时直接采用（ADR 037）。
    pub fn record_stopped_result_candidate(
        &mut self,
        id: &str,
        project: &str,
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
        let row: Option<String> = tx
            .query_row(
                "SELECT checkpoint FROM runs WHERE id=?1 AND project=?2 AND owner IS NULL",
                params![id, project],
                |row| row.get(0),
            )
            .optional()
            .map_err(err)?;
        let workflow: Workflow =
            serde_json::from_str(&row.ok_or("RUN_LEASE_MISMATCH")?).map_err(err)?;
        if workflow.action(&action.site, action.ordinal) != Some(action) {
            return Err("ACTION_NOT_IN_FLIGHT".into());
        }
        tx.execute("INSERT INTO result_candidates(id,run_id,site,ordinal,result,state,created_at) VALUES (?1,?2,?3,?4,?5,'submitted',?6)",params![candidate_id,id,action.site,action.ordinal,text,now()]).map_err(err)?;
        tx.commit().map_err(err)
    }

    /// 同一实际目录中，多个 Agent 可能返回相同会话 ID。
    pub fn session_actors(&self, project: &str, session_id: &str) -> Result<Vec<(String, String)>> {
        let mut stmt = self.db.prepare(
            "SELECT a.run_id,a.actor FROM actor_sessions a JOIN runs r ON r.id=a.run_id WHERE r.project=?1 AND a.session_id=?2",
        ).map_err(err)?;
        let rows = stmt.query_map(params![project, session_id], |row| Ok((row.get(0)?, row.get(1)?))).map_err(err)?;
        rows.collect::<std::result::Result<_, _>>().map_err(err)
    }

    /// 工作流在会话里发出了这一步的说明，这一轮的编号是 `turn`（ADR 040）。
    /// 这是运行线程知道的事实，只有它写；这一轮之后怎么样由会话报告记录。
    #[allow(clippy::too_many_arguments)]
    pub fn record_prompted(
        &mut self,
        id: &str,
        project: &str,
        owner: &str,
        action: &Action,
        session_id: &str,
        turn: u64,
    ) -> Result<()> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let (_, workflow) = read_owned(&tx, id, project, owner)?;
        if workflow.action(&action.site, action.ordinal) != Some(action) {
            return Err("ACTION_NOT_IN_FLIGHT".into());
        }
        tx.execute(
            "INSERT INTO action_turns(run_id,site,ordinal,turn,session_id,prompted,started_at) VALUES (?1,?2,?3,?4,?5,1,?6) ON CONFLICT(run_id,site,ordinal,turn) DO UPDATE SET prompted=1,started_at=COALESCE(started_at,excluded.started_at)",
            params![id, action.site, action.ordinal, turn as i64, session_id, now()],
        )
        .map_err(err)?;
        tx.commit().map_err(err)
    }

    /// 宿主报来一份会话状态（ADR 040）：记进这个会话此刻挂着的那一步的轮次记录。
    /// 与运行在不在执行无关——会话只要登记在没结束的运行上，它的每一轮都记下。
    ///
    /// 归属：会话登记在哪次运行的哪个角色上，就记到这个角色正在做的 Agent 步骤；
    /// 只有工作流已经在这个会话里发过这一步的说明，之后的轮次才算这一步的。这一步
    /// 做完了、运行结束了、还没发过说明，都不记。返回新记下的事实（推给界面与通知）。
    pub fn record_session_state(&mut self, session_id: &str, state: &SessionState) -> Result<Vec<TurnFact>> {
        self.record_scoped_session_state(None, session_id, state)
    }

    pub fn record_scoped_session_state(&mut self, run_id: Option<&str>, session_id: &str, state: &SessionState) -> Result<Vec<TurnFact>> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let links: Vec<(String, String, String, String)> = {
            let mut stmt = tx
                .prepare("SELECT a.run_id,r.project,a.actor,r.checkpoint FROM actor_sessions a JOIN runs r ON r.id=a.run_id WHERE a.session_id=?1 AND (?2 IS NULL OR a.run_id=?2)")
                .map_err(err)?;
            let rows = stmt
                .query_map(params![session_id, run_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
                .map_err(err)?;
            rows.collect::<std::result::Result<_, _>>().map_err(err)?
        };
        let mut facts = Vec::new();
        for (run_id, project, actor, checkpoint) in links {
            let workflow: Workflow = serde_json::from_str(&checkpoint).map_err(err)?;
            if workflow.stage == crate::Stage::Completed {
                continue;
            }
            let Some(action) = workflow
                .inflight
                .values()
                .find(|action| action.actor == actor && action.input["__node"]["kind"] == "agent")
            else {
                continue;
            };
            let first: Option<i64> = tx
                .query_row(
                    "SELECT MIN(turn) FROM action_turns WHERE run_id=?1 AND site=?2 AND ordinal=?3 AND session_id=?4 AND prompted=1",
                    params![run_id, action.site, action.ordinal, session_id],
                    |row| row.get(0),
                )
                .map_err(err)?;
            let Some(first) = first.map(|turn| turn as u64) else {
                continue;
            };
            let fact = |kind| TurnFact {
                run_id: run_id.clone(),
                project: project.clone(),
                site: action.site.clone(),
                ordinal: action.ordinal,
                kind,
            };
            if let Some(turn) = state.running.filter(|turn| *turn >= first) {
                let inserted = tx
                    .execute(
                        "INSERT OR IGNORE INTO action_turns(run_id,site,ordinal,turn,session_id,started_at) VALUES (?1,?2,?3,?4,?5,?6)",
                        params![run_id, action.site, action.ordinal, turn as i64, session_id, now()],
                    )
                    .map_err(err)?;
                if inserted == 1 {
                    facts.push(fact(TurnFactKind::Started { turn }));
                }
            }
            if let Some(ended) = state.ended.as_ref().filter(|ended| ended.turn >= first) {
                let known: Option<Option<String>> = tx
                    .query_row(
                        "SELECT outcome FROM action_turns WHERE run_id=?1 AND site=?2 AND ordinal=?3 AND turn=?4",
                        params![run_id, action.site, action.ordinal, ended.turn as i64],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(err)?;
                if known.flatten().as_deref() == Some(ended.outcome.as_str()) {
                    continue;
                }
                let error = ended.error.as_deref().and_then(sanitize_detail);
                tx.execute(
                    "INSERT INTO action_turns(run_id,site,ordinal,turn,session_id,ended_at,outcome,error) VALUES (?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(run_id,site,ordinal,turn) DO UPDATE SET ended_at=excluded.ended_at,outcome=excluded.outcome,error=excluded.error",
                    params![run_id, action.site, action.ordinal, ended.turn as i64, session_id, now(), ended.outcome.as_str(), error],
                )
                .map_err(err)?;
                let submitted: bool = tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM result_candidates WHERE run_id=?1 AND site=?2 AND ordinal=?3 AND state='submitted')",
                        params![run_id, action.site, action.ordinal],
                        |row| row.get(0),
                    )
                    .map_err(err)?;
                facts.push(fact(TurnFactKind::Ended {
                    turn: ended.turn,
                    outcome: ended.outcome,
                    awaiting: ended.outcome == TurnOutcome::Completed && !submitted,
                }));
            }
        }
        tx.commit().map_err(err)?;
        Ok(facts)
    }

    /// 这个会话收到过这个节点工单的其他执行有几次（ADR 041）：大于 0 时这次执行
    /// 只发返工提示。
    pub fn prompted_executions(&self, id: &str, project: &str, site: &str, ordinal: u32, session_id: &str) -> Result<u32> {
        self.db
            .query_row(
                "SELECT COUNT(DISTINCT t.ordinal) FROM action_turns t JOIN runs r ON r.id=t.run_id WHERE r.id=?1 AND r.project=?2 AND t.site=?3 AND t.ordinal<>?4 AND t.session_id=?5 AND t.prompted=1",
                params![id, project, site, ordinal, session_id],
                |row| row.get::<_, i64>(0),
            )
            .map(|count| count as u32)
            .map_err(err)
    }

    /// 这一步在会话里最近的一轮。
    pub fn last_turn(&self, id: &str, project: &str, site: &str, ordinal: u32) -> Result<Option<TurnRecord>> {
        self.db
            .query_row(
                "SELECT t.turn,t.session_id,t.prompted,t.outcome FROM action_turns t JOIN runs r ON r.id=t.run_id WHERE r.id=?1 AND r.project=?2 AND t.site=?3 AND t.ordinal=?4 ORDER BY t.turn DESC LIMIT 1",
                params![id, project, site, ordinal],
                |row| {
                    Ok(TurnRecord {
                        turn: row.get::<_, i64>(0)? as u64,
                        session_id: row.get(1)?,
                        prompted: row.get(2)?,
                        outcome: row.get::<_, Option<String>>(3)?.as_deref().and_then(TurnOutcome::parse),
                    })
                },
            )
            .optional()
            .map_err(err)
    }

    /// 运行的版本号（ADR 040）：这次运行的任何可见变化都会让它变大。
    pub fn run_version(&self, id: &str) -> Result<i64> {
        self.db
            .query_row("SELECT version FROM run_changes WHERE run=?1", params![id], |row| row.get(0))
            .optional()
            .map(|version| version.unwrap_or(0))
            .map_err(err)
    }

    /// 全部运行的版本号（服务推送状态时比对用）。
    pub fn run_versions(&self) -> Result<Vec<(String, i64)>> {
        let mut stmt = self.db.prepare("SELECT run,version FROM run_changes").map_err(err)?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?))).map_err(err)?;
        rows.collect::<std::result::Result<_, _>>().map_err(err)
    }

    /// 别的连接有没有提交过改动（`PRAGMA data_version`，同一连接上前后比较）。
    pub fn data_version(&self) -> Result<i64> {
        self.db.query_row("PRAGMA data_version", [], |row| row.get(0)).map_err(err)
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

    pub fn set_run_info(&mut self, id: &str, title: &str) -> Result<()> {
        self.db
            .execute(
                "INSERT INTO run_info(run_id,title,created_at) VALUES(?1,?2,?3) ON CONFLICT(run_id) DO UPDATE SET title=excluded.title",
                params![id, title, now()],
            )
            .map(|_| ())
            .map_err(err)
    }

    /// 标题、创建时间与最近更新时间（运行列表与快照的呈现字段）。
    pub fn run_info(&self, id: &str) -> Result<RunInfo> {
        self.db
            .query_row(
                "SELECT r.updated_at, i.title, i.created_at, a.archived_at, (SELECT MAX(started_at) FROM run_spans s WHERE s.run_id=r.id AND s.ended_at IS NULL), (SELECT MAX(ended_at) FROM run_spans s WHERE s.run_id=r.id) FROM runs r LEFT JOIN run_info i ON i.run_id=r.id LEFT JOIN run_archive a ON a.run_id=r.id WHERE r.id=?1",
                params![id],
                |row| {
                    Ok(RunInfo {
                        updated_at: row.get(0)?,
                        title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                        created_at: row.get::<_, Option<i64>>(2)?,
                        archived_at: row.get::<_, Option<i64>>(3)?,
                        active_since: row.get::<_, Option<i64>>(4)?,
                        stopped_at: row.get::<_, Option<i64>>(5)?,
                        spans: Vec::new(),
                    })
                },
            )
            .map_err(err)
            .and_then(|info| Ok(RunInfo { spans: self.run_spans(id)?, ..info }))
    }

    pub fn list_runs(&self, project: &str) -> Result<Vec<(String, Workflow)>> {
        let mut stmt=self.db.prepare("SELECT id,checkpoint FROM runs WHERE project=?1 ORDER BY updated_at DESC LIMIT 300").map_err(err)?;
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

    /// 所有项目的运行（跨项目总览，只读）：(运行, 项目, 状态)，最近更新在前。
    pub fn list_all_runs(&self) -> Result<Vec<(String, String, Workflow)>> {
        let mut stmt = self
            .db
            .prepare("SELECT id,project,checkpoint FROM runs ORDER BY updated_at DESC LIMIT 300")
            .map_err(err)?;
        let rows = stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)))
            .map_err(err)?;
        let mut result = Vec::new();
        for row in rows {
            let (id, project, text) = row.map_err(err)?;
            result.push((id, project, serde_json::from_str(&text).map_err(err)?));
        }
        Ok(result)
    }

    /// 有运行记录的项目。
    pub fn projects(&self) -> Result<Vec<String>> {
        let mut stmt = self.db.prepare("SELECT DISTINCT project FROM runs ORDER BY project").map_err(err)?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0)).map_err(err)?;
        rows.collect::<std::result::Result<Vec<_>, _>>().map_err(err)
    }

    /// 改运行标题（ADR 036）。不影响运行本身。
    pub fn rename_run(&mut self, id: &str, project: &str, title: &str) -> Result<()> {
        let title = title.trim();
        if title.is_empty() || title.chars().count() > 200 {
            return Err("RUN_TITLE_INVALID".into());
        }
        self.has_lease(id, project)?;
        self.set_run_info(id, title)
    }

    /// 归档或取消归档（ADR 036）：只从列表与侧栏隐藏，随时可以恢复。
    pub fn set_archived(&mut self, id: &str, project: &str, archived: bool) -> Result<()> {
        self.has_lease(id, project)?;
        if archived {
            self.db
                .execute("INSERT OR IGNORE INTO run_archive(run_id,archived_at) VALUES(?1,?2)", params![id, now()])
                .map_err(err)?;
        } else {
            self.db.execute("DELETE FROM run_archive WHERE run_id=?1", params![id]).map_err(err)?;
        }
        Ok(())
    }

    /// 永久删除一次运行的全部记录（ADR 036）。只能删没有占用的运行；
    /// 按「带 run_id 列的表」逐一清除，以后新增的运行数据表不会漏删。
    pub fn delete_run(&mut self, id: &str, project: &str) -> Result<()> {
        if self.has_lease(id, project)? {
            return Err("RUN_ALREADY_CLAIMED".into());
        }
        let tx = self.db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(err)?;
        // 表之间有外键；推迟到提交时检查，届时这次运行的记录已全部删掉。
        tx.pragma_update(None, "defer_foreign_keys", true).map_err(err)?;
        let tables: Vec<String> = {
            let mut stmt = tx
                .prepare("SELECT m.name FROM sqlite_master m WHERE m.type='table' AND m.name<>'runs' AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) c WHERE c.name='run_id')")
                .map_err(err)?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0)).map_err(err)?;
            rows.collect::<std::result::Result<_, _>>().map_err(err)?
        };
        for table in tables {
            tx.execute(&format!("DELETE FROM \"{}\" WHERE run_id=?1", table.replace('"', "\"\"")), params![id])
                .map_err(err)?;
        }
        let deleted = tx
            .execute("DELETE FROM runs WHERE id=?1 AND project=?2 AND owner IS NULL", params![id, project])
            .map_err(err)?;
        if deleted != 1 {
            return Err("RUN_NOT_FOUND_OR_CLAIMED".into());
        }
        tx.commit().map_err(err)
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
            // 属主进程已退出：执行时段截止到最后看到的动静（检查点、轮次），不算到现在。
            tx.execute(
                "UPDATE run_spans SET ended_at=MAX(started_at,COALESCE((SELECT updated_at FROM runs WHERE id=?1),0),COALESCE((SELECT MAX(COALESCE(ended_at,started_at)) FROM action_turns WHERE run_id=?1),0)) WHERE run_id=?1 AND ended_at IS NULL",
                params![id],
            )
            .map_err(err)?;
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
        for step in std::mem::take(&mut workflow.entered) {
            tx.execute(
                "INSERT INTO step_checkpoints(run_id,prefix,call_path,phase,state,created_at) VALUES (?1,?2,?3,?4,?5,?6)",
                params![
                    id,
                    serde_json::to_string(&step.prefix).map_err(err)?,
                    serde_json::to_string(&step.call_path).map_err(err)?,
                    step.phase,
                    serde_json::to_string(&step.state).map_err(err)?,
                    now()
                ],
            )
            .map_err(err)?;
        }
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
            record_step(&tx, id, &record.site, record.ordinal, &serde_json::to_string(&record.call_path).map_err(err)?, &record.phase)?;
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
            record_step(&tx, id, &action.site, action.ordinal, &serde_json::to_string(&action.input["__callPath"]).map_err(err)?, action.input["__phase"].as_str().unwrap_or(""))?;
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
    /// 用户选择重做这一步：之前提交、还没采用的结果作废，重做时不会被直接采用。
    pub fn supersede_candidates(
        &mut self,
        id: &str,
        project: &str,
        owner: &str,
        site: &str,
        ordinal: u32,
    ) -> Result<()> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        read_owned(&tx, id, project, owner)?;
        tx.execute("UPDATE result_candidates SET state='superseded' WHERE run_id=?1 AND site=?2 AND ordinal=?3 AND state='submitted'", params![id, site, ordinal]).map_err(err)?;
        tx.commit().map_err(err)
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

    /// 运行在执行的时段（起，止；正在执行的没有止）。旧运行没有记录时为空。
    pub fn run_spans(&self, id: &str) -> Result<Vec<(i64, Option<i64>)>> {
        let mut stmt = self
            .db
            .prepare("SELECT started_at,ended_at FROM run_spans WHERE run_id=?1 ORDER BY started_at")
            .map_err(err)?;
        let rows = stmt.query_map(params![id], |row| Ok((row.get(0)?, row.get(1)?))).map_err(err)?;
        rows.collect::<std::result::Result<_, _>>().map_err(err)
    }

    pub fn nodes(&self, id: &str, project: &str) -> Result<Vec<NodeRecord>> {
        self.load(id, project)?;
        let turns = self.turn_times(id)?;
        let spans = self.run_spans(id)?;
        // 等你的时间只算运行在执行的时段；没有时段记录的旧运行照旧全算。
        let counted = |from: i64, to: Option<i64>| -> i64 {
            if spans.is_empty() {
                return to.map_or(0, |to| (to - from).max(0));
            }
            spans
                .iter()
                .filter_map(|(start, end)| {
                    let upper = match (to, *end) {
                        (Some(to), Some(end)) => to.min(end),
                        (Some(to), None) => to,
                        (None, Some(end)) => end,
                        // 还没结束的等待落在正在执行的时段里：由界面按当前时刻接着算。
                        (None, None) => return None,
                    };
                    Some((upper - from.max(*start)).max(0))
                })
                .sum()
        };
        let mut stmt=self.db.prepare("SELECT a.site,a.ordinal,a.actor,a.status,a.result,ctx.scope,c.path,c.phase,EXISTS(SELECT 1 FROM result_candidates rc WHERE rc.run_id=a.run_id AND rc.site=a.site AND rc.ordinal=a.ordinal AND rc.state='submitted'),st.checkpoint,m.mark,t.started_at,t.ended_at,t.waited_ms FROM action_records a JOIN runs r ON r.id=a.run_id LEFT JOIN action_context ctx ON ctx.run_id=a.run_id AND ctx.site=a.site AND ctx.ordinal=a.ordinal LEFT JOIN action_call_path c ON c.run_id=a.run_id AND c.site=a.site AND c.ordinal=a.ordinal LEFT JOIN action_steps st ON st.run_id=a.run_id AND st.site=a.site AND st.ordinal=a.ordinal LEFT JOIN action_marks m ON m.run_id=a.run_id AND m.site=a.site AND m.ordinal=a.ordinal LEFT JOIN action_times t ON t.run_id=a.run_id AND t.site=a.site AND t.ordinal=a.ordinal WHERE r.id=?1 AND r.project=?2 ORDER BY a.rowid").map_err(err)?;
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
                    row.get::<_, bool>(8)?,
                    row.get::<_, Option<i64>>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    (
                        row.get::<_, Option<i64>>(11)?,
                        row.get::<_, Option<i64>>(12)?,
                        row.get::<_, Option<i64>>(13)?.unwrap_or(0),
                    ),
                ))
            })
            .map_err(err)?;
        let mut result = Vec::new();
        for row in rows {
            let (site_id, ordinal, actor, status, text, scope, call_path, phase_id, submitted, checkpoint, mark, times) =
                row.map_err(err)?;
            let (started_at, ended_at, waited_ms) = times;
            let history = turns.get(&(site_id.clone(), ordinal)).map(Vec::as_slice).unwrap_or_default();
            // 两轮之间会话空着的时间都算在等你。
            let running = status == "running";
            let last = history.last().filter(|_| running);
            // 当前这次等待在已结束的执行时段里的部分（运行停过又继续时）。
            let open_wait = last
                .filter(|turn| turn.outcome.is_some())
                .and_then(|turn| turn.ended_at)
                .filter(|_| !spans.is_empty())
                .map_or(0, |ended| counted(ended, None));
            let waited_ms = waited_ms
                + open_wait
                + history
                    .windows(2)
                    .filter_map(|pair| Some(counted(pair[0].ended_at?, Some(pair[1].started_at?))))
                    .sum::<i64>();
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
                turn: last.map(|turn| turn.outcome.clone().unwrap_or_else(|| "working".into())),
                turn_ended_at: last.and_then(|turn| turn.ended_at),
                submitted: running && submitted,
                checkpoint,
                mark,
                started_at,
                ended_at,
                waited_ms,
            });
        }
        Ok(result)
    }

    /// 一次运行全部轮次的起止（按步骤分组、按轮次排序）。
    fn turn_times(&self, id: &str) -> Result<BTreeMap<(String, u32), Vec<TurnTimes>>> {
        let mut stmt = self
            .db
            .prepare("SELECT site,ordinal,started_at,ended_at,outcome FROM action_turns WHERE run_id=?1 ORDER BY site,ordinal,turn")
            .map_err(err)?;
        let rows = stmt
            .query_map(params![id], |row| {
                Ok((
                    (row.get::<_, String>(0)?, row.get::<_, u32>(1)?),
                    TurnTimes { started_at: row.get(2)?, ended_at: row.get(3)?, outcome: row.get(4)? },
                ))
            })
            .map_err(err)?;
        let mut grouped: BTreeMap<(String, u32), Vec<TurnTimes>> = BTreeMap::new();
        for row in rows {
            let (key, times) = row.map_err(err)?;
            grouped.entry(key).or_default().push(times);
        }
        Ok(grouped)
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
    /// 这次运行固定过的产物：快照编号 → 原始来源（文件路径或网址），给界面显示和打开用。
    pub fn artifact_sources(&self, run_id: &str, project: &str) -> Result<Vec<(String, String)>> {
        self.load(run_id, project)?;
        let mut statement = self
            .db
            .prepare("SELECT id,source FROM workflow_artifacts WHERE run_id=?1")
            .map_err(err)?;
        let rows = statement
            .query_map(params![run_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(err)?;
        rows.collect::<std::result::Result<Vec<_>, _>>().map_err(err)
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

/// 记下动作属于哪个步骤检查点，以及当时的检查点时钟（回退时据此判断哪些记录作废）。
fn record_step(
    tx: &Transaction<'_>,
    id: &str,
    site: &str,
    ordinal: u32,
    call_path: &str,
    phase: &str,
) -> Result<()> {
    let checkpoint: Option<i64> = tx
        .query_row(
            "SELECT max(seq) FROM step_checkpoints WHERE run_id=?1 AND call_path=?2 AND phase=?3 AND superseded_by IS NULL",
            params![id, call_path, phase],
            |row| row.get(0),
        )
        .map_err(err)?;
    let clock: i64 = tx
        .query_row(
            "SELECT coalesce(max(seq),0) FROM step_checkpoints WHERE run_id=?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(err)?;
    tx.execute(
        "INSERT INTO action_steps(run_id,site,ordinal,checkpoint,clock) VALUES (?1,?2,?3,?4,?5)",
        params![id, site, ordinal, checkpoint, clock],
    )
    .map_err(err)?;
    Ok(())
}

// ── 人工干预（ADR 031） ─────────────────────────────────────────────────

struct StepRecord {
    site: String,
    ordinal: u32,
    actor: String,
    status: String,
    result: Option<Value>,
    call_path: Vec<String>,
    phase: Option<String>,
    checkpoint: Option<i64>,
    clock: i64,
    mark: Option<String>,
}

struct CheckpointRow {
    info: CheckpointInfo,
    state: Value,
    superseded: bool,
}

fn checkpoint_row(conn: &Connection, id: &str, seq: i64) -> Result<CheckpointRow> {
    let row: Option<(String, String, String, String, i64, Option<i64>)> = conn
        .query_row(
            "SELECT prefix,call_path,phase,state,created_at,superseded_by FROM step_checkpoints WHERE run_id=?1 AND seq=?2",
            params![id, seq],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .optional()
        .map_err(err)?;
    let (prefix, call_path, phase, state, created_at, superseded) =
        row.ok_or("CHECKPOINT_NOT_FOUND")?;
    Ok(CheckpointRow {
        info: CheckpointInfo {
            seq,
            prefix: serde_json::from_str(&prefix).map_err(err)?,
            call_path: serde_json::from_str(&call_path).map_err(err)?,
            phase,
            created_at,
        },
        state: serde_json::from_str(&state).map_err(err)?,
        superseded: superseded.is_some(),
    })
}

fn step_records(conn: &Connection, id: &str) -> Result<Vec<StepRecord>> {
    let mut stmt = conn
        .prepare("SELECT a.site,a.ordinal,a.actor,a.status,a.result,c.path,c.phase,st.checkpoint,st.clock,m.mark FROM action_records a LEFT JOIN action_call_path c ON c.run_id=a.run_id AND c.site=a.site AND c.ordinal=a.ordinal LEFT JOIN action_steps st ON st.run_id=a.run_id AND st.site=a.site AND st.ordinal=a.ordinal LEFT JOIN action_marks m ON m.run_id=a.run_id AND m.site=a.site AND m.ordinal=a.ordinal WHERE a.run_id=?1 ORDER BY a.rowid")
        .map_err(err)?;
    let rows = stmt
        .query_map(params![id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, u32>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, Option<i64>>(7)?,
                r.get::<_, Option<i64>>(8)?,
                r.get::<_, Option<String>>(9)?,
            ))
        })
        .map_err(err)?;
    let mut out = Vec::new();
    for row in rows {
        let (site, ordinal, actor, status, result, path, phase, checkpoint, clock, mark) =
            row.map_err(err)?;
        out.push(StepRecord {
            site,
            ordinal,
            actor,
            status,
            result: result.map(|s| serde_json::from_str(&s).map_err(err)).transpose()?,
            call_path: path
                .map(|s| serde_json::from_str(&s).map_err(err))
                .transpose()?
                .unwrap_or_default(),
            phase,
            checkpoint,
            clock: clock.unwrap_or(0),
            mark,
        });
    }
    Ok(out)
}

fn node_label(workflow: &Workflow, site: &str) -> String {
    workflow
        .graph
        .definition
        .nodes
        .get(site)
        .and_then(|n| n.ui.get("label").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_else(|| site.to_owned())
}

fn affected(workflow: &Workflow, record: &StepRecord) -> AffectedNode {
    AffectedNode {
        site_id: record.site.clone(),
        ordinal: record.ordinal,
        label: node_label(workflow, &record.site),
        status: record.status.clone(),
        phase_id: record.phase.clone(),
        call_path: record.call_path.clone(),
    }
}

/// 计算一次干预的影响。先在副本上试做，状态上做不到的干预在预览阶段就报错。
fn plan_on(
    conn: &Connection,
    id: &str,
    project: &str,
    workflow: &Workflow,
    request: &InterventionRequest,
) -> Result<(InterventionPlan, Workflow)> {
    request.validate()?;
    let seq = match request.checkpoint {
        Some(seq) => seq,
        None => conn
            .query_row(
                "SELECT checkpoint FROM action_steps WHERE run_id=?1 AND site=?2 AND ordinal=?3",
                params![id, request.site_id.as_deref().unwrap_or(""), request.ordinal.unwrap_or(0)],
                |r| r.get::<_, Option<i64>>(0),
            )
            .optional()
            .map_err(err)?
            .flatten()
            .ok_or("INTERVENTION_TARGET_NOT_FOUND")?,
    };
    let row = checkpoint_row(conn, id, seq)?;
    if row.superseded {
        return Err("CHECKPOINT_SUPERSEDED".into());
    }
    let prefix = row.info.prefix.clone();
    let mut next = workflow.clone();
    let records = step_records(conn, id)?;
    let mut plan = InterventionPlan {
        kind: request.kind.clone(),
        mode: request.mode.clone(),
        checkpoint: row.info.clone(),
        step: request.step.clone(),
        superseded: vec![],
        skipped: vec![],
        cleanup: vec![],
        cleanup_problems: vec![],
        irreversible: vec![],
        sessions: vec![],
        intervention: None,
    };
    let definition = &workflow.graph.definition;
    let chosen: Vec<&StepRecord> = if request.kind == "rewind" {
        next.rewind(&prefix, row.state.clone())?;
        records
            .iter()
            .filter(|r| r.mark.is_none() && r.clock >= seq && r.call_path.starts_with(&prefix))
            .collect()
    } else {
        let step = request.step.as_deref().unwrap_or("");
        let removed =
            next.redirect(&prefix, &row.info.call_path, &row.info.phase, step)?;
        records
            .iter()
            .filter(|r| removed.iter().any(|a| a.site == r.site && a.ordinal == r.ordinal))
            .collect()
    };
    for record in &chosen {
        let node = definition.nodes.get(&record.site);
        if let Some(reason) = node.and_then(|n| n.irreversible.as_ref())
            && record.status != "skipped"
        {
            plan.irreversible.push(IrreversibleNode {
                site_id: record.site.clone(),
                ordinal: record.ordinal,
                label: node_label(workflow, &record.site),
                reason: reason.clone(),
            });
        }
    }
    if request.kind == "rewind" {
        plan.superseded = chosen.iter().map(|r| affected(workflow, r)).collect();
    } else {
        plan.skipped = chosen.iter().map(|r| affected(workflow, r)).collect();
    }
    if request.kind == "rewind" && request.mode.as_deref() == Some("discard") {
        let root = Path::new(project);
        let mut seen = BTreeSet::new();
        for record in &chosen {
            let Some(node) = definition.nodes.get(&record.site) else { continue };
            if node.kind == "agent" && !plan.sessions.contains(&record.actor) {
                plan.sessions.push(record.actor.clone());
            }
            if node.cleanup.is_empty() || record.status != "completed" {
                continue;
            }
            let vars = match record.checkpoint {
                Some(at) => checkpoint_row(conn, id, at)?.state["vars"].clone(),
                None => Value::Null,
            };
            // 清理表达式按节点自己的名字引用这次结果（与去向条件的写法一致）。
            let context = serde_json::json!({"latest": {record.site.clone(): record.result}, "result": record.result, "vars": vars});
            for expr in &node.cleanup {
                let entries = crate::graph::evaluate(expr, &context)
                    .and_then(|v| crate::intervention::cleanup_entries(&v));
                let entries = match entries {
                    Ok(entries) => entries,
                    Err(message) => {
                        plan.cleanup_problems.push(CleanupProblem {
                            site_id: record.site.clone(),
                            ordinal: record.ordinal,
                            entry: expr.to_string(),
                            message,
                        });
                        continue;
                    }
                };
                for entry in entries {
                    match crate::intervention::resolve_cleanup(root, &entry) {
                        Ok((path, display)) => {
                            if !seen.insert(display.clone()) {
                                continue;
                            }
                            let kind = match std::fs::symlink_metadata(&path) {
                                Ok(meta) if meta.is_dir() => "dir",
                                Ok(_) => "file",
                                Err(_) => "missing",
                            };
                            plan.cleanup.push(CleanupFile {
                                path: display,
                                site_id: record.site.clone(),
                                ordinal: record.ordinal,
                                kind: kind.into(),
                            });
                        }
                        Err(message) => plan.cleanup_problems.push(CleanupProblem {
                            site_id: record.site.clone(),
                            ordinal: record.ordinal,
                            entry,
                            message,
                        }),
                    }
                }
            }
        }
    }
    if let Some(note) = crate::intervention::rework_note(request) {
        let phase = if request.kind == "rewind" {
            row.info.phase.clone()
        } else {
            request.step.clone().unwrap_or_default()
        };
        next.notes
            .insert(crate::note_key(&row.info.call_path, &phase), note);
    }
    Ok((plan, next))
}

/// 检查点列表里的一项（给界面挑回退目标）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointSummary {
    #[serde(flatten)]
    pub info: CheckpointInfo,
    /// 所在流程实例仍在执行树上，可以回到这里。
    pub available: bool,
    /// 是该实例当前所在的步骤。
    pub current: bool,
}

impl Journal {
    /// 预览一次干预，不改任何东西。
    pub fn plan_intervention(
        &self,
        id: &str,
        project: &str,
        request: &InterventionRequest,
    ) -> Result<InterventionPlan> {
        let (_, workflow) = self.load(id, project)?;
        plan_on(&self.db, id, project, &workflow, request).map(|(plan, _)| plan)
    }

    /// 执行干预：状态、作废标记、会话重置与审计在一个事务里落库。
    /// 文件清理由调用方在提交后按返回的计划执行。
    pub fn intervene(
        &mut self,
        id: &str,
        project: &str,
        owner: &str,
        request: &InterventionRequest,
    ) -> Result<InterventionPlan> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let (revision, workflow) = read_owned(&tx, id, project, owner)?;
        let (mut plan, next) = plan_on(&tx, id, project, &workflow, request)?;
        let detail = serde_json::json!({"request": request, "plan": plan});
        tx.execute(
            "INSERT INTO interventions(run_id,kind,detail,created_at) VALUES (?1,?2,?3,?4)",
            params![id, request.kind, detail.to_string(), now()],
        )
        .map_err(err)?;
        let intervention = tx.last_insert_rowid();
        let marks = plan
            .superseded
            .iter()
            .map(|n| (n, "superseded", "cancelled"))
            .chain(plan.skipped.iter().map(|n| (n, "skipped", "skipped")));
        for (node, mark, status) in marks {
            tx.execute(
                "INSERT OR REPLACE INTO action_marks(run_id,site,ordinal,mark,intervention) VALUES (?1,?2,?3,?4,?5)",
                params![id, node.site_id, node.ordinal, mark, intervention],
            )
            .map_err(err)?;
            tx.execute(
                "UPDATE action_records SET status=?4 WHERE run_id=?1 AND site=?2 AND ordinal=?3 AND status IN ('running','failed')",
                params![id, node.site_id, node.ordinal, status],
            )
            .map_err(err)?;
        }
        if request.kind == "rewind" {
            let rows: Vec<(i64, String)> = {
                let mut stmt = tx
                    .prepare("SELECT seq,prefix FROM step_checkpoints WHERE run_id=?1 AND seq>=?2 AND superseded_by IS NULL")
                    .map_err(err)?;
                let rows = stmt
                    .query_map(params![id, plan.checkpoint.seq], |r| Ok((r.get(0)?, r.get(1)?)))
                    .map_err(err)?;
                rows.collect::<std::result::Result<_, _>>().map_err(err)?
            };
            for (seq, prefix) in rows {
                let prefix: Vec<String> = serde_json::from_str(&prefix).map_err(err)?;
                if prefix.starts_with(&plan.checkpoint.prefix) {
                    tx.execute(
                        "UPDATE step_checkpoints SET superseded_by=?3 WHERE run_id=?1 AND seq=?2",
                        params![id, seq, intervention],
                    )
                    .map_err(err)?;
                }
            }
        }
        for actor in &plan.sessions {
            tx.execute(
                "INSERT OR REPLACE INTO actor_session_resets(run_id,actor,intervention) VALUES (?1,?2,?3)",
                params![id, actor, intervention],
            )
            .map_err(err)?;
        }
        write_checkpoint(&tx, id, project, owner, revision, &next)?;
        tx.commit().map_err(err)?;
        plan.intervention = Some(intervention);
        Ok(plan)
    }

    /// 确认关卡放行（审计记一条）。之后运行可以继续。
    pub fn confirm_gate(
        &mut self,
        id: &str,
        project: &str,
        owner: &str,
        instance: &[String],
    ) -> Result<()> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let (revision, mut workflow) = read_owned(&tx, id, project, owner)?;
        let gate = workflow
            .gates()
            .into_iter()
            .find(|g| g["instance"] == serde_json::json!(instance))
            .ok_or("NO_PENDING_CONFIRMATION")?;
        workflow.approve(instance)?;
        tx.execute(
            "INSERT INTO interventions(run_id,kind,detail,created_at) VALUES (?1,'confirm',?2,?3)",
            params![id, serde_json::json!({"request": {"kind": "confirm", "instance": instance}, "plan": {"gate": gate}}).to_string(), now()],
        )
        .map_err(err)?;
        write_checkpoint(&tx, id, project, owner, revision, &workflow)?;
        tx.commit().map_err(err)
    }

    /// 未作废的步骤检查点，按时间先后。
    pub fn checkpoints(&self, id: &str, project: &str) -> Result<Vec<CheckpointSummary>> {
        let (_, workflow) = self.load(id, project)?;
        let mut stmt = self
            .db
            .prepare("SELECT seq,prefix,call_path,phase,created_at FROM step_checkpoints WHERE run_id=?1 AND superseded_by IS NULL ORDER BY seq")
            .map_err(err)?;
        let rows = stmt
            .query_map(params![id], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            })
            .map_err(err)?;
        let mut out: Vec<CheckpointSummary> = Vec::new();
        for row in rows {
            let (seq, prefix, call_path, phase, created_at) = row.map_err(err)?;
            let info = CheckpointInfo {
                seq,
                prefix: serde_json::from_str(&prefix).map_err(err)?,
                call_path: serde_json::from_str(&call_path).map_err(err)?,
                phase,
                created_at,
            };
            let available = workflow.step_available(&info.prefix);
            out.push(CheckpointSummary { info, available, current: false });
        }
        // 每个仍在执行的实例，它当前步骤对应最新的那个检查点。
        for run in workflow.graph.live_runs() {
            let path = run.call_path();
            if let Some(last) = out
                .iter_mut()
                .rev()
                .find(|c| c.info.prefix == run.prefix && c.info.call_path == path && c.info.phase == run.phase)
            {
                last.current = workflow.step_available(&run.prefix);
            }
        }
        Ok(out)
    }

    /// 干预审计，按时间先后。
    pub fn interventions(&self, id: &str, project: &str) -> Result<Vec<Value>> {
        self.load(id, project)?;
        let mut stmt = self
            .db
            .prepare("SELECT id,kind,detail,created_at FROM interventions WHERE run_id=?1 ORDER BY id")
            .map_err(err)?;
        let rows = stmt
            .query_map(params![id], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })
            .map_err(err)?;
        rows.map(|row| {
            let (iid, kind, detail, created) = row.map_err(err)?;
            let detail: Value = serde_json::from_str(&detail).map_err(err)?;
            Ok(serde_json::json!({"id": iid, "kind": kind, "createdAt": created, "request": detail["request"], "plan": detail["plan"]}))
        })
        .collect()
    }
}

impl Journal {
    /// D9：服务启动时，属主进程已退出的运行释放租约并记下原因，之后可以继续。
    /// 返回被释放的运行。属主仍在或无法确认的保持原样。
    pub fn recover_dead_owners(&mut self) -> Result<Vec<String>> {
        let leased: Vec<(String, String)> = {
            let mut stmt = self
                .db
                .prepare("SELECT r.id,r.project FROM runs r JOIN owner_process o ON o.run_id=r.id AND o.owner=r.owner")
                .map_err(err)?;
            let rows = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(err)?;
            rows.collect::<std::result::Result<_, _>>().map_err(err)?
        };
        let mut recovered = Vec::new();
        for (id, project) in leased {
            if self
                .recover_abandoned(&id, &project, "SERVICE_RESTART_OWNER_EXITED")
                .is_ok()
            {
                let _ = self.record_inactive_failure(
                    &id,
                    &project,
                    "OWNER_PROCESS_EXITED",
                    "运行所在的服务进程已退出，运行被中断。",
                );
                recovered.push(id);
            }
        }
        Ok(recovered)
    }
}
