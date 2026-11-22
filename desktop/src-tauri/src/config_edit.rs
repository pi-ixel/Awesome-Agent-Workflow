use serde_yaml::{Mapping, Value};
use std::{
    fs::{self, File, OpenOptions, TryLockError},
    io,
    path::Path,
    thread,
    time::{Duration, Instant},
};

/// 与 iCode 使用相同的文件锁序列化 Profile 的读改写。崩溃时由系统释放。
pub(crate) fn lock_file(path: &Path) -> io::Result<File> {
    match fs::symlink_metadata(path) {
        Ok(meta) if !meta.is_file() => return Err(io::Error::other("配置锁路径无效")),
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)?;
    let start = Instant::now();
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(TryLockError::WouldBlock) if start.elapsed() < Duration::from_secs(1) => {
                thread::sleep(Duration::from_millis(40));
            }
            Err(TryLockError::WouldBlock) => {
                return Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "配置正在写入，请稍后重试",
                ));
            }
            Err(TryLockError::Error(error)) => return Err(error),
        }
    }
}

/// 只重写变更的顶层字段，回读完整文档确保其他字段的数据保持原样。
pub(crate) fn replace_section(
    original: &str,
    key: &str,
    updated: &Value,
) -> Result<String, String> {
    let mut section = Mapping::new();
    section.insert(key.into(), updated[key].clone());
    let replacement = serde_yaml::to_string(&section).map_err(|_| "无法编码 YAML 配置")?;
    let replacement = if original.contains("\r\n") {
        replacement.replace('\n', "\r\n")
    } else {
        replacement
    };
    let mut lines = original.split_inclusive('\n').peekable();
    let mut result = String::new();
    let mut replaced = false;
    while let Some(line) = lines.next() {
        let plain = line.strip_prefix('\u{feff}').unwrap_or(line);
        let key_line = plain.strip_prefix(key).is_some_and(|s| s.starts_with(':'));
        if key_line {
            replaced = true;
            if line != plain {
                result.push('\u{feff}');
            }
            result.push_str(&replacement);
            while lines.peek().is_some_and(|line| {
                (!line.trim().is_empty() && line.starts_with(char::is_whitespace))
                    || line.starts_with("- ")
            }) {
                lines.next();
            }
        } else if !replaced && plain.trim_end() == "..." {
            replaced = true;
            result.push_str(&replacement);
            result.push_str(line);
        } else {
            result.push_str(line);
        }
    }
    if !replaced {
        if !result.is_empty() && !result.ends_with('\n') {
            result.push_str(if original.contains("\r\n") {
                "\r\n"
            } else {
                "\n"
            });
        }
        result.push_str(&replacement);
    }
    if serde_yaml::from_str::<Value>(&result).ok().as_ref() != Some(updated) {
        return Err("配置格式无法无损更新，请在 Agent 中修改".into());
    }
    Ok(result)
}
