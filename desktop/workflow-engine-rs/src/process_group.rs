//! 进程树收口：脚本节点的子进程（及其子孙）随节点结束一并终止。
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
