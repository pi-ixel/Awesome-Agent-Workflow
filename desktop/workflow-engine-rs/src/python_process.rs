//! Execute the configured Python script without a shell. A timeout, lost
//! process or output overflow is an unknown outcome, never a successful scan.
use crate::{ProcessOutput, agent_process::ProcessGroup};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    path::Path,
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

const MAX_SCRIPT: u64 = 5 * 1024 * 1024;
const MAX_OUTPUT: usize = 4 * 1024 * 1024;

pub fn script_sha256(path: &Path) -> Result<String, String> {
    let metadata = std::fs::metadata(path).map_err(|e| format!("PYTHON_SCRIPT_UNAVAILABLE:{e}"))?;
    if !path.is_absolute() || !metadata.is_file() || metadata.len() > MAX_SCRIPT {
        return Err("INVALID_PYTHON_SCRIPT".into());
    }
    let bytes = std::fs::read(path).map_err(|e| format!("PYTHON_SCRIPT_UNAVAILABLE:{e}"))?;
    if bytes.len() as u64 > MAX_SCRIPT {
        return Err("INVALID_PYTHON_SCRIPT".into());
    }
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

pub fn execute(
    cwd: &Path,
    python: &str,
    argv: &[String],
    expected_sha256: &str,
    timeout: Duration,
    cancel: &AtomicBool,
) -> Result<ProcessOutput, String> {
    execute_with_input(cwd, python, argv, expected_sha256, timeout, cancel, None)
}

pub fn execute_with_input(
    cwd: &Path,
    python: &str,
    argv: &[String],
    expected_sha256: &str,
    timeout: Duration,
    cancel: &AtomicBool,
    input: Option<&[u8]>,
) -> Result<ProcessOutput, String> {
    if !cwd.is_absolute()
        || !cwd.is_dir()
        || python.trim().is_empty()
        || argv.is_empty()
        || timeout.is_zero()
    {
        return Err("INVALID_PYTHON_CONFIGURATION".into());
    }
    if input.is_some_and(|bytes| bytes.len() > MAX_OUTPUT) {
        return Err("PROCESS_INPUT_TOO_LARGE".into());
    }
    if script_sha256(Path::new(&argv[0]))? != expected_sha256 {
        return Err("PYTHON_SCRIPT_CHANGED".into());
    }
    if cancel.load(Ordering::SeqCst) {
        return Err("PYTHON_CANCELLED_BEFORE_START".into());
    }
    let mut command = Command::new(python);
    command
        .args(argv)
        .current_dir(cwd)
        .env("PYTHONUTF8", "1")
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("PYTHON_SPAWN_FAILED:{e}"))?;
    let group = match ProcessGroup::attach(child.id()) {
        Ok(g) => g,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    if let Some(input) = input {
        // Deliver bounded input on a worker, so a child that never reads stdin
        // cannot bypass the process timeout or block cancellation.
        let mut stdin = child.stdin.take().ok_or("PROCESS_STDIN_UNAVAILABLE")?;
        let bytes = input.to_vec();
        std::thread::spawn(move || {
            let _ = stdin.write_all(&bytes);
        });
    }
    let stdout = child.stdout.take().ok_or("PYTHON_STDOUT_UNAVAILABLE")?;
    let stderr = child.stderr.take().ok_or("PYTHON_STDERR_UNAVAILABLE")?;
    let count = Arc::new(AtomicUsize::new(0));
    let overflow = Arc::new(AtomicBool::new(false));
    let read =
        |mut stream: Box<dyn Read + Send>, count: Arc<AtomicUsize>, overflow: Arc<AtomicBool>| {
            std::thread::spawn(move || -> Result<Vec<u8>, String> {
                let mut output = Vec::new();
                let mut buf = [0u8; 8192];
                loop {
                    let size = stream
                        .read(&mut buf)
                        .map_err(|_| "PYTHON_OUTPUT_READ_FAILED")?;
                    if size == 0 {
                        break;
                    }
                    if count.fetch_add(size, Ordering::SeqCst).saturating_add(size) > MAX_OUTPUT {
                        overflow.store(true, Ordering::SeqCst);
                    } else {
                        output.extend_from_slice(&buf[..size]);
                    }
                }
                Ok(output)
            })
        };
    let out = read(Box::new(stdout), count.clone(), overflow.clone());
    let err = read(Box::new(stderr), count, overflow.clone());
    let start = Instant::now();
    let result = loop {
        if cancel.load(Ordering::SeqCst)
            || start.elapsed() >= timeout
            || overflow.load(Ordering::SeqCst)
        {
            break Err("PYTHON_OUTCOME_UNKNOWN".to_owned());
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                break status
                    .code()
                    .ok_or_else(|| "PYTHON_OUTCOME_UNKNOWN".to_owned());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => break Err("PYTHON_OUTCOME_UNKNOWN".into()),
        }
    };
    group.terminate();
    if result.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    let stdout = out.join().map_err(|_| "PYTHON_OUTPUT_THREAD_FAILED")??;
    let stderr = err.join().map_err(|_| "PYTHON_OUTPUT_THREAD_FAILED")??;
    let exit_code = result?;
    if overflow.load(Ordering::SeqCst) {
        return Err("PYTHON_OUTCOME_UNKNOWN".into());
    }
    Ok(ProcessOutput {
        exit_code,
        stdout: String::from_utf8(stdout).map_err(|_| "PYTHON_OUTPUT_NOT_UTF8")?,
        stderr: String::from_utf8(stderr).map_err(|_| "PYTHON_OUTPUT_NOT_UTF8")?,
    })
}
