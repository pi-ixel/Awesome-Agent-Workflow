use chrono::{DateTime, Days, Utc};
use chrono_tz::Tz;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path, time::Duration};
use tauri::AppHandle;

const FILE: &str = "usage.sqlite";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    workspace: String,
    agent: String,
    agent_key: String,
    session: String,
    turn: String,
    started_at: i64,
    ended_at: i64,
    model: Option<String>,
    model_source: String,
    status: String,
    input: Option<i64>,
    output: Option<i64>,
    total: Option<i64>,
    accounting: Option<String>,
}

fn open(directory: &Path, zone: &str, enabled_at: i64) -> Result<(Connection, Tz, i64), String> {
    let zone: Tz = zone.parse().map_err(|_| "无效的统计时区")?;
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let mut db = Connection::open(directory.join(FILE)).map_err(sql_error)?;
    db.busy_timeout(Duration::from_secs(3)).map_err(sql_error)?;
    let version: i64 = db
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(sql_error)?;
    if version > 6 {
        return Err("统计数据库版本较新".to_owned());
    }
    if version < 6 {
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        let version: i64 = tx
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(sql_error)?;
        if version < 2 {
            tx.execute_batch(
                "CREATE TABLE IF NOT EXISTS usage_config (
           id INTEGER PRIMARY KEY CHECK(id = 1), zone TEXT NOT NULL, enabled_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS usage_turn (
           workspace TEXT NOT NULL, agent TEXT NOT NULL, agent_key TEXT NOT NULL,
           session TEXT NOT NULL, turn TEXT NOT NULL, ended_at INTEGER NOT NULL,
           day TEXT NOT NULL, model TEXT, model_source TEXT NOT NULL, status TEXT NOT NULL,
           input INTEGER, output INTEGER,
           PRIMARY KEY(workspace, agent, agent_key, session, turn)
         );
         CREATE INDEX IF NOT EXISTS usage_turn_day ON usage_turn(day);
         CREATE INDEX IF NOT EXISTS usage_turn_workspace ON usage_turn(workspace, day);
         CREATE INDEX IF NOT EXISTS usage_turn_agent ON usage_turn(agent, day);
         CREATE TABLE IF NOT EXISTS usage_model_name (
           agent TEXT NOT NULL, agent_key TEXT NOT NULL, model TEXT NOT NULL,
           name TEXT NOT NULL, PRIMARY KEY(agent, agent_key, model)
         );
                 PRAGMA user_version = 2;",
            )
            .map_err(sql_error)?;
        }
        if version < 3 {
            tx.execute_batch(
                "ALTER TABLE usage_turn ADD COLUMN accounting TEXT NOT NULL DEFAULT 'turn';
                 PRAGMA user_version = 3;",
            )
            .map_err(sql_error)?;
        }
        if version < 4 {
            tx.execute_batch(
                "UPDATE usage_turn SET accounting = 'session-total' WHERE agent = 'codeagent';
                 PRAGMA user_version = 4;",
            )
            .map_err(sql_error)?;
        }
        if version < 5 {
            tx.execute_batch(
                "UPDATE usage_turn SET accounting = 'turn' WHERE agent = 'chrys';
                 PRAGMA user_version = 5;",
            )
            .map_err(sql_error)?;
        }
        if version < 6 {
            tx.execute_batch(
                "ALTER TABLE usage_turn ADD COLUMN total INTEGER;
                 PRAGMA user_version = 6;",
            )
            .map_err(sql_error)?;
        }
        tx.commit().map_err(sql_error)?;
    }
    let configured: bool = db
        .query_row("SELECT EXISTS(SELECT 1 FROM usage_config)", [], |row| {
            row.get(0)
        })
        .map_err(sql_error)?;
    if !configured {
        db.execute(
            "INSERT OR IGNORE INTO usage_config VALUES (1, ?1, ?2)",
            params![zone.name(), enabled_at],
        )
        .map_err(sql_error)?;
    }
    let (stored_zone, enabled_at): (String, i64) = db
        .query_row(
            "SELECT zone, enabled_at FROM usage_config WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(sql_error)?;
    Ok((
        db,
        stored_zone.parse().map_err(|_| "无法读取统计时区")?,
        enabled_at,
    ))
}

fn sql_error(error: rusqlite::Error) -> String {
    error.to_string()
}

fn insert(db: &Connection, zone: Tz, enabled_at: i64, turn: Turn) -> Result<(), String> {
    if turn.started_at < enabled_at {
        return Ok(());
    }
    let ended = DateTime::from_timestamp_millis(turn.ended_at).ok_or("无效的轮次时间")?;
    let day = ended.with_timezone(&zone).date_naive().to_string();
    let (input, output) = match (turn.input, turn.output) {
        (Some(input), Some(output))
            if input >= 0 && output >= 0 && input.checked_add(output).is_some() =>
        {
            (Some(input), Some(output))
        }
        _ => (None, None),
    };
    // Pending writes from older versions may still carry the old accounting labels.
    let accounting = match (turn.agent.as_str(), turn.accounting.as_deref()) {
        ("chrys", _) => "turn",
        ("codeagent", Some("turn-delta")) => "turn-delta",
        ("codeagent", _) | (_, Some("session-total")) => "session-total",
        _ => "turn",
    };
    db.execute(
        "INSERT INTO usage_turn (workspace, agent, agent_key, session, turn, ended_at, day,
          model, model_source, status, input, output, accounting, total)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(workspace, agent, agent_key, session, turn) DO UPDATE SET
           model = CASE WHEN usage_turn.model_source = 'actual' AND excluded.model_source != 'actual'
                        THEN usage_turn.model ELSE coalesce(excluded.model, usage_turn.model) END,
           model_source = CASE WHEN usage_turn.model_source = 'actual' OR excluded.model IS NULL
                               THEN usage_turn.model_source ELSE excluded.model_source END,
           status = excluded.status,
           accounting = CASE WHEN excluded.input IS NULL AND excluded.accounting <> 'turn-delta'
                             THEN usage_turn.accounting ELSE excluded.accounting END,
           input = CASE WHEN excluded.accounting = 'turn-delta' AND usage_turn.accounting <> 'turn-delta'
                        THEN excluded.input ELSE coalesce(excluded.input, usage_turn.input) END,
           output = CASE WHEN excluded.accounting = 'turn-delta' AND usage_turn.accounting <> 'turn-delta'
                         THEN excluded.output ELSE coalesce(excluded.output, usage_turn.output) END,
           total = coalesce(excluded.total, usage_turn.total)
         WHERE usage_turn.accounting <> 'turn-delta' OR excluded.accounting = 'turn-delta'",
        params![turn.workspace, turn.agent, turn.agent_key, turn.session, turn.turn,
            turn.ended_at, day, turn.model, turn.model_source, turn.status, input, output,
            accounting, turn.total.filter(|total| *total >= 0 && accounting != "session-total")],
    ).map_err(sql_error)?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    zone: String,
    enabled_at: i64,
    today: String,
    workspaces: Vec<String>,
    days: Vec<(String, String, i64, i64)>,
    models: Vec<(String, Option<String>, String, i64, Option<String>, String)>,
}

fn query(
    db: &Connection,
    zone: Tz,
    enabled_at: i64,
    now: DateTime<Utc>,
    workspace: Option<String>,
    agent: Option<String>,
    days: u32,
) -> Result<Snapshot, String> {
    let today = now.with_timezone(&zone).date_naive();
    let from = today - Days::new(if days == 30 { 29 } else { 6 });
    let workspaces = db
        .prepare("SELECT DISTINCT workspace FROM usage_turn ORDER BY workspace")
        .and_then(|mut stmt| {
            stmt.query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()
        })
        .map_err(sql_error)?;
    let filter =
        "WHERE (?1 IS NULL OR workspace = ?1) AND (?2 IS NULL OR agent = ?2) AND day <= ?3";
    // Old CodeAgent rows have input/output only; their cache-inclusive total is unknown.
    let usage = format!(
        "WITH normalized AS (
           SELECT *, CASE
             WHEN agent = 'codeagent' OR accounting = 'session-total' THEN total
             ELSE coalesce(total, input + output)
           END AS tokens
           FROM usage_turn {filter}
         )"
    );
    let daily = db
        .prepare(&format!(
            "{usage} SELECT day, CAST(coalesce(sum(tokens), 0) AS TEXT), sum(tokens IS NULL), count(*)
         FROM normalized GROUP BY day ORDER BY day"
        ))
        .and_then(|mut stmt| {
            stmt.query_map(params![workspace, agent, today.to_string()], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?
            .collect::<rusqlite::Result<_>>()
        })
        .map_err(sql_error)?;
    let models = db
        .prepare(&format!(
            "{usage} SELECT day, model, CAST(sum(tokens) AS TEXT), sum(model_source = 'selected'),
              (SELECT name FROM usage_model_name n
               WHERE n.agent = normalized.agent AND n.agent_key = normalized.agent_key
                 AND n.model = normalized.model) AS display_name, agent
         FROM normalized WHERE day >= ?4 AND tokens IS NOT NULL
         GROUP BY day, agent, model, display_name ORDER BY day, agent, model"
        ))
        .and_then(|mut stmt| {
            stmt.query_map(
                params![workspace, agent, today.to_string(), from.to_string()],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )?
            .collect::<rusqlite::Result<_>>()
        })
        .map_err(sql_error)?;
    Ok(Snapshot {
        zone: zone.name().to_owned(),
        enabled_at,
        today: today.to_string(),
        workspaces,
        days: daily,
        models,
    })
}

fn directory(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(crate::storage_location::data_dir(app)?.join("statistics"))
}

fn store_model_names(
    db: &mut Connection,
    agent: &str,
    agent_key: &str,
    models: &[(String, String)],
) -> Result<(), String> {
    let tx = db.transaction().map_err(sql_error)?;
    for (model, name) in models {
        tx.execute(
            "INSERT INTO usage_model_name VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(agent, agent_key, model) DO UPDATE SET name = excluded.name",
            params![agent, agent_key, model, name],
        )
        .map_err(sql_error)?;
    }
    tx.commit().map_err(sql_error)
}

#[tauri::command]
pub async fn usage_model_names(
    app: AppHandle,
    zone: String,
    enabled_at: i64,
    agent: String,
    agent_key: String,
    models: Vec<(String, String)>,
) -> Result<(), String> {
    let directory = directory(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (mut db, _, _) = open(&directory, &zone, enabled_at)?;
        store_model_names(&mut db, &agent, &agent_key, &models)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn usage_initialize(app: AppHandle, zone: String, enabled_at: i64) -> Result<(), String> {
    let directory = directory(&app)?;
    tauri::async_runtime::spawn_blocking(move || open(&directory, &zone, enabled_at).map(|_| ()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn usage_record(
    app: AppHandle,
    zone: String,
    enabled_at: i64,
    turn: Turn,
) -> Result<(), String> {
    let directory = directory(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (db, zone, enabled_at) = open(&directory, &zone, enabled_at)?;
        insert(&db, zone, enabled_at, turn)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn usage_query(
    app: AppHandle,
    zone: String,
    enabled_at: i64,
    workspace: Option<String>,
    agent: Option<String>,
    days: u32,
) -> Result<Snapshot, String> {
    let directory = directory(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (mut db, zone, enabled_at) = open(&directory, &zone, enabled_at)?;
        let read = db.transaction().map_err(sql_error)?;
        query(&read, zone, enabled_at, Utc::now(), workspace, agent, days)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn usage_storage_bytes(app: AppHandle) -> Result<u64, String> {
    let directory = directory(&app)?;
    storage_bytes(&directory)
}

fn storage_bytes(directory: &Path) -> Result<u64, String> {
    let mut bytes = 0;
    for name in [
        FILE,
        "usage.sqlite-wal",
        "usage.sqlite-shm",
        "usage.sqlite-journal",
    ] {
        match fs::metadata(directory.join(name)) {
            Ok(file) => bytes += file.len(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(bytes)
}

#[cfg(test)]
#[path = "usage_statistics_acceptance.rs"]
mod acceptance;

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(id: &str, end: &str, input: Option<i64>, output: Option<i64>) -> Turn {
        let ended_at = end.parse::<DateTime<Utc>>().unwrap().timestamp_millis();
        Turn {
            workspace: "p1".into(),
            agent: "chrys".into(),
            agent_key: "agent".into(),
            session: "session".into(),
            turn: id.into(),
            started_at: ended_at - 120_000,
            ended_at,
            model: Some("model".into()),
            model_source: "selected".into(),
            status: "completed".into(),
            input,
            output,
            total: None,
            accounting: None,
        }
    }

    #[test]
    fn persists_once_and_keeps_fixed_zone_across_reopen() {
        let directory = std::env::temp_dir().join(format!(
            "aaw-usage-test-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap()
        ));
        let (db, zone, enabled) = open(&directory, "Asia/Shanghai", 1).unwrap();
        let end = "2026-11-11T16:01:00Z";
        insert(&db, zone, enabled, turn("a", end, None, None)).unwrap();
        insert(&db, zone, enabled, turn("a", end, Some(100), Some(20))).unwrap();
        insert(&db, zone, enabled, turn("a", end, Some(100), Some(20))).unwrap();
        insert(&db, zone, enabled, turn("a", end, None, None)).unwrap();
        let mut cancelled = turn("b", end, Some(200), Some(30));
        cancelled.agent = "codeagent".into();
        cancelled.status = "cancelled".into();
        insert(&db, zone, enabled, cancelled).unwrap();
        insert(&db, zone, enabled, turn("missing", end, Some(-1), Some(10))).unwrap();
        let mut old = turn("old", end, Some(500), Some(0));
        old.started_at = 0;
        insert(&db, zone, enabled, old).unwrap();
        db.execute_batch("DROP TABLE usage_model_name; ALTER TABLE usage_turn DROP COLUMN total; ALTER TABLE usage_turn DROP COLUMN accounting; PRAGMA user_version = 1;")
            .unwrap();
        drop(db);

        let (mut db, zone, enabled) = open(&directory, "America/New_York", 5).unwrap();
        assert_eq!(zone.name(), "Asia/Shanghai");
        assert_eq!(enabled, 1);
        let now = end.parse().unwrap();
        let all = query(&db, zone, enabled, now, None, None, 7).unwrap();
        assert_eq!(all.days, vec![("2026-11-12".into(), "120".into(), 2, 3)]);
        assert_eq!(
            all.models,
            vec![(
                "2026-11-12".into(),
                Some("model".into()),
                "120".into(),
                1,
                None,
                "chrys".into(),
            )]
        );
        store_model_names(
            &mut db,
            "chrys",
            "agent",
            &[("model".into(), "GLM 5.3 Flash".into())],
        )
        .unwrap();
        let filtered = query(
            &db,
            zone,
            enabled,
            now,
            Some("p1".into()),
            Some("chrys".into()),
            30,
        )
        .unwrap();
        assert_eq!(
            filtered.days,
            vec![("2026-11-12".into(), "120".into(), 1, 2)]
        );
        assert_eq!(
            filtered.models,
            vec![(
                "2026-11-12".into(),
                Some("model".into()),
                "120".into(),
                1,
                Some("GLM 5.3 Flash".into()),
                "chrys".into(),
            )]
        );
        drop(db);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn migrates_legacy_cumulative_snapshots_and_preserves_per_turn_usage() {
        let directory = std::env::temp_dir().join(format!(
            "aaw-usage-accounting-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap()
        ));
        let (db, zone, enabled) = open(&directory, "Asia/Shanghai", 1).unwrap();
        for (id, end, input, output) in [
            ("a", "2026-11-04T12:00:00Z", 14756, 68),
            ("b", "2026-11-12T10:00:00Z", 15225, 200),
            ("c", "2026-11-12T11:00:00Z", 15581, 27),
            ("d", "2026-11-12T12:00:00Z", 15801, 31),
        ] {
            insert(&db, zone, enabled, turn(id, end, Some(input), Some(output))).unwrap();
        }
        for (id, end, counters) in [
            ("a", "2026-11-04T12:00:00Z", Some((100, 10))),
            ("b", "2026-11-12T10:00:00Z", Some((120, 12))),
            ("c", "2026-11-12T10:30:00Z", None),
            ("d", "2026-11-12T11:00:00Z", Some((130, 15))),
            ("e", "2026-11-12T11:30:00Z", Some((140, 14))),
            ("f", "2026-11-12T12:00:00Z", Some((142, 16))),
        ] {
            let mut row = turn(id, end, counters.map(|(input, _)| input), counters.map(|(_, output)| output));
            row.agent = "codeagent".into();
            insert(&db, zone, enabled, row).unwrap();
        }
        db.execute_batch("ALTER TABLE usage_turn DROP COLUMN total;
                          UPDATE usage_turn SET accounting = 'session-total' WHERE agent = 'chrys';
                          PRAGMA user_version = 4;")
            .unwrap();
        drop(db);
        let (db, zone, enabled) = open(&directory, "UTC", 5).unwrap();
        let now = "2026-11-12T13:00:00Z".parse().unwrap();
        let chrys = query(&db, zone, enabled, now, None, Some("chrys".into()), 7).unwrap();
        assert_eq!(
            chrys.days,
            vec![
                ("2026-11-04".into(), "14824".into(), 0, 1),
                ("2026-11-12".into(), "46865".into(), 0, 3),
            ]
        );
        assert_eq!(chrys.models[0].2, "46865");
        let codeagent = query(&db, zone, enabled, now, None, Some("codeagent".into()), 7).unwrap();
        assert_eq!(
            codeagent.days,
            vec![
                ("2026-11-04".into(), "0".into(), 1, 1),
                ("2026-11-12".into(), "0".into(), 5, 5),
            ]
        );
        assert!(codeagent.models.is_empty());

        // A retry from an old client must retain the correct accounting mode.
        let end = "2026-11-12T12:00:00Z";
        let mut old_icode = turn("d", end, Some(15801), Some(31));
        old_icode.accounting = Some("session-total".into());
        insert(&db, zone, enabled, old_icode).unwrap();
        assert_eq!(query(&db, zone, enabled, now, None, Some("chrys".into()), 7).unwrap().days, chrys.days);
        let mut delta = turn("f", end, Some(2), Some(2));
        delta.agent = "codeagent".into();
        delta.accounting = Some("turn-delta".into());
        delta.total = Some(130_555);
        insert(&db, zone, enabled, delta).unwrap();
        let mut stale = turn("f", end, Some(142), Some(16));
        stale.agent = "codeagent".into();
        stale.accounting = Some("turn".into());
        insert(&db, zone, enabled, stale).unwrap();
        let result = query(&db, zone, enabled, now, None, Some("codeagent".into()), 7).unwrap();
        assert_eq!(result.days[1], ("2026-11-12".into(), "130555".into(), 4, 5));
        assert_eq!(result.models[0].2, "130555");
        drop(db);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn groups_one_hundred_thousand_turns_without_returning_raw_rows() {
        let directory = std::env::temp_dir().join(format!(
            "aaw-usage-scale-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap()
        ));
        let (db, zone, enabled) = open(&directory, "UTC", 1).unwrap();
        db.execute_batch(
            "WITH RECURSIVE n(i) AS (
               VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < 100000
             )
             INSERT INTO usage_turn
             SELECT 'p1', 'chrys', 'agent', 'session', cast(i AS TEXT), 0,
                    '2026-11-12', 'model', 'actual', 'completed', 100, 20, 'turn', NULL FROM n;",
        )
        .unwrap();
        let started = std::time::Instant::now();
        let result = query(
            &db,
            zone,
            enabled,
            "2026-11-12T12:00:00Z".parse().unwrap(),
            None,
            None,
            30,
        )
        .unwrap();
        let elapsed = started.elapsed();
        eprintln!("100,000 usage rows aggregated in {elapsed:?}");
        assert!(
            elapsed < Duration::from_secs(5),
            "local SQL baseline exceeded: {elapsed:?}"
        );
        assert_eq!(
            result.days,
            vec![("2026-11-12".into(), "12000000".into(), 0, 100000)]
        );
        assert_eq!(result.models.len(), 1);
        drop(db);
        fs::remove_dir_all(directory).unwrap();
    }
}
