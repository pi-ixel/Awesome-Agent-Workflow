//! Read-only checks shared by the launch preview and actual start.
use aaw_workflow_core::{graph::Definition, question_pool::tracker_start_params, runtime::RuntimeConfig};
use serde_json::{Value, json};
use std::{collections::BTreeSet, path::{Path, PathBuf}, process::{Command, Stdio}, thread, time::{Duration, Instant}};

fn item(id: &str, label: &str, status: &str, message: &str, hint: &str) -> Value {
    json!({"id": id, "label": label, "status": status, "message": message, "hint": hint})
}

pub fn preparation_error(error: &str) -> Value {
    let (id, label, hint) = if error == "ACP_COMMAND_REQUIRED" {
        ("agent", "节点 Agent", "在设置中选择并配置 ACP Agent。")
    } else if error == "INVALID_ARGUMENT" {
        ("workspace", "项目和启动参数", "检查项目目录及启动表单。")
    } else {
        ("workflow", "工作流定义与文件", "检查工作流定义、输入及包内文件。")
    };
    json!({"items": [item(id, label, "fail", error, hint)]})
}

/// Searches the service process environment, matching the execution context.
fn executable_exists(program: &str, cwd: &Path) -> bool {
    if program.trim().is_empty() { return false; }
    let path = Path::new(program);
    let bases: Vec<PathBuf> = if path.is_absolute() || path.components().count() > 1 {
        vec![if path.is_absolute() { path.to_owned() } else { cwd.join(path) }]
    } else {
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|dir| dir.join(path)).collect()
    };
    bases.into_iter().any(|base| {
        let mut candidates = vec![base.clone()];
        #[cfg(windows)]
        if base.extension().is_none() {
            for ext in ["exe", "com", "cmd", "bat"] { candidates.push(base.with_extension(ext)); }
        }
        candidates.into_iter().any(|candidate| {
            if !candidate.is_file() { return false; }
            #[cfg(unix)]
            { use std::os::unix::fs::PermissionsExt; candidate.metadata().is_ok_and(|m| m.permissions().mode() & 0o111 != 0) }
            #[cfg(not(unix))]
            { true }
        })
    })
}

/// Conservatively follow all possible routes and calls, without guessing conditions.
fn python_usage(definition: &Definition) -> (bool, bool) {
    let possible = definition.has_reachable_kind("python");
    // A chain with one unconditional route cannot avoid a ready Python node.
    // Calls and conditional routes remain uncertain instead of blocking startup.
    let mut cursor = definition.entry.as_str();
    let mut straight = BTreeSet::new();
    let mut required_now = false;
    while straight.insert(cursor.to_owned()) {
        let Some(phase) = definition.phases.get(cursor) else { break };
        if phase.run.iter().any(|name| {
            definition.nodes.get(name).is_some_and(|node| node.kind == "python" && node.requires.is_empty()) &&
                !phase.edges.iter().any(|edge| &edge.to == name)
        }) { required_now = true; break; }
        if phase.call.is_some() || phase.run.iter().any(|name| definition.nodes.get(name).is_some_and(|node| node.kind == "flow")) ||
            phase.routes.len() != 1 || phase.routes[0].when.is_some() { break; }
        cursor = &phase.routes[0].next;
    }
    (possible, required_now)
}

enum PythonProbe { Ready, Missing, Unknown }
fn probe_python(program: &str, cwd: &Path) -> PythonProbe {
    if !executable_exists(program, cwd) { return PythonProbe::Missing; }
    let mut command = Command::new(program);
    command.arg("--version").current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let Ok(mut child) = command.spawn() else { return PythonProbe::Missing };
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return if status.success() { PythonProbe::Ready } else { PythonProbe::Missing },
            Ok(None) if started.elapsed() < Duration::from_secs(2) => thread::sleep(Duration::from_millis(20)),
            _ => { let _ = child.kill(); let _ = child.wait(); return PythonProbe::Unknown; }
        }
    }
}

pub fn check(definition: &Definition, config: &RuntimeConfig) -> Value {
    let mut items = vec![
        item("workflow", "工作流定义与文件", "pass", "定义和包内文件已检查", ""),
        item("workspace", "项目目录", "pass", "已找到项目目录", ""),
    ];
    if definition.has_reachable_kind("agent") {
        let found = config.command.first().is_some_and(|command| executable_exists(command, &config.cwd));
        items.push(if found { item("agent", "节点 Agent", "pass", "已找到 Agent 启动程序；连接状态需运行时确认", "") }
            else { item("agent", "节点 Agent", "fail", "找不到 Agent 启动程序", "在设置中检查 Agent 的启动命令。") });
        items.push(if tracker_start_params(&config.cwd, "preflight", None).is_ok() {
            item("question_tracker", "问题池", "pass", "已找到问题池程序", "")
        } else { item("question_tracker", "问题池", "fail", "找不到问题池程序", "修复或重新安装应用。") });
    }
    let (possible, required_now) = python_usage(definition);
    if possible {
        match probe_python(&config.python, &config.cwd) {
            PythonProbe::Ready => items.push(item("python", "Python", "pass", "Python 命令可用", "")),
            PythonProbe::Missing if required_now => items.push(item("python", "Python", "fail", "这条流程需要 Python，但无法启动", "安装 Python 并检查运行环境中的命令。")),
            PythonProbe::Missing => items.push(item("python_conditional", "Python", "warn", "后续步骤可能需要 Python，但当前无法启动", "如进入相关步骤，需先配置 Python。")),
            PythonProbe::Unknown => items.push(item("python_unknown", "Python", "warn", "Python 检查超时，无法确认是否可用", "检查 Python 命令后重试，或知情继续。")),
        }
    }
    json!({"revision": definition.revision_label(), "items": items})
}
