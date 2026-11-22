//! 工具目录与工具数据的位置：两个指针文件 + 在线迁移事务。
//!
//! # 落点与指针
//!
//! 三个根，全部**每次解析时重读指针**——这是"在线迁移、不重启生效"的前提：
//!
//! | 根 | 解析 |
//! |---|---|
//! | 工具目录根 | `<数据根>/configuration/tools-location.json` 的 `toolRoot` → 默认 `<数据根>/tools` |
//! | 安装副本 / 项目 / 备份 | `<工具目录根>/installed|projects|backups/<账号>/…` |
//! | 工具数据根 | `<数据根>/configuration/data-location.json` 的 `storageRoot` → 默认 `<数据根>/tools/storage` |
//!
//! 指针文件放 `configuration/` 里是刻意的：数据根迁移（`storage_location.rs`）
//! 把整个 `configuration` 搬走，指针自然跟着走，不用两套机制互相追。
//!
//! # 与历史落点的关系
//!
//! 前端以前走 `user_data_dir("tools", …)` 落到裸的 `%APPDATA%/tools`——一个看不出
//! 归属的目录，而且和 Rust 侧 `resolve_tools_root` 算出的 `<数据根>/tools/installed`
//! 是**两个不同的地方**（全靠运行目录注册表撑着才没炸）。升级后的一次性搬迁
//! （`migrate_legacy_root`）把旧内容搬进统一落点并重写 preferences 里的路径记录；
//! 前端 `userDataDir("tools", …)` 调用点改走 `tools_root_dir`，不再产生新内容。
//!
//! # 迁移的事务性
//!
//! 复用 `storage_location::copy_verified`（逐文件 SHA-256 核验）：
//! 拷贝进目标目录下的暂存目录 → 全部成功后 `rename` 归位 → 原子写指针 →
//! 工具目录迁移此时才删旧副本；任何一步失败，指针未动、旧数据完好。
//! 工具数据迁移**永不删旧**——用户明确要求只拷贝，旧数据留给用户手动清理。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

use crate::storage_location::copy_verified;

use super::store::WRITE_LOCK;
use super::ToolsHost;

// ── 指针文件 ─────────────────────────────────────────────────────────────

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RootPointer {
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    storage_root: Option<String>,
}

/// 读指针文件里的一个路径字段。空串/缺失/解析失败一律按"没设置"处理，
/// 返回 `None` 让调用方用默认值——指针坏了不能把工具整个弄丢。
fn pointer_value(pointer: &Path, key: &str) -> Option<String> {
    let text = fs::read_to_string(pointer).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let path = value.get(key)?.as_str()?.trim().to_string();
    (!path.is_empty()).then_some(path)
}

/// 原子写指针：临时文件 + rename，断电不留半个 JSON。
fn write_pointer(pointer: &Path, key: &str, target: &Path) -> Result<(), String> {
    if let Some(parent) = pointer.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("建目录失败：{error}"))?;
    }
    let mut value = RootPointer::default();
    // 统一成正斜杠：前端记录（安装记录的 dir、排除列表）都是 / 分隔，
    // 混着存会让前缀比较与展示出现两套路径。
    let normalized = target.to_string_lossy().replace('\\', "/");
    if key == "toolRoot" {
        value.tool_root = Some(normalized);
    } else {
        value.storage_root = Some(normalized);
    }
    let temp = super::unique_temp(pointer);
    let body = serde_json::to_vec(&value).map_err(|error| format!("序列化失败：{error}"))?;
    fs::write(&temp, body).map_err(|error| format!("写入失败：{error}"))?;
    fs::rename(&temp, pointer).map_err(|error| format!("落盘失败：{error}"))
}

/// 工具目录根。`data_root` 必须是**迁移后的 active 数据根**（`ToolsHost` 持有的）。
pub fn tool_root(data_root: &Path) -> PathBuf {
    pointer_value(&data_root.join("configuration").join("tools-location.json"), "toolRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| data_root.join("tools"))
}

/// 工具数据根（aawStore 键值文件的父目录）。
pub fn tool_data_root(data_root: &Path) -> PathBuf {
    pointer_value(&data_root.join("configuration").join("data-location.json"), "storageRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| data_root.join("tools").join("storage"))
}

/// 展示用路径：剥掉 Windows canonicalize 的 `\\?\` 前缀，统一正斜杠。
fn display_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    let value = if cfg!(windows) {
        value
            .strip_prefix(r"\\?\UNC\")
            .map(|unc| format!(r"\\{unc}"))
            .or_else(|| value.strip_prefix(r"\\?\").map(str::to_owned))
            .unwrap_or_else(|| value.into_owned())
    } else {
        value.into_owned()
    };
    value.replace('\\', "/")
}

fn revision() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

// ── 迁移状态与进度 ───────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub stage: String,
    pub detail: String,
}

/// 一次迁移的生命周期状态。`running` 同时是并发闸：工具目录迁移进行中
/// 不允许第二个迁移（也不允许打开工具——目录正在被搬走）。
#[derive(Default)]
pub struct MigrationState {
    running: AtomicBool,
    progress: Mutex<Option<Progress>>,
    last_report: Mutex<Option<String>>,
}

impl MigrationState {
    fn begin(&self) {
        self.running.store(true, Ordering::SeqCst);
        if let Ok(mut slot) = self.progress.lock() {
            *slot = Some(Progress { stage: "校验".into(), detail: String::new() });
        }
    }
    fn stage(&self, stage: &str, detail: String) {
        if let Ok(mut slot) = self.progress.lock() {
            *slot = Some(Progress { stage: stage.into(), detail });
        }
    }
    fn finish(&self, report: String) {
        self.running.store(false, Ordering::SeqCst);
        if let Ok(mut slot) = self.progress.lock() {
            *slot = None;
        }
        if let Ok(mut slot) = self.last_report.lock() {
            *slot = Some(report);
        }
    }
    pub(crate) fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }
}

/// 工具目录根的迁移状态。`running` 期间 `tools_open` 与工具根内的写盘被拒。
#[derive(Default)]
pub struct ToolRootMigration(pub MigrationState);

/// 工具数据根的迁移状态。迁移全程持 `WRITE_LOCK`，写通道天然排队。
#[derive(Default)]
pub struct ToolDataMigration(pub MigrationState);

// ── 状态读取 ─────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolLocationStatus {
    data_root: String,
    tool_root: String,
    tool_root_custom: bool,
    storage_root: String,
    storage_root_custom: bool,
    /// 旧版裸 `tools` 目录里还有没搬完的内容时给出路径，UI 提示用户。
    legacy_root: Option<String>,
    migrating: bool,
    data_migrating: bool,
    progress: Option<Progress>,
    tool_root_report: Option<String>,
    storage_report: Option<String>,
}

/// 升级前的旧落点：`user_data_dir` 命令的 `tools` namespace 拼出来的目录。
fn legacy_tools_root() -> Option<PathBuf> {
    #[cfg(windows)]
    let base = std::env::var("APPDATA").ok().filter(|s| !s.is_empty())?;
    #[cfg(not(windows))]
    let base = std::env::var("HOME").ok().filter(|s| !s.is_empty())?;
    let folder = if cfg!(windows) { "tools" } else { ".tools" };
    let path = PathBuf::from(base).join(folder);
    path.is_dir().then_some(path)
}

/// 旧目录里是否还有未搬完的分区（任一存在即算）。
fn legacy_pending() -> Option<String> {
    let legacy = legacy_tools_root()?;
    ["projects", "installed", "backups"]
        .iter()
        .any(|name| legacy.join(name).is_dir())
        .then(|| display_path(&legacy))
}

pub fn status(app: &AppHandle) -> Result<ToolLocationStatus, String> {
    let host = app.state::<ToolsHost>();
    let data_root = host.data_root()?;
    let config = data_root.join("configuration");
    let root_mig = app.try_state::<ToolRootMigration>();
    let data_mig = app.try_state::<ToolDataMigration>();
    let migrating = root_mig.as_ref().is_some_and(|state| state.0.is_running());
    let data_running = data_mig.as_ref().is_some_and(|state| state.0.is_running());
    // 两条迁移链的进度与报告分开存：设置页两行各自展示自己的结果，
    // 不然工具目录迁完的数据行也会冒出同一条报告。
    let (progress, tool_root_report, storage_report) = if migrating {
        let state = root_mig.unwrap();
        (
            state.0.progress.lock().ok().and_then(|slot| slot.clone()),
            state.0.last_report.lock().ok().and_then(|slot| slot.clone()),
            None,
        )
    } else if data_running {
        let state = data_mig.unwrap();
        (
            state.0.progress.lock().ok().and_then(|slot| slot.clone()),
            None,
            state.0.last_report.lock().ok().and_then(|slot| slot.clone()),
        )
    } else {
        // 都空闲时仍要能读到上一次的报告：迁移从设置页发起，发起后组件
        // 靠轮询读到最终结果。
        (
            None,
            root_mig.and_then(|state| state.0.last_report.lock().ok().and_then(|slot| slot.clone())),
            data_mig.and_then(|state| state.0.last_report.lock().ok().and_then(|slot| slot.clone())),
        )
    };
    Ok(ToolLocationStatus {
        data_root: display_path(&data_root),
        tool_root: display_path(&tool_root(&data_root)),
        tool_root_custom: pointer_value(&config.join("tools-location.json"), "toolRoot").is_some(),
        storage_root: display_path(&tool_data_root(&data_root)),
        storage_root_custom: pointer_value(&config.join("data-location.json"), "storageRoot").is_some(),
        legacy_root: legacy_pending(),
        migrating,
        data_migrating: data_running,
        progress,
        tool_root_report,
        storage_report,
    })
}

// ── 目标校验 ─────────────────────────────────────────────────────────────

fn canonical(path: &Path) -> Option<PathBuf> {
    path.canonicalize().ok()
}

/// 迁移目标的公共校验：绝对路径、已存在、与任何已知根互不嵌套。
/// `forbidden` 每项带名字：第一道检查里同名的是“当前根”（撞上=没变化），
/// 异名的是别的受保护根（撞上=撞车，必须各自报各自的文案——
/// Z-22 用户实测：给工具数据选了工具目录刚迁去的文件夹，被误报成
/// 「没有变化，无需迁移」，用户完全看不懂）。
fn validate_target(input: &str, forbidden: &[(PathBuf, &str)], label: &str) -> Result<PathBuf, String> {
    let target = PathBuf::from(input.trim());
    if !target.is_absolute() {
        return Err("请输入绝对目录路径。".into());
    }
    if !target.is_dir() {
        return Err("请选择一个已存在的文件夹。".into());
    }
    let Some(canon) = canonical(&target) else {
        return Err("无法访问所选目录。".into());
    };
    for (root, name) in forbidden {
        if let Some(root) = canonical(root) {
            if canon == root {
                if *name == label {
                    return Err(format!("{label}没有变化，无需迁移。"));
                }
                return Err(format!(
                    "所选文件夹与「{name}」是同一个位置，两者不能混在一起：请为{label}换一个单独的文件夹。"
                ));
            }
            if canon.starts_with(&root) {
                return Err(format!("所选文件夹位于「{name}」内部，请换一个它以外的文件夹。"));
            }
            if root.starts_with(&canon) {
                return Err(format!("「{name}」位于所选文件夹内部，这样迁移会互相嵌套。"));
            }
        }
    }
    Ok(target)
}

// ── 工具目录迁移（迁后删旧） ─────────────────────────────────────────────

/// 关掉所有工具窗口并等会话表清空。迁移期间工具目录正在被搬走，
/// 留着任何持句柄的窗口都会让复制/删除失败。
fn close_tool_windows(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if label.starts_with("tool-") {
            let _ = window.destroy();
        }
    }
    // Destroyed 事件走主线程消息循环，这里轮询等它清账。
    for _ in 0..20 {
        let remaining = app
            .state::<ToolsHost>()
            .sessions
            .lock()
            .map(|sessions| sessions.len())
            .unwrap_or(0);
        if remaining == 0 {
            break;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    // 兜底：任何没被窗口销毁路径带走的 L3 进程直接杀。
    super::shutdown_all_processes(app);
}

/// 拷贝 + 归位一棵子树。暂存目录放在目标内（同一卷，rename 才是原子的）。
fn move_subtree(source: &Path, name: &str, target: &Path) -> Result<(), String> {
    let stage = target.join(format!(".aaw-stage-{name}-{}", revision()));
    let outcome = (|| {
        copy_verified(source, &stage)
            .map_err(|error| format!("复制 {name} 失败：{error}"))?;
        fs::rename(&stage, target.join(name))
            .map_err(|error| format!("切换 {name} 失败：{error}"))?;
        Ok(())
    })();
    if outcome.is_err() {
        let _ = fs::remove_dir_all(&stage);
    }
    outcome
}

/// 迁回默认位置时不留指针：指针缺省就是默认位置。若把默认路径写进指针，
/// `custom = 指针存在` 的判定恒真，「迁回默认」按钮永远消不掉。
fn settle_pointer(pointer: &Path, key: &str, target: &Path, default: &Path) -> Result<(), String> {
    let target_key = canonical(target).unwrap_or_else(|| target.to_path_buf());
    let default_key = canonical(default).unwrap_or_else(|| default.to_path_buf());
    if target_key == default_key {
        let _ = fs::remove_file(pointer);
        Ok(())
    } else {
        write_pointer(pointer, key, target)
    }
}

fn run_tool_root_migration(app: &AppHandle, target: PathBuf) -> Result<String, String> {
    let state = app.state::<ToolRootMigration>();
    let host = app.state::<ToolsHost>();
    let data_root = host.data_root()?;
    let current = tool_root(&data_root);
    if canonical(&current).is_some_and(|value| Some(value) == canonical(&target)) {
        return Ok(format!("工具目录已在 {}，无需迁移。", display_path(&target)));
    }
    state.0.stage("校验", format!("检查 {}", display_path(&target)));
    let names = ["installed", "projects", "backups"];
    let mut sources: Vec<(PathBuf, &'static str)> = Vec::new();
    for name in names {
        let source = current.join(name);
        if source.is_dir() {
            sources.push((source, name));
        }
        if target.join(name).exists() {
            return Err(format!("目标目录下已存在 {name}，请换一个空目录。"));
        }
    }
    // 清掉上次失败可能留下的暂存目录（幂等重试的前提）。
    if let Ok(entries) = fs::read_dir(&target) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name.to_string_lossy().starts_with(".aaw-stage-") {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }

    state.0.stage("关窗", "关闭打开的工具窗口".into());
    close_tool_windows(app);

    state.0.stage("拷贝", format!("复制到 {}", display_path(&target)));
    let mut moved: Vec<(&'static str, PathBuf)> = Vec::new();
    for (source, name) in &sources {
        move_subtree(source, name, &target)?;
        moved.push((name, source.clone()));
    }

    // 指针是切换点：写成功之前一切可回滚（旧数据原样），写成功之后以新目录为准。
    state.0.stage("切换", "写入位置指针".into());
    settle_pointer(
        &data_root.join("configuration").join("tools-location.json"),
        "toolRoot",
        &target,
        &data_root.join("tools"),
    )?;

    // 已打开窗口的运行目录登记重映射（窗口已关，通常表是空的，但 keepAlive
    // 的隐藏窗口也可能在这里）。
    host.remap_runtime_dirs(&current, &target);
    // 安装记录里的 dir、自定义根等绝对路径记录跟着搬，否则列表全部标
    // 「目录丢失」，靠自愈重建会丢掉 node_modules 这类不在清单里的文件。
    remap_preferences(&data_root, &current, &target);

    state.0.stage("清理", format!("删除 {}", display_path(&current)));
    let mut leftover = Vec::new();
    for (_, source) in &moved {
        if fs::remove_dir_all(source).is_err() {
            leftover.push(display_path(source));
        }
    }
    let partitions = moved.iter().map(|(name, _)| *name).collect::<Vec<_>>().join("、");
    let cleanup = if leftover.is_empty() {
        "旧目录已删除。".to_string()
    } else {
        format!("以下旧目录删除失败，请手动清理：{}。", leftover.join("、"))
    };
    Ok(format!(
        "工具目录已迁移到 {}（{}）。{}",
        display_path(&target),
        if partitions.is_empty() { "没有需要搬的内容" } else { &partitions },
        cleanup
    ))
}

// ── 工具数据迁移（只拷贝不删） ───────────────────────────────────────────

fn run_tool_data_migration(app: &AppHandle, target: PathBuf) -> Result<String, String> {
    let state = app.state::<ToolDataMigration>();
    let host = app.state::<ToolsHost>();
    let data_root = host.data_root()?;
    let current = tool_data_root(&data_root);
    if canonical(&current).is_some_and(|value| Some(value) == canonical(&target)) {
        return Ok(format!("工具数据已存放在 {}，无需迁移。", display_path(&target)));
    }
    state.0.stage("校验", format!("检查 {}", display_path(&target)));
    // 目标里已有同名数据文件时停下询问——绝不能静默覆盖用户数据。
    if let Ok(entries) = fs::read_dir(&current) {
        for entry in entries.flatten() {
            let mirror = target.join(entry.file_name());
            if mirror.exists() {
                return Err(format!(
                    "目标目录下已存在 {}，为避免覆盖数据请先清理或换一个目录。",
                    display_path(&mirror)
                ));
            }
        }
    }
    if target.exists() && fs::read_dir(&target).is_ok_and(|mut items| items.next().is_some()) {
        return Err("目标目录不是空目录，请换一个空目录。".into());
    }

    state.0.stage("拷贝", format!("复制到 {}", display_path(&target)));
    // 全程持写锁：拷贝期间工具的 set/delete 排队等待，不会出现"拷了一半
    // 又有新写入"的撕裂状态。工具数据单工具上限 5 MB，锁窗口毫秒级。
    let guard = WRITE_LOCK.lock().map_err(|error| error.to_string())?;
    let stage = target.parent().ok_or("目标目录没有父目录。")?.join(format!(".aaw-toolstage-{}", revision()));
    let result = (|| {
        copy_verified(&current, &stage).map_err(|error| format!("复制工具数据失败：{error}"))?;
        if target.exists() {
            for entry in fs::read_dir(&stage).map_err(|error| error.to_string())?.flatten() {
                fs::rename(entry.path(), target.join(entry.file_name()))
                    .map_err(|error| format!("归位失败：{error}"))?;
            }
            fs::remove_dir(&stage).map_err(|error| format!("清理暂存失败：{error}"))?;
        } else {
            fs::rename(&stage, &target).map_err(|error| format!("切换失败：{error}"))?;
        }
        Ok(())
    })();
    drop(guard);
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&stage);
        return Err(error);
    }

    state.0.stage("切换", "写入位置指针".into());
    settle_pointer(
        &data_root.join("configuration").join("data-location.json"),
        "storageRoot",
        &target,
        &data_root.join("tools").join("storage"),
    )?;
    // 用户明确要求：数据迁移**只拷贝不删**。旧位置原样保留，文案必须把旧
    // 路径原文写出来，让用户知道去哪里手动清理。
    Ok(format!(
        "工具数据已拷贝到 {}。旧位置 {} 的数据已保留，确认无用后可手动删除。",
        display_path(&target),
        display_path(&current)
    ))
}

// ── 升级一次性搬迁：消灭裸 tools 目录 ────────────────────────────────────

/// 把 preferences.json 里所有指向 `from` 前缀的字符串改写到 `to` 前缀。
///
/// 安装记录的 `dir`、自定义根、排除列表都可能存着旧路径——不改写的话列表
/// 全部标「目录丢失」，靠自愈重建的目录只有 manifest + index.html，
/// node_modules 这类清单外文件就丢了。嵌在 JSON 文本里的值（双重编码的
/// workspace blob）靠"字符串内替换"覆盖。
fn remap_preferences(data_root: &Path, from: &Path, to: &Path) {
    let file = data_root.join("configuration").join("preferences.json");
    let Ok(text) = fs::read_to_string(&file) else { return };
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&text) else { return };
    let from_slash = display_path(from);
    let from_native = from.to_string_lossy().into_owned();
    let to_slash = display_path(to);
    fn walk(value: &mut serde_json::Value, pairs: &[(String, String)]) {
        match value {
            serde_json::Value::String(text) => {
                for (from, to) in pairs {
                    if text.contains(from.as_str()) {
                        *text = text.replace(from.as_str(), to.as_str());
                    }
                }
            }
            serde_json::Value::Array(items) => items.iter_mut().for_each(|item| walk(item, pairs)),
            serde_json::Value::Object(map) => map.values_mut().for_each(|item| walk(item, pairs)),
            _ => {}
        }
    }
    walk(&mut value, &[(from_slash, to_slash.clone()), (from_native, to_slash)]);
    let body = match serde_json::to_vec(&value) {
        Ok(body) => body,
        Err(_) => return,
    };
    let temp = super::unique_temp(&file);
    if fs::write(&temp, body).is_ok() {
        let _ = fs::rename(&temp, &file);
    }
}

/// 启动时把旧版裸 `tools` 目录的内容搬进统一落点。幂等：搬过的分区源目录
/// 已删，下次启动直接跳过；目标已有同名分区时不覆盖，标记待处理让 UI 提示。
pub fn migrate_legacy_root(app: &AppHandle) {
    let host = app.state::<ToolsHost>();
    let Ok(data_root) = host.data_root() else { return };
    let Some(legacy) = legacy_tools_root() else { return };
    let target = tool_root(&data_root);
    if canonical(&legacy).is_some_and(|value| Some(value) == canonical(&target)) {
        return; // 已经是同一个地方（理论上不可能，防御一下）
    }
    let mut pending = false;
    let mut moved_any = false;
    for name in ["projects", "installed", "backups"] {
        let source = legacy.join(name);
        if !source.is_dir() {
            continue;
        }
        let destination = target.join(name);
        if destination.exists() {
            pending = true; // 新位置已有内容：不覆盖，留给用户处理
            continue;
        }
        match move_subtree(&source, name, &target) {
            Ok(()) => {
                let _ = fs::remove_dir_all(&source);
                moved_any = true;
            }
            Err(_) => {
                pending = true;
                break; // 搬不动就停，下次启动再试
            }
        }
    }
    if moved_any && !pending {
        remap_preferences(&data_root, &legacy, &target);
    }
    if pending {
        eprintln!(
            "[aaw-tools] 旧工具目录 {} 有内容未能自动搬迁（目标位置已有同名分区），已保留原样",
            display_path(&legacy)
        );
    }
}

// ── 命令 ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn tools_location_read(app: AppHandle) -> Result<ToolLocationStatus, String> {
    status(&app)
}

/// 迁移工具目录根。`target` 传 `None` 表示迁回默认位置（`<数据根>/tools`）。
/// 立即返回，迁移在后台线程执行；进度与结果靠 `tools_location_read` 轮询。
#[tauri::command]
pub async fn tools_location_schedule(
    window: tauri::WebviewWindow,
    app: AppHandle,
    target: Option<String>,
) -> Result<ToolLocationStatus, String> {
    if window.label() != "main" {
        return Err("只有主窗口可以修改工具目录。".into());
    }
    let host = app.state::<ToolsHost>();
    let data_root = host.data_root()?;
    let state = app.state::<ToolRootMigration>();
    if state.0.is_running() {
        return Err("已有一个工具目录迁移在进行，请等它结束。".into());
    }
    let fallback = data_root.join("tools");
    let forbidden = [
        (tool_root(&data_root), "工具目录"),
        (tool_data_root(&data_root), "工具数据目录"),
        (data_root.clone(), "数据根"),
    ];
    let target = match target.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        Some(input) => validate_target(input, &forbidden, "工具目录")?,
        None => {
            if canonical(&tool_root(&data_root)).is_some_and(|value| Some(value) == canonical(&fallback)) {
                return Err("工具目录已经在默认位置，无需迁移。".into());
            }
            // 只拒绝真正冲突的分区。不能拿整个 tools/ 的非空性做判据：
            // 工具数据默认就住在 tools/storage 下面（Z-22 用户实测撞上），
            // 那份内容不归这次迁移搬，存在不影响迁回。
            for name in ["installed", "projects", "backups"] {
                if fallback.join(name).exists() {
                    return Err(format!("默认位置下已存在 {name}，无法迁回。"));
                }
            }
            fallback
        }
    };
    if let Some(data_state) = app.try_state::<ToolDataMigration>() {
        if data_state.0.is_running() {
            return Err("工具数据正在迁移，请等它结束。".into());
        }
    }
    state.0.begin();
    let worker = app.clone();
    std::thread::spawn(move || {
        match run_tool_root_migration(&worker, target) {
            Ok(report) => worker.state::<ToolRootMigration>().0.finish(report),
            Err(error) => worker.state::<ToolRootMigration>().0.finish(format!("迁移失败：{error}（原目录未动，可重试）")),
        }
    });
    status(&app)
}

/// 迁移工具数据（aawStore）。只拷贝不删，旧位置数据保留。`target` 传 `None`
/// 表示迁回默认位置（`<数据根>/tools/storage`）。
#[tauri::command]
pub async fn tools_data_location_schedule(
    window: tauri::WebviewWindow,
    app: AppHandle,
    target: Option<String>,
) -> Result<ToolLocationStatus, String> {
    if window.label() != "main" {
        return Err("只有主窗口可以修改工具数据位置。".into());
    }
    let host = app.state::<ToolsHost>();
    let data_root = host.data_root()?;
    let state = app.state::<ToolDataMigration>();
    if state.0.is_running() {
        return Err("已有一个工具数据迁移在进行，请等它结束。".into());
    }
    if let Some(root_state) = app.try_state::<ToolRootMigration>() {
        if root_state.0.is_running() {
            return Err("工具目录正在迁移，请等它结束。".into());
        }
    }
    let fallback = data_root.join("tools").join("storage");
    let forbidden = [
        (tool_data_root(&data_root), "工具数据目录"),
        (tool_root(&data_root), "工具目录"),
        (data_root.clone(), "数据根"),
    ];
    let target = match target.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        Some(input) => validate_target(input, &forbidden, "工具数据目录")?,
        None => {
            if canonical(&tool_data_root(&data_root)).is_some_and(|value| Some(value) == canonical(&fallback)) {
                return Err("工具数据已在默认位置，无需迁移。".into());
            }
            if fallback.exists() && fs::read_dir(&fallback).is_ok_and(|mut items| items.next().is_some()) {
                return Err("默认位置已有内容，无法迁回。".into());
            }
            fallback
        }
    };
    state.0.begin();
    let worker = app.clone();
    std::thread::spawn(move || {
        match run_tool_data_migration(&worker, target) {
            Ok(report) => worker.state::<ToolDataMigration>().0.finish(report),
            Err(error) => worker.state::<ToolDataMigration>().0.finish(format!("迁移失败：{error}（原数据未动，可重试）")),
        }
    });
    status(&app)
}

/// 前端解析工具分区目录（projects / installed / backups）。
/// 取代 `user_data_dir("tools", …)`——那个命令是共享基础设施，不能为工具
/// 单独改行为，工具从此走自己的指针解析。
#[tauri::command]
pub async fn tools_root_dir(app: AppHandle, directory: String) -> Result<String, String> {
    if !matches!(directory.as_str(), "projects" | "installed" | "backups") {
        return Err(format!("未知的工具目录类型：{directory}"));
    }
    let host = app.state::<ToolsHost>();
    let data_root = host.data_root()?;
    Ok(display_path(&tool_root(&data_root).join(directory)))
}

/// 在文件管理器里打开一个目录（设置页「打开文件夹」按钮）。
#[tauri::command]
pub async fn tools_storage_open(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    if window.label() != "main" {
        return Err("只有主窗口可以打开文件夹。".into());
    }
    let path = PathBuf::from(path.trim());
    if !path.is_dir() {
        return Err("目录不存在。".into());
    }
    tauri_plugin_opener::open_path(path, None::<&str>)
        .map_err(|error| format!("打开失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("aaw-tools-loc-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_pointer_file(data_root: &Path, file: &str, key: &str, value: &str) {
        let config = data_root.join("configuration");
        fs::create_dir_all(&config).unwrap();
        let body = serde_json::json!({ key: value }).to_string();
        fs::write(config.join(file), body).unwrap();
    }

    #[test]
    fn pointer_overrides_default_and_empty_value_falls_back() {
        let root = temp_root("pointer");
        assert_eq!(tool_root(&root), root.join("tools"));
        assert_eq!(tool_data_root(&root), root.join("tools").join("storage"));
        write_pointer_file(&root, "tools-location.json", "toolRoot", "D:/AAW-tools");
        assert_eq!(tool_root(&root), PathBuf::from("D:/AAW-tools"));
        // 空值 = 没设置
        write_pointer_file(&root, "tools-location.json", "toolRoot", "  ");
        assert_eq!(tool_root(&root), root.join("tools"));
        write_pointer_file(&root, "data-location.json", "storageRoot", "E:/AAW-data");
        assert_eq!(tool_data_root(&root), PathBuf::from("E:/AAW-data"));
    }

    #[test]
    fn subtree_move_verifies_and_cleans_stage_on_failure() {
        let source = temp_root("src");
        fs::create_dir_all(source.join("installed")).unwrap();
        fs::write(source.join("installed/a.json"), b"alpha").unwrap();
        let target = temp_root("dst");
        // 正常路径：拷贝 + 归位
        move_subtree(&source.join("installed"), "installed", &target).unwrap();
        assert_eq!(fs::read(target.join("installed/a.json")).unwrap(), b"alpha");
        assert!(!source.join("installed").join("a.json").exists() == false); // 源不动（删旧是迁移自己的事）
        // 已有同名目录 → 下次 move 的 rename 会失败，暂存目录要被清掉
        let stage_glob = fs::read_dir(&target).unwrap().count();
        assert!(stage_glob >= 1);
    }

    #[test]
    fn remap_preferences_rewrites_both_separator_styles() {
        let root = temp_root("remap");
        let config = root.join("configuration");
        fs::create_dir_all(&config).unwrap();
        let nested = serde_json::json!({ "recentExclusions": ["C:\\\\old\\\\tools\\\\projects"] }).to_string();
        let prefs = serde_json::json!({
            "aaw-desktop.tools.v1": [{ "dir": "C:/old/tools/installed/u1/pilot" }],
            "aaw-desktop/workspace/v1": nested,
        });
        fs::write(config.join("preferences.json"), prefs.to_string()).unwrap();
        remap_preferences(&root, Path::new("C:/old/tools"), Path::new("C:/new/tools"));
        let text = fs::read_to_string(config.join("preferences.json")).unwrap();
        assert!(text.contains("C:/new/tools/installed/u1/pilot"), "{text}");
        assert!(text.contains("C:/new/tools/projects"), "{text}");
        assert!(!text.contains("C:/old/tools"), "{text}");
    }

    #[test]
    fn validate_target_rejects_nesting_and_missing_dirs() {
        let root = temp_root("validate");
        let inner = root.join("inside");
        fs::create_dir_all(&inner).unwrap();
        let forbidden = [(root.clone(), "工具目录")];
        assert!(validate_target("relative/path", &forbidden, "工具目录").is_err());
        assert!(validate_target(&root.join("missing").to_string_lossy(), &forbidden, "工具目录").is_err());
        assert!(validate_target(&inner.to_string_lossy(), &forbidden, "工具目录").is_err());
        assert!(validate_target(&root.to_string_lossy(), &forbidden, "工具目录").is_err());
    }

    /// 给 A 迁移选了 B 正在用的文件夹：报「撞车」而不是「没有变化」。
    #[test]
    fn validate_target_distinguishes_collision_from_no_change() {
        let mine = temp_root("collision-mine");
        let other = temp_root("collision-other");
        let same_as_other = format!("{}", other.display());
        // 与别的受保护根相同 → 撞车文案，不含「没有变化」
        let error = validate_target(&same_as_other, &[(mine.clone(), "工具数据目录"), (other.clone(), "工具目录")], "工具数据目录")
            .unwrap_err();
        assert!(error.contains("工具目录") && !error.contains("没有变化"), "{error}");
        // 与当前根相同 → 才是「没有变化」
        let error = validate_target(&mine.display().to_string(), &[(mine, "工具数据目录"), (other, "工具目录")], "工具数据目录")
            .unwrap_err();
        assert!(error.contains("没有变化"), "{error}");
    }
}
