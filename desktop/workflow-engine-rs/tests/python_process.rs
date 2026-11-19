use aaw_workflow_core::python_process::{execute, script_sha256};
use std::{
    sync::atomic::AtomicBool,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[test]
#[ignore = "requires Python; run explicitly for subprocess smoke"]
fn actual_script_exit_hash_and_timeout_are_distinguished() {
    let name = format!(
        "aaw-scan-{}-{}.py",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let path = std::env::temp_dir().join(name);
    std::fs::write(
        &path,
        "import sys\nprint('scan output')\nprint('diagnostic', file=sys.stderr)\nsys.exit(7)\n",
    )
    .unwrap();
    let hash = script_sha256(&path).unwrap();
    let args = vec![path.to_str().unwrap().to_string()];
    let result = execute(
        path.parent().unwrap(),
        "python",
        &args,
        &hash,
        Duration::from_secs(5),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(result.exit_code, 7);
    assert!(result.stdout.contains("scan output"));
    assert!(result.stderr.contains("diagnostic"));
    std::fs::write(&path, "import time\ntime.sleep(5)\n").unwrap();
    assert_eq!(
        execute(
            path.parent().unwrap(),
            "python",
            &args,
            &hash,
            Duration::from_secs(1),
            &AtomicBool::new(false)
        )
        .unwrap_err(),
        "PYTHON_SCRIPT_CHANGED"
    );
    let new_hash = script_sha256(&path).unwrap();
    assert_eq!(
        execute(
            path.parent().unwrap(),
            "python",
            &args,
            &new_hash,
            Duration::from_millis(200),
            &AtomicBool::new(false)
        )
        .unwrap_err(),
        "PYTHON_OUTCOME_UNKNOWN"
    );
    std::fs::remove_file(path).unwrap();
}
