//! 十二项能力里"要碰操作系统"的那几项：文件、剪切板、系统信息、密钥、通知、总线。
//!
//! 这一层只做**动作**，不认识调用方是谁。身份、作用域、配额判断在 `caps.rs`：
//! 那里知道 origin、知道是哪个工具。分开的理由很实际——把这些和分发写在一个
//! 大 match 里，改一个文件对话框要读两千行才能确认没碰到别的能力。
//!
//! # 与 Electron 版的语义对照
//!
//! Electron 侧这些能力全在 `main.mjs` 的 `ipcMain.handle` 里，靠 `safeStorage`
//! 与 `dialog`。这里换成 Tauri 的对话框插件、系统 DPAPI、通知插件。**作者看到
//! 的函数签名与返回值形状不变**，这是契约层不动、只换载体的具体含义。

use std::io::Write;
use std::path::{Path, PathBuf};

use super::limits::LIMITS;
use base64::Engine;
use serde_json::{json, Value};

/// 能力层的统一结果：错误是给人看的一句话，直接回给页面。
pub type CapResult<T> = Result<T, String>;

const B64: base64::engine::general_purpose::GeneralPurpose = base64::engine::general_purpose::STANDARD;

// ── 文件 ─────────────────────────────────────────────────────────────────

/// `aawFiles.open` 的选项。字段名与契约一致，缺省值也一致。
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenOptions {
    #[serde(default)]
    pub accept: Vec<String>,
    #[serde(default)]
    pub multiple: bool,
    #[serde(default)]
    pub directory: bool,
    #[serde(default)]
    pub binary: bool,
}

/// 契约里的单文件上限：文本与二进制都是 32 MB。
/// 保存上限 8 MB。
/// 多选上限。
const MULTI_LIMIT: usize = 32;
/// 目录列举上限。
const ENTRY_LIMIT: usize = 200;

pub fn describe_file(path: &Path, binary: bool) -> CapResult<Value> {
    let name = path.file_name().map(|item| item.to_string_lossy().to_string()).unwrap_or_default();
    if path.is_dir() {
        let mut entries = Vec::new();
        for entry in std::fs::read_dir(path).map_err(|error| format!("读不到目录：{error}"))?.take(ENTRY_LIMIT) {
            let Ok(entry) = entry else { continue };
            let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
            entries.push(json!({
                "name": entry.file_name().to_string_lossy(),
                "isDirectory": is_dir,
            }));
        }
        return Ok(json!({
            "name": name,
            "path": path.to_string_lossy(),
            "isDirectory": true,
            "entries": entries,
        }));
    }
    let meta = std::fs::metadata(path).map_err(|error| format!("读不到文件：{error}"))?;
    if meta.len() > LIMITS.user_file_bytes {
        return Err(format!("文件超过 {} MB，请先拆小再打开。", LIMITS.user_file_bytes / 1024 / 1024));
    }
    let mut value = json!({
        "name": name,
        "path": path.to_string_lossy(),
        "size": meta.len(),
        "isDirectory": false,
    });
    if !binary {
        match std::fs::read(path) {
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(text) => { value["text"] = json!(text); }
                // 不是 UTF-8 就给空文本而不是报错：用户可能只是选错了一个二进制，
                // 界面上让 `text` 为空比整条调用失败更好处理。
                Err(_) => { value["text"] = json!(""); }
            },
            Err(error) => return Err(format!("读不到文件：{error}")),
        }
    } else {
        let bytes = std::fs::read(path).map_err(|error| format!("读不到文件：{error}"))?;
        value["bytes"] = json!(B64.encode(bytes));
    }
    Ok(value)
}

pub fn read_files(paths: Vec<PathBuf>, options: &OpenOptions) -> CapResult<Value> {
    let mut out = Vec::new();
    for path in paths.into_iter().take(MULTI_LIMIT) {
        out.push(describe_file(&path, options.binary)?);
    }
    if options.multiple {
        Ok(json!(out))
    } else {
        Ok(out.into_iter().next().unwrap_or(Value::Null))
    }
}

pub fn save_file(path: &Path, data: &str, binary: bool) -> CapResult<bool> {
    let bytes = if binary {
        B64.decode(data).map_err(|_| "要保存的内容不是合法的 base64。".to_string())?
    } else {
        data.as_bytes().to_vec()
    };
    if bytes.len() > LIMITS.save_bytes {
        return Err(format!("保存内容不能超过 {} MB。", LIMITS.save_bytes / 1024 / 1024));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    std::fs::write(path, bytes).map_err(|error| format!("保存失败：{error}"))?;
    Ok(true)
}

// ── 剪切板 ───────────────────────────────────────────────────────────────

/// 文本上限 1 MB。剪切板是给"一句话"用的，不是传输通道。

pub fn check_clipboard_text(text: &str) -> CapResult<()> {
    if text.len() > LIMITS.clipboard_text_bytes {
        return Err("剪切板文本不能超过 1 MB。".into());
    }
    Ok(())
}

// ── 系统信息 ─────────────────────────────────────────────────────────────

/// 只读白名单。**没有**进程列表、没有环境变量全集——这些是"能读不代表该给"。
pub fn system_info() -> Value {
    let (total, free) = memory();
    let (disk_total, disk_free) = disk();
    json!({
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "osVersion": os_version(),
        "cpus": std::thread::available_parallelism().map(|value| value.get()).unwrap_or(1),
        "totalMemory": total,
        "freeMemory": free,
        "homedir": home_dir().to_string_lossy(),
        "tmpdir": std::env::temp_dir().to_string_lossy(),
        "disk": { "total": disk_total, "free": disk_free },
    })
}

fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_default()
}

fn os_version() -> String {
    #[cfg(windows)]
    {
        // `GetVersionEx` 在 Win8.1 之后会说谎，但这里只要一个"大致是什么系统"，
        // 不参与任何判断。拿不到就空串，别为它引入一整个 os_info 依赖。
        std::env::var("OS").unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        std::fs::read_to_string("/proc/sys/kernel/osrelease")
            .map(|text| text.trim().to_string())
            .unwrap_or_default()
    }
}

#[cfg(windows)]
fn memory() -> (u64, u64) {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    unsafe {
        let mut status: MEMORYSTATUSEX = std::mem::zeroed();
        status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        if GlobalMemoryStatusEx(&mut status) != 0 {
            (status.ullTotalPhys, status.ullAvailPhys)
        } else {
            (0, 0)
        }
    }
}

#[cfg(not(windows))]
fn memory() -> (u64, u64) {
    let text = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
    let read = |key: &str| -> u64 {
        text.lines()
            .find(|line| line.starts_with(key))
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|value| value.parse::<u64>().ok())
            .map(|kb| kb * 1024)
            .unwrap_or(0)
    };
    (read("MemTotal:"), read("MemAvailable:"))
}

#[cfg(windows)]
fn disk() -> (u64, u64) {
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let root: Vec<u16> = std::env::var("SystemDrive")
        .unwrap_or_else(|_| "C:".into())
        .encode_utf16()
        .chain(std::iter::once('\\' as u16))
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        let mut free = 0u64;
        let mut total = 0u64;
        if GetDiskFreeSpaceExW(root.as_ptr(), &mut free, &mut total, std::ptr::null_mut()) != 0 {
            (total, free)
        } else {
            (0, 0)
        }
    }
}

#[cfg(not(windows))]
fn disk() -> (u64, u64) {
    (0, 0)
}

// ── 密钥 ─────────────────────────────────────────────────────────────────

/// 密钥文件：`<storage>/tools/secrets/<owner>/<tool>.json`，值是 base64 密文。
pub struct SecretStore {
    root: PathBuf,
    owner: String,
}

impl SecretStore {
    pub fn new(storage_root: &Path, owner: &str) -> Self {
        Self {
            root: storage_root.join("tools").join("secrets").join(owner),
            owner: owner.to_string(),
        }
    }

    fn file(&self, tool_id: &str) -> PathBuf {
        self.root.join(format!("{tool_id}.json"))
    }

    fn read_all(&self, tool_id: &str) -> std::collections::BTreeMap<String, String> {
        std::fs::read_to_string(self.file(tool_id))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    fn write_all(&self, tool_id: &str, value: &std::collections::BTreeMap<String, String>) -> CapResult<()> {
        std::fs::create_dir_all(&self.root).map_err(|error| format!("建密钥目录失败：{error}"))?;
        let path = self.file(tool_id);
        let temp = path.with_extension("json.tmp");
        let body = serde_json::to_vec(value).map_err(|error| error.to_string())?;
        let mut file = std::fs::File::create(&temp).map_err(|error| format!("写入失败：{error}"))?;
        file.write_all(&body).map_err(|error| format!("写入失败：{error}"))?;
        file.sync_all().ok();
        std::fs::rename(&temp, &path).map_err(|error| format!("落盘失败：{error}"))
    }

    /// 该工具的密钥前缀，只用于日志排障，不含任何明文。
    pub fn owner_hint(&self) -> &str {
        &self.owner
    }

    pub fn set(&self, tool_id: &str, name: &str, value: &str) -> CapResult<bool> {
        check_secret_name(name)?;
        let mut all = self.read_all(tool_id);
        all.insert(name.to_string(), B64.encode(protect(value.as_bytes())?));
        self.write_all(tool_id, &all)?;
        Ok(true)
    }

    pub fn get(&self, tool_id: &str, name: &str) -> CapResult<Value> {
        check_secret_name(name)?;
        let Some(encoded) = self.read_all(tool_id).get(name).cloned() else {
            return Ok(Value::Null);
        };
        let cipher = B64.decode(encoded).map_err(|_| "密钥数据损坏。".to_string())?;
        let plain = unprotect(&cipher)?;
        Ok(json!(String::from_utf8_lossy(&plain)))
    }

    pub fn delete(&self, tool_id: &str, name: &str) -> CapResult<bool> {
        check_secret_name(name)?;
        let mut all = self.read_all(tool_id);
        if all.remove(name).is_none() {
            return Ok(false);
        }
        self.write_all(tool_id, &all)?;
        Ok(true)
    }
}

fn check_secret_name(name: &str) -> CapResult<()> {
    if name.is_empty() || name.chars().count() > 200 || name.chars().any(|ch| (ch as u32) < 0x20) {
        return Err("密钥名必须是 1–200 个可见字符。".into());
    }
    Ok(())
}

/// Windows DPAPI：绑定当前用户，换账户或换机器解不开。**不落明文**。
#[cfg(windows)]
fn protect(plain: &[u8]) -> CapResult<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN};
    unsafe {
        let mut input = CRYPT_INTEGER_BLOB { cbData: plain.len() as u32, pbData: plain.as_ptr() as *mut u8 };
        let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        let ok = CryptProtectData(
            &mut input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        );
        if ok == 0 {
            return Err("系统加密失败，密钥没有保存。".into());
        }
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as *mut core::ffi::c_void);
        Ok(bytes)
    }
}

#[cfg(windows)]
fn unprotect(cipher: &[u8]) -> CapResult<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN};
    unsafe {
        let mut input = CRYPT_INTEGER_BLOB { cbData: cipher.len() as u32, pbData: cipher.as_ptr() as *mut u8 };
        let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        let ok = CryptUnprotectData(
            &mut input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        );
        if ok == 0 {
            return Err("密钥解不开：它可能是在另一台机器或另一个账户下保存的。".into());
        }
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as *mut core::ffi::c_void);
        Ok(bytes)
    }
}

/// 非 Windows 上不假装加密。
///
/// 用"自己发明的 XOR"骗过 `aawSecrets` 的调用方，比直接报错糟得多：用户会以为
/// 密钥是安全的，然后把它存进一个明文文件。这里明确失败，让人知道该找管理员。
#[cfg(not(windows))]
fn protect(_plain: &[u8]) -> CapResult<Vec<u8>> {
    Err("当前平台没有系统加密存储，aawSecrets 暂不可用。".into())
}

#[cfg(not(windows))]
fn unprotect(_cipher: &[u8]) -> CapResult<Vec<u8>> {
    Err("当前平台没有系统加密存储，aawSecrets 暂不可用。".into())
}

// ── 总线 ─────────────────────────────────────────────────────────────────

/// 工具间的在线广播。
///
/// **不保留历史**（Electron 版同一语义）：只保留最近 `KEEP` 条用于短轮询窗口，
/// 更早的丢弃。页面侧每 800 ms 拉一次，最多晚 0.8 秒——对"工具之间互相通知"
/// 足够，而且不需要在自定义协议上做流式连接（那玩意儿在 WebView2 上要另写
/// 一整套）。
pub struct Bus {
    inner: std::sync::Mutex<BusInner>,
}

struct BusInner {
    seq: u64,
    messages: std::collections::VecDeque<(u64, String, Value)>,
}

impl Default for Bus {
    fn default() -> Self {
        Self { inner: std::sync::Mutex::new(BusInner { seq: 0, messages: std::collections::VecDeque::new() }) }
    }
}


impl Bus {
    pub fn emit(&self, topic: &str, payload: Value) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.seq += 1;
            let seq = inner.seq;
            inner.messages.push_back((seq, topic.to_string(), payload));
            while inner.messages.len() > LIMITS.bus_keep {
                inner.messages.pop_front();
            }
        }
    }

    /// 取出 `cursor` 之后的新消息，以及新的 cursor。
    pub fn poll(&self, cursor: u64, topic: Option<&str>) -> (u64, Vec<Value>) {
        let Ok(inner) = self.inner.lock() else { return (cursor, Vec::new()) };
        let mut next = cursor;
        let mut out = Vec::new();
        for (seq, item_topic, payload) in inner.messages.iter() {
            if *seq <= cursor {
                continue;
            }
            next = next.max(*seq);
            if topic.is_some_and(|wanted| wanted != item_topic) {
                continue;
            }
            out.push(json!({ "seq": seq, "topic": item_topic, "payload": payload }));
        }
        (next, out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bus_poll_returns_only_newer_messages() {
        let bus = Bus::default();
        bus.emit("a", json!(1));
        bus.emit("b", json!(2));
        let (cursor, messages) = bus.poll(0, None);
        assert_eq!(messages.len(), 2);
        assert_eq!(cursor, 2);
        // 同一个 cursor 再拉一次：没有新消息。
        assert!(bus.poll(cursor, None).1.is_empty());
    }

    #[test]
    fn bus_poll_filters_by_topic_but_advances_cursor() {
        let bus = Bus::default();
        bus.emit("a", json!(1));
        bus.emit("b", json!(2));
        let (cursor, messages) = bus.poll(0, Some("b"));
        assert_eq!(messages.len(), 1);
        // 订阅 a 的工具不能因为过滤就永远收到旧消息。
        assert_eq!(cursor, 2);
    }

    #[test]
    fn clipboard_text_is_capped() {
        assert!(check_clipboard_text("hi").is_ok());
        assert!(check_clipboard_text(&"x".repeat(LIMITS.clipboard_text_bytes + 1)).is_err());
    }
}
