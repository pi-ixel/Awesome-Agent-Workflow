//! Process-wide diagnostic sampler. It owns its timer and bounded in-memory history.
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessSample {
    pid: u32,
    parent_pid: u32,
    name: String,
    cpu_percent: Option<f64>,
    memory_bytes: Option<u64>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GroupSample {
    id: String,
    handle: Option<u32>,
    root_pid: u32,
    cpu_percent: Option<f64>,
    memory_bytes: Option<u64>,
    incomplete: bool,
    processes: Vec<ProcessSample>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GroupHistory {
    id: String,
    handle: Option<u32>,
    root_pid: u32,
    cpu_percent: Option<f64>,
    memory_bytes: Option<u64>,
    incomplete: bool,
}
#[derive(Clone, Serialize)]
struct Frame {
    at: u64,
    groups: Vec<GroupHistory>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitedAgent {
    handle: u32,
    pid: u32,
    observed_at: u64,
}
#[derive(Default)]
struct State {
    agents: HashMap<u32, (u32, Option<u64>, Option<usize>)>,
    groups: Vec<GroupSample>,
    history: VecDeque<Frame>,
    error: Option<String>,
    collection_ms: Option<u64>,
    exited: VecDeque<ExitedAgent>,
}
impl State {
    fn record(&mut self, at: u64, groups: Vec<GroupSample>) {
        while self
            .exited
            .front()
            .is_some_and(|item| at.saturating_sub(item.observed_at) > 15 * 60 * 1000)
        {
            self.exited.pop_front();
        }
        self.history.push_back(Frame {
            at,
            groups: groups
                .iter()
                .map(|g| GroupHistory {
                    id: g.id.clone(),
                    handle: g.handle,
                    root_pid: g.root_pid,
                    cpu_percent: g.cpu_percent,
                    memory_bytes: g.memory_bytes,
                    incomplete: g.incomplete,
                })
                .collect(),
        });
        while self
            .history
            .front()
            .is_some_and(|frame| at.saturating_sub(frame.at) > 15 * 60 * 1000)
            || self.history.len() > 450
        {
            self.history.pop_front();
        }
        self.groups = groups;
        self.error = None;
    }
}
fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(State::default()))
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn track_agent(handle: u32, pid: u32, job: Option<usize>) {
    let birth = platform::read_metrics(pid).and_then(|v| v.birth);
    if let Ok(mut state) = state().lock() {
        state.agents.insert(handle, (pid, birth, job));
    }
}
pub fn untrack_agent(handle: u32) {
    if let Ok(mut state) = state().lock() {
        state.agents.remove(&handle);
    }
}
pub fn agent_exited(handle: u32) {
    if let Ok(mut state) = state().lock() {
        if let Some(&(pid, _, _)) = state.agents.get(&handle) {
            state.exited.push_back(ExitedAgent {
                handle,
                pid,
                observed_at: now(),
            });
        }
    }
}

#[tauri::command]
pub fn diagnostics_resources(window: tauri::WebviewWindow) -> Result<serde_json::Value, String> {
    if window.label() != "diagnostics" && window.label() != "main" {
        return Err("无权读取进程资源".into());
    }
    let state = state().lock().map_err(|e| e.to_string())?;
    Ok(
        serde_json::json!({ "supported": cfg!(windows), "groups": state.groups,
        "history": state.history, "exited": state.exited, "error": state.error,
        "collectionMs": state.collection_ms }),
    )
}

pub fn start() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        #[cfg(windows)]
        if let Err(error) = std::thread::Builder::new()
            .name("diagnostics-resources".into())
            .spawn(run)
        {
            if let Ok(mut state) = state().lock() {
                state.error = Some(format!("无法启动资源采样：{error}"));
            }
        }
    });
}

#[cfg(windows)]
fn run() {
    let mut previous: HashMap<(u32, u64), (u64, Instant)> = HashMap::new();
    loop {
        let started = Instant::now();
        let agents = match state().lock() {
            Ok(state) => state.agents.clone(),
            Err(_) => return,
        };
        match platform::processes() {
            Ok(mut processes) => {
                let parents: HashMap<u32, u32> =
                    processes.iter().map(|p| (p.pid, p.parent)).collect();
                let roots: std::collections::HashSet<u32> = agents
                    .values()
                    .map(|(pid, _, _)| *pid)
                    .chain(std::iter::once(std::process::id()))
                    .collect();
                let mut members = HashMap::new();
                let mut unknown_jobs = std::collections::HashSet::new();
                for (&handle, &(_, _, job)) in &agents {
                    match job.and_then(platform::job_members) {
                        Some(pids) => {
                            for pid in pids {
                                members.insert(pid, handle);
                            }
                        }
                        None => {
                            unknown_jobs.insert(handle);
                        }
                    }
                }
                for process in &mut processes {
                    if members.contains_key(&process.pid) {
                        process.metrics = platform::read_metrics(process.pid);
                        continue;
                    }
                    let mut pid = process.pid;
                    let mut visited = std::collections::HashSet::new();
                    while visited.insert(pid) {
                        if roots.contains(&pid) {
                            process.metrics = platform::read_metrics(process.pid);
                            break;
                        }
                        match parents.get(&pid) {
                            Some(parent) if *parent != 0 && *parent != pid => pid = *parent,
                            _ => break,
                        }
                    }
                }
                let mut next_previous = HashMap::new();
                let mut groups = collect_groups(
                    &processes,
                    &agents,
                    &members,
                    &unknown_jobs,
                    &previous,
                    &mut next_previous,
                    started,
                );
                groups.sort_by(|a, b| a.id.cmp(&b.id));
                previous = next_previous;
                if let Ok(mut state) = state().lock() {
                    state.collection_ms = Some(started.elapsed().as_millis() as u64);
                    state.record(now(), groups);
                }
            }
            Err(error) => {
                if let Ok(mut state) = state().lock() {
                    state.error = Some(error);
                }
            }
        }
        std::thread::sleep(
            Duration::from_secs(2)
                .saturating_sub(started.elapsed())
                .max(Duration::from_millis(100)),
        );
    }
}

#[cfg(windows)]
fn collect_groups(
    processes: &[platform::Process],
    agents: &HashMap<u32, (u32, Option<u64>, Option<usize>)>,
    members: &HashMap<u32, u32>,
    unknown_jobs: &std::collections::HashSet<u32>,
    previous: &HashMap<(u32, u64), (u64, Instant)>,
    next_previous: &mut HashMap<(u32, u64), (u64, Instant)>,
    at: Instant,
) -> Vec<GroupSample> {
    let main = std::process::id();
    let by_pid: HashMap<u32, &platform::Process> = processes.iter().map(|p| (p.pid, p)).collect();
    let mut roots: HashMap<u32, u32> = HashMap::new();
    let candidate_roots: std::collections::HashSet<u32> =
        agents.values().map(|(pid, _, _)| *pid).collect();
    for (&handle, &(pid, birth, _)) in agents {
        if birth.is_some()
            && by_pid
                .get(&pid)
                .and_then(|p| p.metrics.as_ref())
                .and_then(|m| m.birth)
                == birth
        {
            roots.insert(pid, handle);
        }
    }
    let mut groups = HashMap::<String, GroupSample>::new();
    for (&handle, &(pid, _, _)) in agents {
        if !roots.contains_key(&pid) && !members.values().any(|owner| *owner == handle) {
            let id = format!("agent:{handle}");
            groups.insert(
                id.clone(),
                GroupSample {
                    id,
                    handle: Some(handle),
                    root_pid: pid,
                    cpu_percent: None,
                    memory_bytes: None,
                    incomplete: true,
                    processes: Vec::new(),
                },
            );
        }
    }
    for process in processes {
        let mut pid = process.pid;
        let mut visited = std::collections::HashSet::new();
        let owner = if let Some(&handle) = members.get(&pid) {
            agents
                .get(&handle)
                .map(|(root, _, _)| (format!("agent:{handle}"), Some(handle), *root))
        } else {
            loop {
                if !visited.insert(pid) {
                    break None;
                }
                if let Some(&handle) = roots.get(&pid) {
                    break Some((format!("agent:{handle}"), Some(handle), pid));
                }
                // An unverified or recycled agent PID must never be charged to Desktop.
                if candidate_roots.contains(&pid) {
                    break None;
                }
                if pid == main {
                    break Some(("desktop".to_string(), None, main));
                }
                match by_pid.get(&pid) {
                    Some(parent) if parent.parent != pid && parent.parent != 0 => {
                        pid = parent.parent
                    }
                    _ => break None,
                }
            }
        };
        let Some((id, handle, root_pid)) = owner else {
            continue;
        };
        let cpu_percent = process.metrics.as_ref().and_then(|metrics| {
            let birth = metrics.birth?;
            let total = metrics.cpu?;
            let old = previous.get(&(process.pid, birth));
            next_previous.insert((process.pid, birth), (total, at));
            let (previous_total, previous_at) = old?;
            let elapsed = at.duration_since(*previous_at).as_secs_f64();
            let cpus = platform::cpu_count() as f64;
            (elapsed > 0.0).then(|| {
                ((total.saturating_sub(*previous_total) as f64) / 10_000_000.0 / elapsed / cpus
                    * 100.0)
                    .clamp(0.0, 100.0)
            })
        });
        let memory_bytes = process.metrics.as_ref().and_then(|m| m.memory);
        let group = groups.entry(id.clone()).or_insert_with(|| GroupSample {
            id,
            handle,
            root_pid,
            cpu_percent: Some(0.0),
            memory_bytes: Some(0),
            incomplete: false,
            processes: Vec::new(),
        });
        group.cpu_percent = group.cpu_percent.zip(cpu_percent).map(|(a, b)| a + b);
        group.memory_bytes = group
            .memory_bytes
            .zip(memory_bytes)
            .map(|(a, b)| a.saturating_add(b));
        group.incomplete |= cpu_percent.is_none()
            || memory_bytes.is_none()
            || handle.is_some_and(|h| unknown_jobs.contains(&h));
        group.processes.push(ProcessSample {
            pid: process.pid,
            parent_pid: process.parent,
            name: process.name.clone(),
            cpu_percent,
            memory_bytes,
        });
    }
    groups.into_values().collect()
}

#[cfg(windows)]
mod platform {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, FILETIME, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
                TH32CS_SNAPPROCESS,
            },
            JobObjects::{
                JOBOBJECT_BASIC_PROCESS_ID_LIST, JobObjectBasicProcessIdList,
                QueryInformationJobObject,
            },
            ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS},
            Threading::{
                ALL_PROCESSOR_GROUPS, GetActiveProcessorCount, GetProcessTimes, OpenProcess,
                PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
            },
        },
    };
    pub struct Metrics {
        pub birth: Option<u64>,
        pub cpu: Option<u64>,
        pub memory: Option<u64>,
    }
    pub struct Process {
        pub pid: u32,
        pub parent: u32,
        pub name: String,
        pub metrics: Option<Metrics>,
    }
    fn ticks(time: FILETIME) -> u64 {
        ((time.dwHighDateTime as u64) << 32) | time.dwLowDateTime as u64
    }
    pub fn cpu_count() -> u32 {
        unsafe { GetActiveProcessorCount(ALL_PROCESSOR_GROUPS) }.max(1)
    }
    pub fn job_members(job: usize) -> Option<Vec<u32>> {
        let mut capacity = 32usize;
        while capacity <= 8192 {
            let bytes = 8 + capacity * size_of::<usize>();
            let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
            let list = storage
                .as_mut_ptr()
                .cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>();
            let success = unsafe {
                QueryInformationJobObject(
                    job as _,
                    JobObjectBasicProcessIdList,
                    list.cast(),
                    bytes as u32,
                    std::ptr::null_mut(),
                )
            };
            if success != 0 {
                let count = unsafe { (*list).NumberOfProcessIdsInList as usize };
                if count > capacity {
                    return None;
                }
                let ids =
                    unsafe { std::slice::from_raw_parts((*list).ProcessIdList.as_ptr(), count) };
                return Some(
                    ids.iter()
                        .filter_map(|id| u32::try_from(*id).ok())
                        .collect(),
                );
            }
            capacity *= 2;
        }
        None
    }
    pub fn read_metrics(pid: u32) -> Option<Metrics> {
        unsafe {
            let mut handle =
                OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid);
            if handle.is_null() {
                handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            }
            if handle.is_null() {
                return None;
            }
            let (mut birth, mut exit, mut kernel, mut user) =
                (zeroed(), zeroed(), zeroed(), zeroed());
            let has_times =
                GetProcessTimes(handle, &mut birth, &mut exit, &mut kernel, &mut user) != 0;
            let mut memory: PROCESS_MEMORY_COUNTERS = zeroed();
            memory.cb = size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
            let has_memory = K32GetProcessMemoryInfo(handle, &mut memory, memory.cb) != 0;
            CloseHandle(handle);
            Some(Metrics {
                birth: has_times.then(|| ticks(birth)),
                cpu: has_times.then(|| ticks(kernel).saturating_add(ticks(user))),
                memory: has_memory.then_some(memory.WorkingSetSize as u64),
            })
        }
    }
    pub fn processes() -> Result<Vec<Process>, String> {
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return Err("无法读取系统进程列表".into());
            }
            let mut entry: PROCESSENTRY32W = zeroed();
            entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
            let mut ok = Process32FirstW(snapshot, &mut entry);
            let mut result = Vec::new();
            while ok != 0 {
                let len = entry
                    .szExeFile
                    .iter()
                    .position(|c| *c == 0)
                    .unwrap_or(entry.szExeFile.len());
                result.push(Process {
                    pid: entry.th32ProcessID,
                    parent: entry.th32ParentProcessID,
                    name: String::from_utf16_lossy(&entry.szExeFile[..len]),
                    metrics: None,
                });
                ok = Process32NextW(snapshot, &mut entry);
            }
            CloseHandle(snapshot);
            Ok(result)
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn retains_only_recent_bounded_samples_and_exit_records() {
        let mut state = State::default();
        state.exited.push_back(ExitedAgent {
            handle: 1,
            pid: 2,
            observed_at: 1,
        });
        for index in 0..=450 {
            state.record(index * 2000, Vec::new());
        }
        assert_eq!(state.history.len(), 450);
        assert_eq!(state.history.front().unwrap().at, 2000);
        assert_eq!(state.exited.len(), 1);
        state.record(900_002, Vec::new());
        assert!(state.exited.is_empty());
    }
    fn process(pid: u32, parent: u32, birth: u64, cpu: u64, memory: u64) -> platform::Process {
        platform::Process {
            pid,
            parent,
            name: format!("p{pid}"),
            metrics: Some(platform::Metrics {
                birth: Some(birth),
                cpu: Some(cpu),
                memory: Some(memory),
            }),
        }
    }
    #[test]
    fn assigns_agent_descendants_once_and_rejects_reused_root_pid() {
        let main = std::process::id();
        let root = u32::MAX - 1;
        let child = u32::MAX - 2;
        let processes = vec![
            process(main, 0, 1, 10, 100),
            process(root, main, 2, 10, 200),
            process(child, root, 3, 10, 300),
        ];
        let at = Instant::now();
        let mut next = HashMap::new();
        let mut agents = HashMap::from([(7, (root, Some(2), None))]);
        let groups = collect_groups(
            &processes,
            &agents,
            &HashMap::new(),
            &Default::default(),
            &HashMap::new(),
            &mut next,
            at,
        );
        let desktop = groups.iter().find(|g| g.id == "desktop").unwrap();
        let agent = groups.iter().find(|g| g.id == "agent:7").unwrap();
        assert_eq!(desktop.memory_bytes, Some(100));
        assert_eq!(agent.memory_bytes, Some(500));
        assert_eq!(agent.processes.len(), 2);
        assert!(agent.cpu_percent.is_none());
        let mut after = HashMap::new();
        let second = collect_groups(
            &processes,
            &agents,
            &HashMap::new(),
            &Default::default(),
            &next,
            &mut after,
            at + Duration::from_secs(2),
        );
        assert_eq!(
            second
                .iter()
                .find(|g| g.id == "agent:7")
                .unwrap()
                .cpu_percent,
            Some(0.0)
        );
        agents.insert(7, (root, Some(999), None));
        let reused = collect_groups(
            &processes,
            &agents,
            &HashMap::new(),
            &Default::default(),
            &next,
            &mut HashMap::new(),
            at + Duration::from_secs(2),
        );
        assert!(
            reused
                .iter()
                .find(|g| g.id == "agent:7")
                .unwrap()
                .incomplete
        );
        assert_eq!(
            reused
                .iter()
                .find(|g| g.id == "desktop")
                .unwrap()
                .memory_bytes,
            Some(100)
        );
        let orphan = vec![process(main, 0, 1, 10, 100), process(child, 0, 3, 10, 300)];
        let job_members = HashMap::from([(child, 7)]);
        let groups = collect_groups(
            &orphan,
            &agents,
            &job_members,
            &Default::default(),
            &next,
            &mut HashMap::new(),
            at + Duration::from_secs(2),
        );
        assert_eq!(
            groups
                .iter()
                .find(|g| g.id == "agent:7")
                .unwrap()
                .memory_bytes,
            Some(300)
        );
    }

    #[test]
    fn samples_a_real_windows_child_tree() {
        use std::os::windows::process::CommandExt;
        let mut child = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "ping -n 3 127.0.0.1 >nul"])
            .creation_flags(0x0800_0000)
            .spawn()
            .unwrap();
        let root = child.id();
        let birth = platform::read_metrics(root).and_then(|m| m.birth).unwrap();
        let job = crate::acp_process::assign_kill_on_close_job(root).expect("job assignment");
        let agents = HashMap::from([(8, (root, Some(birth), Some(job)))]);
        let deadline = Instant::now() + Duration::from_secs(3);
        let found = loop {
            let mut processes = platform::processes().unwrap();
            let members: HashMap<u32, u32> = platform::job_members(job)
                .unwrap()
                .into_iter()
                .map(|pid| (pid, 8))
                .collect();
            let parents: HashMap<u32, u32> = processes.iter().map(|p| (p.pid, p.parent)).collect();
            for p in &mut processes {
                let mut pid = p.pid;
                for _ in 0..32 {
                    if members.contains_key(&p.pid) || pid == root || pid == std::process::id() {
                        p.metrics = platform::read_metrics(p.pid);
                        break;
                    }
                    let Some(&parent) = parents.get(&pid) else {
                        break;
                    };
                    if parent == pid || parent == 0 {
                        break;
                    }
                    pid = parent;
                }
            }
            let groups = collect_groups(
                &processes,
                &agents,
                &members,
                &Default::default(),
                &HashMap::new(),
                &mut HashMap::new(),
                Instant::now(),
            );
            if let Some(group) = groups.iter().find(|g| g.id == "agent:8") {
                if group.processes.len() >= 2 && group.memory_bytes.is_some() {
                    break true;
                }
            }
            if Instant::now() >= deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        let _ = child.wait();
        assert!(
            found,
            "agent and its child should appear in the same resource group"
        );
    }

    #[test]
    fn measures_snapshot_collection_cost() {
        let started = Instant::now();
        let processes = platform::processes().unwrap();
        let enumeration = started.elapsed();
        let metrics_start = Instant::now();
        for _ in 0..100 {
            assert!(platform::read_metrics(std::process::id()).is_some());
        }
        eprintln!(
            "processes={} enumeration_ms={:.3} self_metrics_mean_ms={:.3}",
            processes.len(),
            enumeration.as_secs_f64() * 1000.0,
            metrics_start.elapsed().as_secs_f64() * 10.0
        );
    }

    #[test]
    fn reads_cpu_time_from_a_busy_windows_process() {
        use std::os::windows::process::CommandExt;
        let mut child = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command",
                "$end=[DateTime]::UtcNow.AddSeconds(2); while ([DateTime]::UtcNow -lt $end) { $n=123*456 }"])
            .creation_flags(0x0800_0000)
            .spawn().unwrap();
        let before = platform::read_metrics(child.id())
            .and_then(|m| m.cpu)
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(4);
        let mut increased = false;
        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
            if platform::read_metrics(child.id())
                .and_then(|m| m.cpu)
                .is_some_and(|value| value > before)
            {
                increased = true;
                break;
            }
        }
        let _ = child.wait();
        assert!(increased, "a busy process should accumulate CPU time");
    }
}

#[cfg(not(windows))]
mod platform {
    pub struct Metrics {
        pub birth: Option<u64>,
    }
    pub fn read_metrics(_pid: u32) -> Option<Metrics> {
        None
    }
}
