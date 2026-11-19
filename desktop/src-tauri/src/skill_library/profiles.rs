use super::*;
use serde_yaml::Value;
use std::io::Write;

pub(super) fn read(path: &Path) -> Result<Value> {
    match fs::read(path) {
        Ok(bytes) => serde_yaml::from_slice(&bytes).map_err(error),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Value::Mapping(Default::default())),
        Err(e) => Err(e),
    }
}
pub(super) fn inline_entry(path: &Path, value: &Value) -> Result<Entry> {
    let preview = serde_yaml::to_string(value).map_err(error)?;
    let name = value["name"]
        .as_str()
        .ok_or_else(|| error("配置内技能缺少名称"))?;
    Ok(Entry {
        name: name.into(),
        description: value["description"].as_str().unwrap_or("").into(),
        path: path.into(),
        source: path.into(),
        real_path: path.canonicalize()?,
        revision: digest(preview.as_bytes()),
        preview,
        is_link: false,
        kind: Kind::Inline,
        status: "配置内定义".into(),
        status_label: None,
        skill_file_path: None,
        usage_count: None,
    })
}

// 只重写有变化的顶层字段，并用完整文档回读核对，保留其他字段的注释和格式。
fn replace_section(original: &str, key: &str, updated: &Value) -> Result<String> {
    let mut section = serde_yaml::Mapping::new();
    section.insert(key.into(), updated[key].clone());
    let replacement = serde_yaml::to_string(&section).map_err(error)?;
    let mut lines = original.split_inclusive('\n').peekable();
    let mut result = String::new();
    let mut replaced = false;
    while let Some(line) = lines.next() {
        if line.strip_prefix(key).is_some_and(|s| s.starts_with(':')) {
            replaced = true;
            result.push_str(&replacement);
            while lines
                .peek()
                .is_some_and(|s| s.starts_with(char::is_whitespace) || s.starts_with("- "))
            {
                lines.next();
            }
        } else {
            result.push_str(line);
        }
    }
    if !replaced {
        result.push('\n');
        result.push_str(&replacement);
    }
    if serde_yaml::from_str::<Value>(&result).map_err(error)? != *updated {
        return Err(error("配置格式无法无损更新，请在 iCode 中修改"));
    }
    Ok(result)
}

pub(super) fn edit<T>(
    path: &Path,
    key: &str,
    change: impl FnOnce(&mut Value) -> Result<T>,
) -> Result<T> {
    let path = path.canonicalize()?;
    let original = fs::read_to_string(&path)?;
    let mut data: Value = serde_yaml::from_str(&original).map_err(error)?;
    let result = change(&mut data)?;
    let updated = replace_section(&original, key, &data)?;
    let mut tmp = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
    tmp.write_all(updated.as_bytes())?;
    tmp.as_file()
        .set_permissions(fs::metadata(&path)?.permissions())?;
    tmp.as_file().sync_all()?;
    if fs::read_to_string(&path)? != original {
        return Err(error("配置已变化，请刷新后重试"));
    }
    tmp.persist(path).map_err(|e| e.error)?;
    Ok(result)
}
pub(super) fn inline_values(data: &mut Value) -> Result<&mut Vec<Value>> {
    if !data.is_mapping() {
        return Err(error("配置必须是 YAML 映射"));
    }
    let skills = &mut data["skills"];
    if skills.is_null() {
        *skills = Value::Mapping(Default::default());
    }
    if !skills.is_mapping() {
        return Err(error("skills 配置格式错误"));
    }
    if skills["inline"].is_null() {
        skills["inline"] = Value::Sequence(vec![]);
    }
    skills["inline"]
        .as_sequence_mut()
        .ok_or_else(|| error("skills.inline 格式错误"))
}
pub(super) fn enable(profile: &Path, root: &Path) -> Result<()> {
    // 只为当前档案加入用户选中的绝对路径，不打开所有项目的自动加载。
    edit(profile, "skills", |data| {
        if !data.is_mapping() {
            return Err(error("配置必须是 YAML 映射"));
        }
        let skills = &mut data["skills"];
        if skills.is_null() {
            *skills = Value::Mapping(Default::default());
        }
        if !skills.is_mapping() {
            return Err(error("skills 配置格式错误"));
        }
        if skills["paths"].is_null() {
            skills["paths"] = Value::Sequence(vec![]);
        }
        let paths = skills["paths"]
            .as_sequence_mut()
            .ok_or_else(|| error("skills.paths 格式错误"))?;
        let path = Value::String(root.to_string_lossy().into_owned());
        if !paths.contains(&path) {
            paths.push(path);
        }
        Ok(())
    })
}
