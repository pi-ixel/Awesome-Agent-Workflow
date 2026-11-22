//! 工具**整体**（本体 installed/projects/backups + 数据 storage）的位置：
//! 按账号单指针 + 在线迁移事务。
//!
//! # 为什么是"整体"和"按账号"
//!
//! 上一版是两个全局指针（tools-location.json 管本体、data-location.json 管
//! 数据），被两个结构性问题推翻：
//!
//! 1. 工具数据默认住在工具目录默认根内（`tools/storage`），两个根互相嵌套，
//!    迁回校验会被自家兄弟分区挡死（Z-22）；
//! 2. 指针全局一份——张三迁移会改写李四的落点，多账号互相串门。
//!
//! 现在：**一个账号一个指针**（`configuration/tool-locations/<账号>.json`），
//! 指向该账号的"工具整体家"（本体 + 数据必须在同一处）；迁移一次搬完、
//! 一次切指针、一次清理，任何时刻不存在"工具在 A 盘、数据在 B 盘"的分裂态。
//!
//! # 落点与解析（每次解析重读指针——在线迁移即时生效的前提）
//!
//! | 内容 | 有账号指针（home = H） | 默认（无指针） |
//! |---|---|---|
//! | 安装副本 | `H/installed/<工具id>` | `<数据根>/tools/installed/<账号>/<工具id>` |
//! | 源码项目 | `H/projects/<工具id>` | `<数据根>/tools/projects/<账号>/<工具id>` |
//! | 备份 | `H/backups/` | `<数据根>/tools/backups/<账号>/` |
//! | 工具数据 | `H/storage/<工具id>.json` | `<数据根>/tools/storage/<账号>/<工具id>.json` |
//!
//! 逻辑：默认位置是**多账号共享的家**，必须带账号层；自定义 home 是**账号
//! 私有的家**，目录即本人，不套账号层。`aawStore` 的 `file()`、`tool_dir()`、
//! 前端 `tools_root_dir` 全部走这张表。
//!
//! 指针文件放 `configuration/tool-locations/` 里：数据根迁移
//! （`storage_location.rs`）把整个 `configuration` 搬走，指针自然跟着走。
//!
//! # 迁移的事务性
//!
//! 复用 `storage_location::copy_verified`（逐文件 SHA-256 核验）：拷贝进目标
//! 暂存目录 → 全部成功后 rename 归位 → 原子写账号指针 → **本体与数据都删旧**
//! （用户拍板：整体搬家不留残留，报告写明删了什么）。任何一步失败，指针未动、
//! 旧数据完好、可重试。
//!
//! # 升级收编
//!
//! 旧模型的全局指针（tools-location.json / data-location.json）在启动时收编成
//! 账号指针：本体所在的 home 归属给当前账号，数据拷进 `H/storage/` 团聚；
//! 全局指针删除。收编幂等——指针没删成就重来。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

use crate::storage_location::copy_verified;

use super::store::{ToolStore, WRITE_LOCK};
use super::ToolsHost;

pub(crate) const PARTITIONS: [&str; 3] = ["installed", "projects", "backups"];

// ── 指针文件 ─────────────────────────────────────────────────────────────

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct HomePointer {
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_home: Option<String>,
}

fn home_pointer_path(data_root: &Path, owner: &str) -> PathBuf {
    data_root
        .join("configuration")
        .join("tool-locations")
        .join(format!("{owner}.json"))
}

/// 读指针里的路径。空串/缺失/解析失败一律按"没设置"处理，返回 `None` 让
/// 调用方用默认值——指针坏了不能把工具整个弄丢。
fn read_home_pointer(pointer: &Path) -> Option<String> {
    let text = fs::read_to_string(pointer).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let path = value.get("toolHome")?.as_str()?.trim().to_string();
    (!path.is_empty()).then_some(path)
}

/// 原子写指针：临时文件 + rename，断电不留半个 JSON。统一正斜杠——前端
/// 记录（安装记录的 dir、排除列表）都是 / 分隔，混着存会让前缀比较与展示
/// 出现两套路径。
fn write_home_pointer(pointer: &Path, target: &Path) -> Result<(), String> {
    if let Some(parent) = pointer.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("建目录失败：{error}"))?;
    }
    let value = HomePointer {
        tool_home: Some(target.to_string_lossy().replace('\\', "/")),
    };
    let temp = super::unique_temp(pointer);
    let body = serde_json::to_vec(&value).map_err(|error| format!("序列化失败：{error}"))?;
    fs::write(&temp, body).map_err(|error| format!("写入失败：{error}"))?;
    fs::rename(&temp, pointer).map_err(|error| format!("落盘失败：{error}"))
}

/// 当前账号的工具整体家：指针优先，默认 `<数据根>/tools`。
pub fn tool_home(data_root: &Path, owner: &str) -> PathBuf {
    tool_home_pointer(data_root, owner).unwrap_or_else(|| default_tool_root(data_root))
}

/// 账号指针（`None` = 用默认位置）。
pub fn tool_home_pointer(data_root: &Path, owner: &str) -> Option<PathBuf> {
    read_home_pointer(&home_pointer_path(data_root, owner)).map(PathBuf::from)
}

/// 默认工具根：多账号共享的家，分区下带账号层。
pub fn default_tool_root(data_root: &Path) -> PathBuf {
    data_root.join("tools")
}

/// 账号的分区目录（installed / projects / backups）。
///
/// 默认位置带账号层（多账号共享的家）；自定义 home 不带（账号私有家）。
/// 前端 `tools_root_dir` 与 Rust `tool_dir` 都走这里——两条路同一个解析，
/// 不再有两套口径。
pub fn tool_partition(data_root: &Path, owner: &str, partition: &str) -> PathBuf {
    match tool_home_pointer(data_root, owner) {
        Some(home) => home.join(partition),
        None => default_tool_root(data_root).join(partition).join(owner),
    }
}

/// 账号的工具数据目录（aawStore 键值文件的父目录）。
pub fn tool_storage_root(data_root: &Path, owner: &str) -> PathBuf {
    match tool_home_pointer(data_root, owner) {
        Some(home) => home.join("storage"),
        None => default_tool_root(data_root).join("storage").join(owner),
    }
}

/// 其他账号的自定义 home（冲突检测用）：两个账号不能选同一个目录。
fn other_homes(data_root: &Path, current_owner: &str) -> Vec<(PathBuf, String)> {
    let dir = data_root.join("configuration").join("tool-locations");
    let mut result = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry
                .file_name()
                .to_string_lossy()
                .trim_end_matches(".json")
                .to_string();
            if name == current_owner || name.is_empty() {
                continue;
            }
            if let Some(home) = read_home_pointer(&entry.path()) {
                result.push((PathBuf::from(home), format!("账号 {name} 的工具目录")));
            }
        }
    }
    result
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

fn canonical(path: &Path) -> Option<PathBuf> {
    path.canonicalize().ok()
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

/// 一次迁移的生命周期状态。`running` 同时是并发闸：迁移进行中不允许第二个
/// 迁移（也不允许打开工具——目录正在被搬走）。
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

/// 工具整体（本体 + 数据）的迁移状态。`running` 期间 `tools_open` 与工具域
/// 内的写盘被拒；数据拷贝全程持 `WRITE_LOCK`。
#[derive(Default)]
pub struct ToolHomeMigration(pub MigrationState);

// ── 目标落点分类：残留 vs 真冲突 ─────────────────────────────────────────

/// 目标落点的既有内容分类（Z-24）。
///
/// 迁移的切换点是"写账号指针"，它在本函数之后才发生——所以此刻目标处出现
/// 我们的分区，**只可能是上次迁移中断留下的残骸**（指针写入失败、进程被杀、
/// 回滚删除失败）。残骸留着不动的话，重试会永远撞"已存在 projects"，
/// 报错又没说这是哪来的、能不能删——用户被逼进死角（2026-11-22 真机实测）。
///
/// 分类的两个特征，误伤概率可以忽略：
/// - **≥2 个已知分区目录**（installed/projects/backups/storage）：正常迁移
///   完成后指针就切走了，指针没切却凑齐多个分区，只能是中断产物；
/// - **`.aaw-stage-*` 暂存目录**：那是复制中途被杀的现场，随机目录里不会
///   自己长出来。
#[derive(Debug)]
enum DestinationState {
    /// 干净，直接迁。
    Vacant,
    /// 上次迁移的残骸：这些目录可以安全删除（源数据原样在旧家）。
    Leftover { paths: Vec<PathBuf> },
    /// 真冲突：目标里有不像残骸的内容，报错让用户决定。
    Conflict { name: &'static str, dest: PathBuf },
}

/// 单个已知分区落点的状态。
enum PartitionOccupancy {
    /// 不存在。
    Absent,
    /// 存在但为空（空壳，删除无损失）。
    Shell,
    /// 存在且有内容。
    Occupied,
}

fn occupancy(dest: &Path) -> PartitionOccupancy {
    if !dest.is_dir() {
        return PartitionOccupancy::Absent;
    }
    let has_entries = fs::read_dir(dest).is_ok_and(|mut items| items.next().is_some());
    if has_entries {
        PartitionOccupancy::Occupied
    } else {
        PartitionOccupancy::Shell
    }
}

fn has_stage_leftover(destinations: &[(&'static str, PathBuf)]) -> bool {
    // 暂存目录建在每个落点的父目录里（家模式 = 目标家根本身）。
    destinations.iter().any(|(_, dest)| {
        let Some(parent) = dest.parent() else { return false };
        fs::read_dir(parent).is_ok_and(|entries| {
            entries.flatten().any(|entry| {
                entry.file_name().to_string_lossy().starts_with(".aaw-stage-")
            })
        })
    })
}

fn classify_destinations(destinations: &[(&'static str, PathBuf)]) -> DestinationState {
    let mut occupied: Vec<(&'static str, &PathBuf)> = Vec::new();
    let mut shells: Vec<PathBuf> = Vec::new();
    for (name, dest) in destinations {
        match occupancy(dest) {
            PartitionOccupancy::Absent => {}
            PartitionOccupancy::Shell => shells.push(dest.clone()),
            PartitionOccupancy::Occupied => occupied.push((name, dest)),
        }
    }
    let stage = has_stage_leftover(destinations);
    if occupied.len() >= 2 || (occupied.len() == 1 && stage) {
        // 残骸：已知落点（含空壳）一起清。删除失败不阻塞——后面归位前的
        // 叶子检查仍会拦，报告里也说得清。
        let mut paths: Vec<PathBuf> = occupied.iter().map(|(_, dest)| (*dest).clone()).collect();
        paths.extend(shells);
        return DestinationState::Leftover { paths };
    }
    if let Some((name, dest)) = occupied.first() {
        return DestinationState::Conflict { name, dest: (*dest).clone() };
    }
    if !shells.is_empty() {
        // 只剩空壳：删壳即可，不算冲突。
        return DestinationState::Leftover { paths: shells };
    }
    DestinationState::Vacant
}

// ── 目标校验 ─────────────────────────────────────────────────────────────

/// 迁移目标的公共校验：绝对路径、已存在、与任何已知根互不嵌套。
/// `forbidden` 每项带名字：同名的是“当前根”（撞上=没变化），异名的是别的
/// 受保护根（撞上=撞车，各自报各自的文案——Z-23 用户实测：撞了工具目录
/// 却被误报成“没有变化”，用户完全看不懂）。
fn validate_target(input: &str, forbidden: &[(PathBuf, String)], label: &str) -> Result<PathBuf, String> {
    let target = PathBuf::from(input.trim());
    if !target.is_absolute() {
        return Err("请选择绝对路径下的文件夹。".into());
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
                if name == label {
                    return Err(format!("{label}没有变化，无需迁移。"));
                }
                return Err(format!(
                    "所选文件夹与「{name}」是同一个位置，两者不能混在一起：请换一个单独的文件夹。"
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

// ── 迁移执行 ─────────────────────────────────────────────────────────────

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

/// 删一棵目录树；删完父目录若已空，把壳也清掉（默认位置的账号层目录、
/// 旧 home 本身都按此处理——空壳留着只会让人误以为还有东西）。
fn remove_tree_and_shell(tree: &Path, shell: &Path) -> bool {
    let removed = fs::remove_dir_all(tree).is_ok();
    if shell != tree && shell.is_dir() {
        let empty = fs::read_dir(shell).is_ok_and(|mut items| items.next().is_none());
        if empty {
            let _ = fs::remove_dir(shell);
        }
    }
    removed
}

/// 结构性重映射规则集：账号层变化不能靠纯前缀替换——默认家有账号层、
/// 自定义 home 没有。按分区生成配对，preferences 文本与运行目录注册表共用。
pub(crate) fn structural_pairs(
    owner: &str,
    from_home: &Path,
    to_home: &Path,
    from_default: bool,
    to_default: bool,
) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    for partition in PARTITIONS {
        let from = if from_default {
            display_path(&from_home.join(partition).join(owner))
        } else {
            display_path(&from_home.join(partition))
        };
        let to = if to_default {
            display_path(&to_home.join(partition).join(owner))
        } else {
            display_path(&to_home.join(partition))
        };
        // 带尾分隔符匹配，防止账号段前缀撞上别的账号（"u1" vs "u1x"）。
        pairs.push((format!("{from}/"), format!("{to}/")));
        pairs.push((format!("{}\\", from.replace('/', "\\")), format!("{}\\", to.replace('/', "\\"))));
    }
    pairs
}

/// 把 preferences.json 里命中规则的路径改写（安装记录的 dir、排除列表等）。
fn remap_preferences(data_root: &Path, pairs: &[(String, String)]) {
    let file = data_root.join("configuration").join("preferences.json");
    let Ok(text) = fs::read_to_string(&file) else { return };
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&text) else { return };
    fn walk(value: &mut serde_json::Value, pairs: &[(String, String)]) {
        match value {
            serde_json::Value::String(text) => {
                for (from, to) in pairs {
                    if text.starts_with(from.as_str()) {
                        *text = format!("{to}{}", &text[from.len()..]);
                    }
                }
            }
            serde_json::Value::Array(items) => items.iter_mut().for_each(|item| walk(item, pairs)),
            serde_json::Value::Object(map) => map.values_mut().for_each(|item| walk(item, pairs)),
            _ => {}
        }
    }
    walk(&mut value, pairs);
    let body = match serde_json::to_vec(&value) {
        Ok(body) => body,
        Err(_) => return,
    };
    let temp = super::unique_temp(&file);
    if fs::write(&temp, body).is_ok() {
        let _ = fs::rename(&temp, &file);
    }
}

/// 工具整体的在线迁移。`target` 为 `None` 表示迁回默认位置。
fn run_tool_home_migration(app: &AppHandle, target: Option<PathBuf>) -> Result<String, String> {
    let state = app.state::<ToolHomeMigration>();
    let host = app.state::<ToolsHost>();
    let data_root = host.data_root()?;
    let owner = ToolStore::new(&data_root).owner()?;
    let from_home = tool_home(&data_root, &owner);
    let from_default = tool_home_pointer(&data_root, &owner).is_none();
    let to_default = target.is_none();
    let target = target.unwrap_or_else(|| default_tool_root(&data_root));

    state.0.stage("校验", format!("检查 {}", display_path(&target)));
    // 源分区与目标分区。同一张表（tool_partition / tool_storage_root）在
    // 指针切换前解析出"源"、以目标家手工拼出"目标"——切换点只有指针。
    let sources: Vec<(PathBuf, &'static str)> = PARTITIONS
        .iter()
        .map(|name| (tool_partition(&data_root, &owner, name), *name))
        .chain(std::iter::once((
            tool_storage_root(&data_root, &owner),
            "storage",
        )))
        .filter(|(source, _)| source.is_dir())
        .collect();
    if canonical(&from_home).is_some_and(|value| Some(value) == canonical(&target)) {
        return Ok(format!("工具整体已在 {}，无需迁移。", display_path(&target)));
    }
    // 目标分区：home 模式 <home>/<partition>；默认模式 <tools>/<partition>/<owner>
    // （默认家带账号层）。storage 同一规则——home 模式归 <home>/storage。
    let destination_of = |name: &str| -> PathBuf {
        if to_default {
            default_tool_root(&data_root).join(name).join(&owner)
        } else {
            target.join(name)
        }
    };
    let destinations: Vec<(&'static str, PathBuf)> = PARTITIONS
        .iter()
        .chain(std::iter::once(&"storage"))
        .map(|name| (*name, destination_of(name)))
        .collect();
    // 上次迁移的残骸先清掉（判据见 classify_destinations 文档），否则重试
    // 会被自己上次的中断产物永久挡死；真冲突才报错，且报错带路径。
    let mut residue_note = String::new();
    match classify_destinations(&destinations) {
        DestinationState::Vacant => {}
        DestinationState::Leftover { paths } => {
            residue_note = format!(
                "检测到上次迁移在 {} 留下的残骸，已清理后继续。",
                display_path(&target)
            );
            for path in &paths {
                let _ = fs::remove_dir_all(path);
            }
        }
        DestinationState::Conflict { name, dest } => {
            return Err(format!(
                "目标位置 {} 已有内容（{name}），看起来不是迁移残骸，不能自动覆盖：请换一个空目录；如果确认这些内容可以删除，清掉后重试即可。",
                display_path(&dest)
            ));
        }
    }
    // 暂存目录无条件清理：复制中途进程被杀会留下 .aaw-stage-*，不清的话
    // 每次重试都白背一份垃圾（幂等重试的前提）。落点的父目录（家模式下就
    // 是目标家根本身）与目标家根都扫一遍。
    let stage_parents: Vec<PathBuf> = destinations
        .iter()
        .filter_map(|(_, dest)| dest.parent().map(Path::to_path_buf))
        .chain(std::iter::once(target.clone()))
        .collect();
    for parent in &stage_parents {
        if let Ok(entries) = fs::read_dir(parent) {
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy().starts_with(".aaw-stage-") {
                    let _ = fs::remove_dir_all(entry.path());
                }
            }
        }
    }

    state.0.stage("关窗", "关闭打开的工具窗口".into());
    close_tool_windows(app);

    state.0.stage("拷贝", format!("复制到 {}", display_path(&target)));
    // 全程持写锁：工具窗口已关、L3 进程已杀，实际没有争用方；锁保证万一
    // 有 keepAlive 的隐藏通道在写数据，也不会出现"拷了一半又有新写入"。
    let guard = WRITE_LOCK.lock().map_err(|error| error.to_string())?;
    let mut moved: Vec<(&'static str, PathBuf)> = Vec::new();
    let mut copy_error: Option<String> = None;
    for (source, name) in &sources {
        // move_subtree 的目标叶子：默认模式下账号层是叶子（<tools>/<name>/<owner>），
        // home 模式下分区名就是叶子（<home>/<name>）。
        let (stage_parent, leaf) = if to_default {
            (default_tool_root(&data_root).join(name), owner.as_str())
        } else {
            (target.clone(), *name)
        };
        match move_subtree_named(source, &stage_parent, leaf) {
            Ok(()) => moved.push((name, source.clone())),
            Err(error) => {
                copy_error = Some(error);
                break;
            }
        }
    }
    drop(guard);
    if let Some(error) = copy_error {
        // 回滚：删掉已归位的目标分区（指针没动，旧数据完好）。
        for (name, _) in &moved {
            let _ = fs::remove_dir_all(destination_of(name));
        }
        return Err(format!("{error}（原目录未动，可重试）"));
    }

    // 指针是切换点：写成功之前一切可回滚（旧数据原样），写成功之后以新家为准。
    state.0.stage("切换", "写入位置指针".into());
    let pointer = home_pointer_path(&data_root, &owner);
    if to_default {
        // 迁回默认时不留指针：指针缺省即默认位置，留着会把「迁回默认」
        // 按钮钉死在界面上。
        let _ = fs::remove_file(&pointer);
    } else if let Err(error) = write_home_pointer(&pointer, &target) {
        return Err(format!("{error}（原目录未动，可重试）"));
    }

    // 重映射：安装记录里的 dir、排除列表、运行目录登记都跟着搬。账号层
    // 变化是结构性的（默认家带账号层、home 不带），不能纯前缀替换。
    state.0.stage("切换", "改写路径记录".into());
    let pairs = structural_pairs(&owner, &from_home, &target, from_default, to_default);
    remap_preferences(&data_root, &pairs);
    host.remap_runtime_dirs_with(&pairs);

    // 清理（都删旧）：源分区子树 + 源数据目录；删完的空壳一并清掉。
    state.0.stage("清理", format!("删除 {}", display_path(&from_home)));
    let mut leftover = Vec::new();
    for (_, source) in &moved {
        let shell = if from_default { source.parent().unwrap() } else { &from_home };
        if !remove_tree_and_shell(source, shell) {
            leftover.push(display_path(source));
        }
    }
    let names = moved
        .iter()
        .map(|(name, _)| *name)
        .collect::<Vec<_>>()
        .join("、");
    let cleanup = if leftover.is_empty() {
        "旧位置已删除。".to_string()
    } else {
        format!("以下旧目录删除失败，请手动清理：{}。", leftover.join("、"))
    };
    if !residue_note.is_empty() {
        residue_note.push_str(&cleanup);
        return Ok(format!(
            "工具整体已迁移到 {}（{}）。{}",
            display_path(&target),
            if names.is_empty() { "没有需要搬的内容" } else { &names },
            residue_note
        ));
    }
    Ok(format!(
        "工具整体已迁移到 {}（{}）。{}",
        display_path(&target),
        if names.is_empty() { "没有需要搬的内容" } else { &names },
        cleanup
    ))
}

/// move_subtree 的变体：目标叶子名与暂存目录所在父目录分开给——默认模式
/// 下"目标分区目录"是 `<tools>/<partition>/<owner>`（owner 是叶子名），
/// home 模式下叶子名就是分区名。
fn move_subtree_named(source: &Path, parent: &Path, leaf: &str) -> Result<(), String> {
    if parent.join(leaf).exists() {
        // 分类漏掉的竞态兜底（比如两次迁移撞车）：报错带路径，用户知道去哪看。
        return Err(format!(
            "{} 已存在，无法归位：请换一个空目录或先清理后重试。",
            display_path(&parent.join(leaf))
        ));
    }
    move_subtree(source, leaf, parent)
}

// ── 升级收编与旧落点搬迁 ────────────────────────────────────────────────

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
    PARTITIONS
        .iter()
        .any(|name| legacy.join(name).is_dir())
        .then(|| display_path(&legacy))
}

/// 启动时把旧版裸 `tools` 目录的内容搬进默认落点。幂等：搬过的分区源目录
/// 已删，下次启动直接跳过；目标已有同名分区时不覆盖，标记待处理让 UI 提示。
/// 裸目录结构带账号层（与默认家同构），整棵 rename 即可。
pub fn migrate_legacy_root(app: &AppHandle) {
    let host = app.state::<ToolsHost>();
    let Ok(data_root) = host.data_root() else { return };
    let Some(legacy) = legacy_tools_root() else { return };
    let target = default_tool_root(&data_root);
    if canonical(&legacy).is_some_and(|value| Some(value) == canonical(&target)) {
        return; // 已经是同一个地方（理论上不可能，防御一下）
    }
    let mut pending = false;
    let mut moved_any = false;
    for name in PARTITIONS {
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
        let from = display_path(&legacy);
        let to = display_path(&target);
        remap_preferences(&data_root, &[(format!("{from}/"), format!("{to}/"))]);
    }
    if pending {
        eprintln!(
            "[aaw-tools] 旧工具目录 {} 有内容未能自动搬迁（目标位置已有同名分区），已保留原样",
            display_path(&legacy)
        );
    }
}

/// 把旧模型的全局双指针收编成按账号指针。启动时调用一次，幂等：
/// 全局指针删掉后此函数直接返回。
///
/// 场景表见设计稿 §4。关键动作：本体所在的 home 归属给当前账号；数据拷进
/// `H/storage/` 团聚；全局指针删除。数据拷贝**不删旧**（收编是自动动作，
/// 数据安全第一，旧位置留给用户手动清）。
pub fn collect_legacy_pointers(app: &AppHandle) {
    let host = app.state::<ToolsHost>();
    let Ok(data_root) = host.data_root() else { return };
    let config = data_root.join("configuration");
    // 旧模型的全局指针用的是 toolRoot / storageRoot 键，单独读。
    let global_tool = old_pointer_value(&config.join("tools-location.json"), "toolRoot");
    let global_data = old_pointer_value(&config.join("data-location.json"), "storageRoot");
    let Some(owner) = ToolStore::new(&data_root).owner().ok() else {
        // 拿不到账号不能瞎归属：留着指针下次启动再收编。
        return;
    };
    let default_storage_owner = default_tool_root(&data_root).join("storage").join(&owner);
    match (global_tool, global_data) {
        (Some(home), data_opt) => {
            let home = PathBuf::from(&home);
            // 数据团聚：源 = 旧数据指针位置（若有）或默认 storage/<owner>。
            let source_storage = data_opt
                .map(|value| PathBuf::from(value).join(&owner))
                .unwrap_or_else(|| default_storage_owner.clone());
            let target_storage = home.join("storage");
            if source_storage.is_dir() {
                if target_storage.exists() {
                    eprintln!(
                        "[aaw-tools] 收编：{} 已有内容，旧数据 {} 保留未动",
                        display_path(&target_storage),
                        display_path(&source_storage)
                    );
                } else if let Err(error) = copy_verified(&source_storage, &target_storage) {
                    eprintln!("[aaw-tools] 收编：数据团聚失败（{error}），指针已写、下次启动重试");
                    return;
                }
            }
            if write_home_pointer(&home_pointer_path(&data_root, &owner), &home).is_err() {
                return;
            }
            let _ = fs::remove_file(config.join("tools-location.json"));
            let _ = fs::remove_file(config.join("data-location.json"));
        }
        (None, Some(storage)) => {
            // 只有数据被迁过：搬回默认 storage/<owner>（不覆盖已有），删指针。
            let source = PathBuf::from(&storage).join(&owner);
            if source.is_dir() && !default_storage_owner.exists() {
                if copy_verified(&source, &default_storage_owner).is_err() {
                    return; // 搬不动留着下次
                }
            }
            let _ = fs::remove_file(config.join("data-location.json"));
        }
        (None, None) => {}
    }
}

fn old_pointer_value(pointer: &Path, key: &str) -> Option<String> {
    let text = fs::read_to_string(pointer).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let path = value.get(key)?.as_str()?.trim().to_string();
    (!path.is_empty()).then_some(path)
}

// ── 状态读取与命令 ───────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolLocationStatus {
    data_root: String,
    /// 当前登录账号（解析失败的场合为空串，前端显示"未登录"）。
    owner: String,
    /// 工具整体当前位置（home 或默认根）。
    home: String,
    home_custom: bool,
    /// 旧版裸 `tools` 目录里还有没搬完的内容时给出路径，UI 提示用户。
    legacy_root: Option<String>,
    migrating: bool,
    progress: Option<Progress>,
    report: Option<String>,
}

pub fn status(app: &AppHandle) -> Result<ToolLocationStatus, String> {
    let host = app.state::<ToolsHost>();
    let data_root = host.data_root()?;
    let owner = ToolStore::new(&data_root).owner().unwrap_or_default();
    let (home, home_custom) = if owner.is_empty() {
        (default_tool_root(&data_root), false)
    } else {
        (
            tool_home(&data_root, &owner),
            tool_home_pointer(&data_root, &owner).is_some(),
        )
    };
    let migration = app.try_state::<ToolHomeMigration>();
    let migrating = migration
        .as_ref()
        .is_some_and(|state| state.0.is_running());
    let progress = if migrating {
        migration
            .as_ref()
            .and_then(|state| state.0.progress.lock().ok().and_then(|slot| slot.clone()))
    } else {
        None
    };
    // 空闲时也要能读到上一次的报告：迁移从设置页发起，发起后组件靠轮询
    // 读到最终结果。
    let report = migration
        .as_ref()
        .and_then(|state| state.0.last_report.lock().ok().and_then(|slot| slot.clone()));
    Ok(ToolLocationStatus {
        data_root: display_path(&data_root),
        owner,
        home: display_path(&home),
        home_custom,
        legacy_root: legacy_pending(),
        migrating,
        progress,
        report,
    })
}

#[tauri::command]
pub async fn tools_location_read(app: AppHandle) -> Result<ToolLocationStatus, String> {
    status(&app)
}

/// 迁移当前账号的工具整体（本体 + 数据一起走）。`target` 传 `None` 表示
/// 迁回默认位置。立即返回，迁移在后台线程执行；进度与结果靠
/// `tools_location_read` 轮询。
#[tauri::command]
pub async fn tools_location_schedule(
    window: tauri::WebviewWindow,
    app: AppHandle,
    target: Option<String>,
) -> Result<ToolLocationStatus, String> {
    if window.label() != "main" {
        return Err("只有主窗口可以修改工具存储位置。".into());
    }
    let host = app.state::<ToolsHost>();
    let data_root = host.data_root()?;
    let state = app.state::<ToolHomeMigration>();
    if state.0.is_running() {
        return Err("已有一个迁移在进行，请等它结束。".into());
    }
    let owner = ToolStore::new(&data_root).owner()?;
    let current_home = tool_home(&data_root, &owner);
    let target = match target.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        Some(input) => {
            let mut forbidden: Vec<(PathBuf, String)> = vec![
                (current_home.clone(), "工具整体当前位置".into()),
                (data_root.clone(), "数据根".into()),
            ];
            for (home, name) in other_homes(&data_root, &owner) {
                forbidden.push((home, name));
            }
            validate_target(input, &forbidden, "工具整体当前位置")?
        }
        None => {
            if tool_home_pointer(&data_root, &owner).is_none() {
                return Err("工具整体已在默认位置，无需迁移。".into());
            }
            default_tool_root(&data_root)
        }
    };
    state.0.begin();
    let worker = app.clone();
    std::thread::spawn(move || {
        match run_tool_home_migration(&worker, Some(target)) {
            Ok(report) => worker.state::<ToolHomeMigration>().0.finish(report),
            Err(error) => worker.state::<ToolHomeMigration>().0.finish(format!("迁移失败：{error}")),
        }
    });
    status(&app)
}

/// 前端解析工具分区目录（projects / installed / backups）。返回的路径已经
/// 按当前账号解析好（自定义 home 无账号层、默认位置带账号层）——前端不再
/// 自己拼账号段。取代 `user_data_dir("tools", …)`：那个命令是共享基础设施，
/// 不能为工具单独改行为。
#[tauri::command]
pub async fn tools_root_dir(app: AppHandle, directory: String) -> Result<String, String> {
    if !matches!(directory.as_str(), "projects" | "installed" | "backups") {
        return Err(format!("未知的工具目录类型：{directory}"));
    }
    let host = app.state::<ToolsHost>();
    let data_root = host.data_root()?;
    let owner = ToolStore::new(&data_root).owner()?;
    Ok(display_path(&tool_partition(&data_root, &owner, &directory)))
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

    fn write_home_pointer_file(data_root: &Path, owner: &str, home: Option<&str>) {
        let dir = data_root.join("configuration").join("tool-locations");
        fs::create_dir_all(&dir).unwrap();
        let body = match home {
            Some(home) => serde_json::json!({ "toolHome": home }).to_string(),
            None => serde_json::json!({}).to_string(),
        };
        fs::write(dir.join(format!("{owner}.json")), body).unwrap();
    }

    #[test]
    fn pointer_overrides_default_per_account_and_empty_value_falls_back() {
        let root = temp_root("pointer");
        // 无指针：默认位置，分区带账号层
        assert_eq!(tool_home(&root, "u1"), root.join("tools"));
        assert_eq!(
            tool_partition(&root, "u1", "installed"),
            root.join("tools").join("installed").join("u1")
        );
        assert_eq!(
            tool_storage_root(&root, "u1"),
            root.join("tools").join("storage").join("u1")
        );
        // 指针指向自定义家：分区不带账号层
        write_home_pointer_file(&root, "u1", Some("D:/AAW-home"));
        assert_eq!(tool_home(&root, "u1"), PathBuf::from("D:/AAW-home"));
        assert_eq!(tool_partition(&root, "u1", "installed"), PathBuf::from("D:/AAW-home/installed"));
        assert_eq!(tool_storage_root(&root, "u1"), PathBuf::from("D:/AAW-home/storage"));
        // 空值 = 没设置
        write_home_pointer_file(&root, "u1", Some("  "));
        assert_eq!(tool_home(&root, "u1"), root.join("tools"));
        // 账号隔离：u2 没指针，不受 u1 影响
        write_home_pointer_file(&root, "u1", Some("D:/AAW-home"));
        assert_eq!(tool_home(&root, "u2"), root.join("tools"));
    }

    #[test]
    fn structural_pairs_moves_account_layer_across_styles() {
        // 默认家 → 自定义家：去掉账号层
        let pairs = structural_pairs(
            "u1",
            Path::new("C:/data/tools"),
            Path::new("D:/home"),
            true,
            false,
        );
        let installed = pairs.iter().find(|(from, _)| from.contains("installed")).unwrap();
        assert_eq!(installed.0, "C:/data/tools/installed/u1/");
        assert_eq!(installed.1, "D:/home/installed/");
        assert!(pairs.iter().any(|(from, _)| from.ends_with("installed\\u1\\")));
        // 自定义家 → 默认家：加回账号层
        let pairs = structural_pairs(
            "u1",
            Path::new("D:/home"),
            Path::new("C:/data/tools"),
            false,
            true,
        );
        let projects = pairs.iter().find(|(from, _)| from.contains("projects")).unwrap();
        assert_eq!(projects.0, "D:/home/projects/");
        assert_eq!(projects.1, "C:/data/tools/projects/u1/");
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
        // 源不动（删旧是迁移自己的事）
        assert!(source.join("installed/a.json").exists());
    }

    #[test]
    fn remap_preferences_rewrites_structural_prefixes() {
        let root = temp_root("remap");
        let config = root.join("configuration");
        fs::create_dir_all(&config).unwrap();
        let prefs = serde_json::json!({
            "aaw-desktop.tools.v1": [{ "dir": "C:/data/tools/installed/u1/pilot" }],
            "aaw-desktop/workspace/v1": { "recentExclusions": ["C:/data/tools/projects/u1/notes"] },
        });
        fs::write(config.join("preferences.json"), prefs.to_string()).unwrap();
        let pairs = structural_pairs("u1", Path::new("C:/data/tools"), Path::new("D:/home"), true, false);
        remap_preferences(&root, &pairs);
        let text = fs::read_to_string(config.join("preferences.json")).unwrap();
        assert!(text.contains("D:/home/installed/pilot"), "{text}");
        assert!(text.contains("D:/home/projects/notes"), "{text}");
        assert!(!text.contains("C:/data/tools"), "{text}");
    }

    #[test]
    fn classify_destinations_tells_residue_from_conflict() {
        // ≥2 个非空已知分区 → 残骸，全部清理（含空壳）
        let root = temp_root("classify-residue");
        for name in ["installed", "projects"] {
            fs::create_dir_all(root.join(name)).unwrap();
            fs::write(root.join(name).join("marker"), b"x").unwrap();
        }
        fs::create_dir_all(root.join("backups")).unwrap(); // 空壳也算进清理
        let destinations: Vec<(&'static str, PathBuf)> = PARTITIONS
            .iter()
            .map(|name| (*name, root.join(name)))
            .collect();
        match classify_destinations(&destinations) {
            DestinationState::Leftover { paths } => {
                assert_eq!(paths.len(), 3, "两个非空分区 + 一个空壳");
                assert!(paths.contains(&root.join("backups")));
            }
            other => panic!("应为残骸，实际 {other:?}"),
        }
        // 单个非空分区且无暂存目录 → 真冲突
        let root = temp_root("classify-conflict");
        fs::create_dir_all(root.join("projects")).unwrap();
        fs::write(root.join("projects/user-code.txt"), b"mine").unwrap();
        let destinations: Vec<(&'static str, PathBuf)> = PARTITIONS
            .iter()
            .map(|name| (*name, root.join(name)))
            .collect();
        match classify_destinations(&destinations) {
            DestinationState::Conflict { name, dest } => {
                assert_eq!(name, "projects");
                assert_eq!(dest, root.join("projects"));
            }
            other => panic!("应为冲突，实际 {other:?}"),
        }
        // 单个非空分区 + 暂存目录 → 残骸（暂存目录是复制被杀的现场）
        fs::create_dir_all(root.join(".aaw-stage-projects-deadbeef")).unwrap();
        match classify_destinations(&destinations) {
            DestinationState::Leftover { paths } => assert_eq!(paths.len(), 1),
            other => panic!("有暂存目录应为残骸，实际 {other:?}"),
        }
        // 全空壳 → 清壳不算冲突
        let root = temp_root("classify-shell");
        fs::create_dir_all(root.join("storage")).unwrap();
        let destinations: Vec<(&'static str, PathBuf)> = PARTITIONS
            .iter()
            .chain(std::iter::once(&"storage"))
            .map(|name| (*name, root.join(name)))
            .collect();
        match classify_destinations(&destinations) {
            DestinationState::Leftover { paths } => assert_eq!(paths, vec![root.join("storage")]),
            other => panic!("空壳应清掉，实际 {other:?}"),
        }
        // 什么都没有 → 干净
        let root = temp_root("classify-vacant");
        let destinations: Vec<(&'static str, PathBuf)> = PARTITIONS
            .iter()
            .map(|name| (*name, root.join(name)))
            .collect();
        assert!(matches!(classify_destinations(&destinations), DestinationState::Vacant));
    }

    #[test]
    fn validate_target_distinguishes_collision_from_no_change() {
        let mine = temp_root("collision-mine");
        let other = temp_root("collision-other");
        let same_as_other = format!("{}", other.display());
        // 与别的受保护根相同 → 撞车文案，不含「没有变化」
        let error = validate_target(
            &same_as_other,
            &[
                (mine.clone(), "工具整体当前位置".into()),
                (other.clone(), "账号 x 的工具目录".into()),
            ],
            "工具整体当前位置",
        )
        .unwrap_err();
        assert!(error.contains("账号 x") && !error.contains("没有变化"), "{error}");
        // 与当前根相同 → 才是「没有变化」
        let error = validate_target(
            &mine.display().to_string(),
            &[
                (mine, "工具整体当前位置".into()),
                (other, "账号 x 的工具目录".into()),
            ],
            "工具整体当前位置",
        )
        .unwrap_err();
        assert!(error.contains("没有变化"), "{error}");
    }
}
