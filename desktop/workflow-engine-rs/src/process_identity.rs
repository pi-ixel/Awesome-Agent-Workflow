//! Process identity for lease recovery. PID alone is insufficient because the
//! OS can reuse it. Unknown or inaccessible processes fail closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessState {
    AliveSame,
    Exited,
    Reused,
}

#[cfg(windows)]
fn inspect(pid: u32) -> Result<Option<(u64, bool)>, String> {
    type Handle = *mut core::ffi::c_void;
    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn GetProcessTimes(
            h: Handle,
            created: *mut FileTime,
            exited: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
        fn GetExitCodeProcess(h: Handle, code: *mut u32) -> i32;
        fn CloseHandle(h: Handle) -> i32;
    }
    unsafe {
        let handle = OpenProcess(0x1000, 0, pid);
        if handle.is_null() {
            return if std::io::Error::last_os_error().raw_os_error() == Some(87) {
                Ok(None)
            } else {
                Err("PROCESS_IDENTITY_UNAVAILABLE".into())
            };
        }
        let mut created = FileTime { low: 0, high: 0 };
        let mut exited = FileTime { low: 0, high: 0 };
        let mut kernel = FileTime { low: 0, high: 0 };
        let mut user = FileTime { low: 0, high: 0 };
        let mut code = 0u32;
        let success = GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user)
            != 0
            && GetExitCodeProcess(handle, &mut code) != 0;
        CloseHandle(handle);
        if !success {
            return Err("PROCESS_IDENTITY_UNAVAILABLE".into());
        }
        Ok(Some((
            ((created.high as u64) << 32) | created.low as u64,
            code == 259,
        )))
    }
}

#[cfg(target_os = "linux")]
fn inspect(pid: u32) -> Result<Option<(u64, bool)>, String> {
    let stat = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("PROCESS_IDENTITY_UNAVAILABLE".into()),
    };
    let fields = stat
        .rsplit_once(") ")
        .ok_or("PROCESS_IDENTITY_UNAVAILABLE")?
        .1
        .split_whitespace()
        .collect::<Vec<_>>();
    let state = fields.first().ok_or("PROCESS_IDENTITY_UNAVAILABLE")?;
    let start = fields
        .get(19)
        .ok_or("PROCESS_IDENTITY_UNAVAILABLE")?
        .parse::<u64>()
        .map_err(|_| "PROCESS_IDENTITY_UNAVAILABLE")?;
    Ok(Some((start, *state != "Z" && *state != "X")))
}

#[cfg(not(any(windows, target_os = "linux")))]
fn inspect(_: u32) -> Result<Option<(u64, bool)>, String> {
    Err("PROCESS_IDENTITY_UNSUPPORTED".into())
}

pub fn identity(pid: u32) -> Result<u64, String> {
    match inspect(pid)? {
        Some((start, true)) => Ok(start),
        _ => Err("PROCESS_NOT_RUNNING".into()),
    }
}

pub fn verify(pid: u32, expected: u64) -> Result<ProcessState, String> {
    Ok(match inspect(pid)? {
        None | Some((_, false)) => ProcessState::Exited,
        Some((start, true)) if start == expected => ProcessState::AliveSame,
        Some(_) => ProcessState::Reused,
    })
}
