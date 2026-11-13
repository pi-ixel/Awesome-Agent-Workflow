//! Supervised ACP child. A process belongs to one actor and may serve multiple
//! turns, so repairs and re-reviews keep the same ACP session.
//!
//! This layer does not implement Desktop routing or run cancellation; a host
//! must keep the child owned for the entire run and must not assume a lost
//! connection means a turn did not execute.
//! ADR 023 P4：会话内容缓冲（Collecting/last_agent_text）已删除——事件
//! 全量交给宿主的 Events 实现处理，引擎侧不再留存任何会话文本。
use crate::acp::{Events, Session};
use crate::result_channel::ResultChannelOffer;
use serde_json::{Value, json};
use std::{
    io::{BufReader, Read},
    path::Path,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

pub struct AgentProcess<E: Events> {
    child: Child,
    session: Session<BufReader<ChildStdout>, ChildStdin, E>,
    group: Arc<ProcessGroup>,
}

impl<E: Events> AgentProcess<E> {
    pub fn start(
        command: &[String],
        cwd: &Path,
        mcp_servers: Value,
        result_channel: Option<&ResultChannelOffer>,
        restored_session: Option<&str>,
        profile: Option<&str>,
        events: E,
    ) -> Result<Self, String> {
        Self::start_cancellable(
            command,
            cwd,
            mcp_servers,
            result_channel,
            restored_session,
            profile,
            events,
            Arc::new(AtomicBool::new(false)),
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn start_cancellable(
        command: &[String],
        cwd: &Path,
        mcp_servers: Value,
        result_channel: Option<&ResultChannelOffer>,
        restored_session: Option<&str>,
        profile: Option<&str>,
        events: E,
        cancel: Arc<AtomicBool>,
    ) -> Result<Self, String> {
        if cancel.load(Ordering::SeqCst) {
            return Err("ACP_CANCELLED_BEFORE_START".into());
        }
        let (program, args) = command
            .split_first()
            .filter(|(p, _)| !p.trim().is_empty())
            .ok_or("ACP_COMMAND_REQUIRED")?;
        if !cwd.is_absolute() || !cwd.is_dir() || !mcp_servers.is_array() {
            return Err("ACP_PROCESS_CONFIGURATION_INVALID".into());
        }
        let mut command = Command::new(program);
        command
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
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
            .map_err(|e| format!("ACP_SPAWN_FAILED:{e}"))?;
        let group = match ProcessGroup::attach(child.id()) {
            Ok(g) => g,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e);
            }
        };
        let stdin = child.stdin.take().ok_or("ACP_STDIN_UNAVAILABLE")?;
        let stdout = child.stdout.take().ok_or("ACP_STDOUT_UNAVAILABLE")?;
        if let Some(mut stderr) = child.stderr.take() {
            // Drain to avoid child deadlock. Do not log uncontrolled output,
            // which can contain tokens or MCP credentials.
            std::thread::spawn(move || {
                let mut buffer = [0u8; 8192];
                while matches!(stderr.read(&mut buffer), Ok(n) if n > 0) {}
            });
        }
        let session = Session::new(BufReader::new(stdout), stdin, events);
        let mut process = Self {
            child,
            session,
            group: Arc::new(group),
        };
        let finished = Arc::new(AtomicBool::new(false));
        let watcher_finished = finished.clone();
        let group = process.group.clone();
        let watcher_cancel = cancel.clone();
        let watcher = std::thread::spawn(move || {
            let start = std::time::Instant::now();
            while !watcher_finished.load(Ordering::SeqCst) {
                if watcher_cancel.load(Ordering::SeqCst)
                    || start.elapsed() > Duration::from_secs(120)
                {
                    group.terminate();
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        let initialized: Result<(), String> = (|| {
            process.session.initialize()?;
            // ADR 024 §9-3：结果通道按 Agent 声明的能力选定一种传输
            // （ResultChannelOffer::mcp_server，与 Desktop 宿主同一规则）。
            let mut mcp_servers = mcp_servers;
            if let Some(offer) = result_channel {
                mcp_servers
                    .as_array_mut()
                    .ok_or("ACP_PROCESS_CONFIGURATION_INVALID")?
                    .push(offer.mcp_server(process.session.http_mcp));
            }
            let cwd = cwd.to_str().ok_or("ACP_CWD_NOT_UTF8")?;
            if let Some(id) = restored_session {
                process.session.load_session(id, cwd, mcp_servers)?;
            } else {
                let session_id = process.session.new_session(cwd, mcp_servers)?;
                if let Some(profile) = profile {
                    let response = process.session.request_extension(
                        "_session/switch_agent",
                        json!({"sessionId":session_id,"agentProfile":profile}),
                    )?;
                    if response["toProfile"].as_str().is_none_or(str::is_empty) {
                        return Err("ACP_PROFILE_SWITCH_UNCONFIRMED".into());
                    }
                }
            }
            Ok(())
        })();
        finished.store(true, Ordering::SeqCst);
        let _ = watcher.join();
        if cancel.load(Ordering::SeqCst) {
            return Err("ACP_CANCELLED_DURING_START".into());
        }
        initialized?;
        Ok(process)
    }

    pub fn session_id(&self) -> &str {
        self.session
            .session_id
            .as_deref()
            .expect("initialized session")
    }

    pub fn prompt_text_cancellable(
        &mut self,
        prompt: &str,
        cancel: Arc<AtomicBool>,
    ) -> Result<(), String> {
        if cancel.load(Ordering::SeqCst) {
            return Err("ACP_CANCELLED_BEFORE_PROMPT".into());
        }
        let finished = Arc::new(AtomicBool::new(false));
        let watcher_finished = finished.clone();
        let group = self.group.clone();
        let watcher_cancel = cancel.clone();
        let watcher = std::thread::spawn(move || {
            while !watcher_finished.load(Ordering::SeqCst) {
                if watcher_cancel.load(Ordering::SeqCst) {
                    group.terminate();
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        let result = self.session.prompt(prompt);
        finished.store(true, Ordering::SeqCst);
        let _ = watcher.join();
        if cancel.load(Ordering::SeqCst) {
            return Err("ACP_TURN_CANCELLED_OUTCOME_UNKNOWN".into());
        }
        result?;
        Ok(())
    }
}

impl<E: Events> Drop for AgentProcess<E> {
    fn drop(&mut self) {
        self.group.terminate();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}


#[cfg(windows)]
pub(crate) struct ProcessGroup(usize);
#[cfg(windows)]
impl ProcessGroup {
    pub(crate) fn attach(pid: u32) -> Result<Self, String> {
        type Handle = *mut core::ffi::c_void;
        #[repr(C)]
        struct Io {
            read_count: u64,
            write_count: u64,
            other_count: u64,
            read_bytes: u64,
            write_bytes: u64,
            other_bytes: u64,
        }
        #[repr(C)]
        struct Basic {
            process_time: i64,
            job_time: i64,
            flags: u32,
            min: usize,
            max: usize,
            limit: u32,
            affinity: usize,
            priority: u32,
            scheduling: u32,
        }
        #[repr(C)]
        struct Extended {
            basic: Basic,
            io: Io,
            process_memory: usize,
            job_memory: usize,
            peak_process: usize,
            peak_job: usize,
        }
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn CreateJobObjectW(a: *const core::ffi::c_void, n: *const u16) -> Handle;
            fn SetInformationJobObject(
                j: Handle,
                c: i32,
                i: *const core::ffi::c_void,
                n: u32,
            ) -> i32;
            fn OpenProcess(a: u32, i: i32, p: u32) -> Handle;
            fn AssignProcessToJobObject(j: Handle, p: Handle) -> i32;
            fn CloseHandle(h: Handle) -> i32;
        }
        unsafe {
            let job = CreateJobObjectW(core::ptr::null(), core::ptr::null());
            if job.is_null() {
                return Err("ACP_PROCESS_GROUP_CREATE_FAILED".into());
            }
            let mut limits: Extended = core::mem::zeroed();
            limits.basic.flags = 0x00002000;
            let configured = SetInformationJobObject(
                job,
                9,
                &limits as *const _ as *const _,
                core::mem::size_of::<Extended>() as u32,
            ) != 0;
            let process = OpenProcess(0x0100 | 0x0001, 0, pid);
            let assigned =
                configured && !process.is_null() && AssignProcessToJobObject(job, process) != 0;
            if !process.is_null() {
                CloseHandle(process);
            }
            if !assigned {
                CloseHandle(job);
                return Err("ACP_PROCESS_GROUP_ASSIGN_FAILED".into());
            }
            Ok(Self(job as usize))
        }
    }
    pub(crate) fn terminate(&self) {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn TerminateJobObject(j: *mut core::ffi::c_void, code: u32) -> i32;
        }
        unsafe {
            TerminateJobObject(self.0 as *mut _, 1);
        }
    }
}
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn CloseHandle(h: *mut core::ffi::c_void) -> i32;
        }
        unsafe {
            CloseHandle(self.0 as *mut _);
        }
    }
}
#[cfg(unix)]
pub(crate) struct ProcessGroup(i32);
#[cfg(unix)]
impl ProcessGroup {
    pub(crate) fn attach(pid: u32) -> Result<Self, String> {
        i32::try_from(pid)
            .map(Self)
            .map_err(|_| "ACP_INVALID_PID".into())
    }
    pub(crate) fn terminate(&self) {
        unsafe extern "C" {
            fn kill(pid: i32, signal: i32) -> i32;
        }
        if self.0 > 1 {
            unsafe {
                kill(-self.0, 9);
            }
        }
    }
}
