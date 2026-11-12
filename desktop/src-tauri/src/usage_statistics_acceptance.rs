use super::*;
use std::sync::{Arc, Barrier};

struct Sandbox(std::path::PathBuf);

impl Sandbox {
    fn new(label: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "aaw-usage-{label}-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap()
        ));
        fs::create_dir(&dir).unwrap();
        Self(dir)
    }
}
impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn stamp(value: &str) -> i64 {
    value.parse::<DateTime<Utc>>().unwrap().timestamp_millis()
}

fn row(workspace: &str, agent: &str, id: &str, when: &str, tokens: Option<i64>) -> Turn {
    Turn {
        workspace: workspace.into(),
        agent: agent.into(),
        agent_key: "profile".into(),
        session: "shared-session".into(),
        turn: id.into(),
        started_at: stamp(when) - 120_000,
        ended_at: stamp(when),
        model: Some(agent.into()),
        model_source: "actual".into(),
        status: "completed".into(),
        input: tokens,
        output: tokens.map(|_| 0),
        total: tokens,
        accounting: Some(if agent == "codeagent" { "turn-delta" } else { "turn" }.into()),
    }
}

#[test]
fn c09_c10_c11_c12_c16_s07_idempotent_updates_and_scope() {
    let dir = Sandbox::new("identity");
    let (db, zone, enabled) = open(&dir.0, "UTC", 100).unwrap();
    let end = "2026-11-12T00:00:00Z";
    for agent in ["chrys", "codeagent"] {
        let mut before = row("p1", agent, "before", end, Some(99));
        before.started_at = 99;
        insert(&db, zone, enabled, before).unwrap();
        for tokens in [None, Some(100), Some(100), None, Some(110)] {
            let mut value = row("p1", agent, "same", end, tokens);
            if agent == "chrys" {
                value.accounting = Some("session-total".into());
            }
            insert(&db, zone, enabled, value).unwrap();
        }
        insert(&db, zone, enabled, row("p2", agent, "same", end, Some(30))).unwrap();
    }
    let result = query(&db, zone, enabled, end.parse().unwrap(), None, None, 7).unwrap();
    assert_eq!(result.days, [("2026-11-12".into(), "280".into(), 0, 4)]);
}

#[test]
fn s04_read_only_and_sqlite_full_preserve_committed_rows() {
    let dir = Sandbox::new("disk");
    let (db, zone, enabled) = open(&dir.0, "UTC", 1).unwrap();
    let end = "2026-11-12T00:00:00Z";
    insert(
        &db,
        zone,
        enabled,
        row("p", "codeagent", "committed", end, Some(5)),
    )
    .unwrap();
    let read_only =
        Connection::open_with_flags(dir.0.join(FILE), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    let error = insert(
        &read_only,
        zone,
        enabled,
        row("p", "codeagent", "blocked", end, Some(90)),
    )
    .unwrap_err();
    assert!(error.contains("readonly"));
    let pages: i64 = db
        .pragma_query_value(None, "page_count", |r| r.get(0))
        .unwrap();
    db.pragma_update(None, "max_page_count", pages).unwrap();
    let mut large = row("p", "codeagent", "full", end, Some(90));
    large.model = Some("m".repeat(128 * 1024));
    assert!(
        insert(&db, zone, enabled, large)
            .unwrap_err()
            .contains("full")
    );
    let result = query(&db, zone, enabled, end.parse().unwrap(), None, None, 7).unwrap();
    assert_eq!(result.days, [("2026-11-12".into(), "5".into(), 0, 1)]);
}

#[test]
fn s03_clearing_conversation_files_does_not_touch_statistics() {
    let dir = Sandbox::new("retention");
    let statistics = dir.0.join("statistics");
    let snapshots = dir.0.join("session-snapshots");
    let workspaces = dir.0.join("configuration");
    fs::create_dir(&snapshots).unwrap();
    fs::create_dir(&workspaces).unwrap();
    let chat = snapshots.join("chat.json");
    let project = workspaces.join("project.json");
    fs::write(&chat, b"temporary session snapshot").unwrap();
    fs::write(&project, b"temporary project entry").unwrap();
    let end = "2026-11-12T00:00:00Z";
    let (db, zone, enabled) = open(&statistics, "UTC", 1).unwrap();
    insert(
        &db,
        zone,
        enabled,
        row("removed-project", "codeagent", "t", end, Some(5)),
    )
    .unwrap();
    drop(db);
    fs::remove_file(chat).unwrap();
    fs::remove_file(project).unwrap();
    let (db, zone, enabled) = open(&statistics, "UTC", 2).unwrap();
    let result = query(&db, zone, enabled, end.parse().unwrap(), None, None, 7).unwrap();
    assert_eq!(result.workspaces, ["removed-project"]);
    assert_eq!(result.days, [("2026-11-12".into(), "5".into(), 0, 1)]);
}

#[test]
fn a02_a03_a04_a05_a09_a10_keeps_summary_and_filters_model_window() {
    let dir = Sandbox::new("filters");
    let (db, zone, enabled) = open(&dir.0, "UTC", 1).unwrap();
    for (workspace, agent, id, when, tokens) in [
        ("p1", "chrys", "a", "2026-11-10T12:00:00Z", Some(120)),
        ("p1", "codeagent", "b", "2026-11-11T12:00:00Z", Some(230)),
        ("p2", "chrys", "c", "2026-11-11T12:00:00Z", Some(60)),
        ("p2", "codeagent", "d", "2026-11-12T11:00:00Z", None),
        (
            "boundaries",
            "chrys",
            "7in",
            "2026-11-06T00:00:00Z",
            Some(7),
        ),
        (
            "boundaries",
            "chrys",
            "7out",
            "2026-11-05T23:59:59Z",
            Some(8),
        ),
        (
            "boundaries",
            "chrys",
            "30in",
            "2026-10-14T00:00:00Z",
            Some(30),
        ),
        (
            "boundaries",
            "chrys",
            "30out",
            "2026-10-13T23:59:59Z",
            Some(31),
        ),
    ] {
        insert(&db, zone, enabled, row(workspace, agent, id, when, tokens)).unwrap();
    }
    let snapshot = |workspace: Option<&str>, agent: Option<&str>, days| {
        query(
            &db,
            zone,
            enabled,
            "2026-11-12T12:00:00Z".parse().unwrap(),
            workspace.map(String::from),
            agent.map(String::from),
            days,
        )
        .unwrap()
    };
    assert_eq!(
        snapshot(Some("p1"), None, 7).days,
        [
            ("2026-11-10".into(), "120".into(), 0, 1),
            ("2026-11-11".into(), "230".into(), 0, 1),
        ]
    );
    assert_eq!(
        snapshot(None, Some("codeagent"), 7).days,
        [
            ("2026-11-11".into(), "230".into(), 0, 1),
            ("2026-11-12".into(), "0".into(), 1, 1),
        ]
    );
    assert_eq!(
        snapshot(Some("p2"), Some("chrys"), 7).days,
        [("2026-11-11".into(), "60".into(), 0, 1)]
    );
    assert!(snapshot(Some("unknown"), None, 7).days.is_empty());
    let recent = snapshot(Some("boundaries"), None, 7);
    let month = snapshot(Some("boundaries"), None, 30);
    assert_eq!(recent.days, month.days);
    assert_eq!(
        recent
            .models
            .iter()
            .map(|m| m.2.as_str())
            .collect::<Vec<_>>(),
        ["7"]
    );
    assert_eq!(
        month
            .models
            .iter()
            .map(|m| m.2.as_str())
            .collect::<Vec<_>>(),
        ["30", "8", "7"]
    );
}

#[test]
fn t01_t02_t03_t04_local_day_and_dst_boundaries() {
    let dir = Sandbox::new("time");
    let (db, zone, enabled) = open(&dir.0, "America/New_York", 1).unwrap();
    for (id, when) in [
        ("before-spring", "2026-03-08T04:59:59Z"),
        ("spring-start", "2026-03-08T05:00:00Z"),
        ("spring-end", "2026-03-09T03:59:59Z"),
        ("next-day", "2026-03-09T04:00:00Z"),
        ("fall-start", "2026-11-01T04:00:00Z"),
        ("fall-end", "2026-11-02T04:59:59Z"),
        ("after-fall", "2026-11-02T05:00:00Z"),
    ] {
        insert(&db, zone, enabled, row("p", "codeagent", id, when, Some(1))).unwrap();
    }
    drop(db);
    let (db, zone, enabled) = open(&dir.0, "Asia/Shanghai", 99).unwrap();
    assert_eq!((zone.name(), enabled), ("America/New_York", 1));
    let result = query(
        &db,
        zone,
        enabled,
        "2026-11-03T12:00:00Z".parse().unwrap(),
        None,
        None,
        7,
    )
    .unwrap();
    assert_eq!(
        result.days,
        [
            ("2026-03-07".into(), "1".into(), 0, 1),
            ("2026-03-08".into(), "2".into(), 0, 2),
            ("2026-03-09".into(), "1".into(), 0, 1),
            ("2026-11-01".into(), "2".into(), 0, 2),
            ("2026-11-02".into(), "1".into(), 0, 1),
        ]
    );
}

#[test]
fn s01_s02_s04_s06_s08_busy_atomic_rollback_and_parallel_writers() {
    let dir = Sandbox::new("writers");
    let (mut db, zone, enabled) = open(&dir.0, "UTC", 1).unwrap();
    let end = "2026-11-12T00:00:00Z";
    let (blocked, _, _) = open(&dir.0, "UTC", 99).unwrap();
    blocked.busy_timeout(Duration::from_millis(1)).unwrap();
    {
        let tx = db.transaction().unwrap();
        insert(
            &tx,
            zone,
            enabled,
            row("p", "codeagent", "uncommitted", end, Some(30)),
        )
        .unwrap();
        assert!(
            insert(
                &blocked,
                zone,
                enabled,
                row("p", "codeagent", "blocked", end, Some(1))
            )
            .is_err()
        );
        // Connection/transaction close without commit leaves neither record behind.
    }
    drop(blocked);
    drop(db);
    let start = Arc::new(Barrier::new(4));
    std::thread::scope(|scope| {
        for worker in 0..4 {
            let path = &dir.0;
            let start = start.clone();
            scope.spawn(move || {
                start.wait();
                let (db, zone, enabled) = open(path, "UTC", 99).unwrap();
                for id in 0..10 {
                    insert(
                        &db,
                        zone,
                        enabled,
                        row("p", "codeagent", &format!("{worker}-{id}"), end, Some(1)),
                    )
                    .unwrap();
                }
            });
        }
    });
    let (db, zone, enabled) = open(&dir.0, "UTC", 99).unwrap();
    let result = query(&db, zone, enabled, end.parse().unwrap(), None, None, 7).unwrap();
    assert_eq!(result.enabled_at, 1);
    assert_eq!(result.days, [("2026-11-12".into(), "40".into(), 0, 40)]);
}

#[test]
fn s09_s10_preserves_corrupt_future_and_failed_upgrade_databases() {
    let corrupt = Sandbox::new("corrupt");
    let payload = b"this is not a sqlite database";
    fs::write(corrupt.0.join(FILE), payload).unwrap();
    assert!(open(&corrupt.0, "UTC", 1).is_err());
    assert_eq!(fs::read(corrupt.0.join(FILE)).unwrap(), payload);
    let future = Sandbox::new("future");
    let db = Connection::open(future.0.join(FILE)).unwrap();
    db.execute_batch(
        "PRAGMA user_version = 99; CREATE TABLE sentinel(x); INSERT INTO sentinel VALUES(123);",
    )
    .unwrap();
    assert!(
        open(&future.0, "UTC", 1)
            .err()
            .unwrap()
            .contains("版本较新")
    );
    assert_eq!(
        db.query_row("SELECT x FROM sentinel", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        123
    );
    let upgrade = Sandbox::new("upgrade");
    let (db, _, _) = open(&upgrade.0, "UTC", 1).unwrap();
    db.execute_batch("PRAGMA user_version = 1; DROP TABLE usage_model_name;")
        .unwrap();
    // Duplicate accounting column makes ALTER fail after the alias table creation.
    assert!(open(&upgrade.0, "UTC", 1).is_err());
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='usage_model_name'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}

#[test]
fn g01_g02_counts_database_and_actual_sidecars() {
    let dir = Sandbox::new("bytes");
    assert_eq!(storage_bytes(&dir.0).unwrap(), 0);
    let (db, zone, enabled) = open(&dir.0, "UTC", 1).unwrap();
    db.pragma_update(None, "journal_mode", "WAL").unwrap();
    insert(
        &db,
        zone,
        enabled,
        row("p", "codeagent", "wal", "2026-11-12T00:00:00Z", Some(1)),
    )
    .unwrap();
    let main = fs::metadata(dir.0.join(FILE)).unwrap().len();
    let wal = fs::metadata(dir.0.join("usage.sqlite-wal")).unwrap().len();
    let shm = fs::metadata(dir.0.join("usage.sqlite-shm")).unwrap().len();
    assert!(wal > 0 && shm > 0);
    assert_eq!(storage_bytes(&dir.0).unwrap(), main + wal + shm);
}

#[test]
fn s06_child_leaves_an_uncommitted_transaction() {
    let Some(dir) = std::env::var_os("AAW_USAGE_TEST_CRASH_DIR") else {
        return;
    };
    let (mut db, zone, enabled) = open(Path::new(&dir), "UTC", 1).unwrap();
    let tx = db.transaction().unwrap();
    insert(
        &tx,
        zone,
        enabled,
        row("p", "chrys", "partial", "2026-11-12T00:00:00Z", Some(90)),
    )
    .unwrap();
    std::process::exit(29);
}

#[test]
fn s06_process_exit_without_commit_leaves_only_committed_turns() {
    let dir = Sandbox::new("crash");
    let end = "2026-11-12T00:00:00Z";
    let (db, zone, enabled) = open(&dir.0, "UTC", 1).unwrap();
    insert(
        &db,
        zone,
        enabled,
        row("p", "chrys", "committed", end, Some(10)),
    )
    .unwrap();
    drop(db);
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "usage_statistics::acceptance::s06_child_leaves_an_uncommitted_transaction",
        ])
        .env("AAW_USAGE_TEST_CRASH_DIR", &dir.0)
        .output()
        .unwrap();
    assert_eq!(child.status.code(), Some(29));
    let (db, zone, enabled) = open(&dir.0, "UTC", 1).unwrap();
    let snapshot = query(&db, zone, enabled, end.parse().unwrap(), None, None, 7).unwrap();
    assert_eq!(snapshot.days, [("2026-11-12".into(), "10".into(), 0, 1)]);
}
