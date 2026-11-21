//! 工具清单的 Rust 侧读取。
//!
//! P0 只解析宿主真正要用的字段：身份、窗口标题、设置默认值、网络声明、动作列表。
//! 其余字段（`build`、`runtime`、`description`…）留给 P1 落地——现在把它们读进
//! 结构体只会造出一批没人读的字段，等 schema 冻结时再一次性补。
//!
//! 这里刻意**不做完整校验**。校验在 `runtime/package.ts` 里已经有一份成熟实现
//! （R1–R11、体积上限、依赖清单），P0 不复制它——两份规则一旦漂移，就会出现
//! "界面说能装、运行时说不能用"（设计稿 §7.5 的 P5）。到 P4 才把校验搬进 Rust，
//! 那时是搬而不是抄。

use std::path::Path;

use serde::{Deserialize, Serialize};

/// 网络声明。语义与 `package.ts` 的 `readNetworkRule` 一致。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct NetworkRule {
    /// 显式 `network: false` 时这里是 false，CSP 收成 `connect-src 'none'`。
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 允许连接的域名白名单（`*.corp.example.com`、`host:port`）。
    #[serde(default)]
    pub hosts: Vec<String>,
    /// 允许自签证书的域名。
    #[serde(default)]
    pub insecure: Vec<String>,
}

fn default_true() -> bool {
    true
}

/// 设置项的默认值来源。
///
/// 只取 `id` 与 `default` 两个字段：工具的 `window.aawSettings` 需要的是**值**，
/// 类型、标签、选项都是界面的事，宿主不关心。
#[derive(Debug, Clone, Deserialize)]
pub struct SettingsField {
    id: String,
    #[serde(default)]
    default: serde_json::Value,
}

/// 动作声明的子集。P0 只用来在诊断页显示"这个工具声明了哪些动作"。
#[derive(Debug, Clone, Deserialize)]
pub struct ActionDecl {
    pub id: String,
    #[serde(default)]
    pub description: String,
}

/// 工具清单。
///
/// `rename_all = "camelCase"` 不能省：清单是给前端与作者看的 JSON，字段全是
/// `settingsSchema`、`settings_schema` 这种驼峰。少了它 serde 会静默给默认值——
/// P0 第一版的 `aawSettings` 就是空的 `{}`，页面看起来"注入成功"，实际什么都没有。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolManifest {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub settings_schema: Vec<SettingsField>,
    #[serde(default)]
    pub actions: Vec<ActionDecl>,
    #[serde(default)]
    pub permissions: Permissions,
    /// 声明了 `build.out` 就是 L2（打包页），否则 L1。P0 不用它，但先读出来，
    /// 免得后面判断载体时又要改一次解析。
    #[serde(default)]
    pub build: Option<BuildDecl>,
    /// 声明了 `runtime.kind == "process"` 就是 L3。P0 不执行它。
    #[serde(default)]
    pub runtime: Option<RuntimeDecl>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Permissions {
    #[serde(default)]
    pub network: Option<NetworkRuleInput>,
}

/// 清单里 `permissions.network` 可以是 `false` 或 `{ hosts: [...] }`，
/// 两种写法都要认（与 `readNetworkRule` 保持一致）。
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum NetworkRuleInput {
    Enabled(bool),
    Rule(NetworkRuleFields),
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct NetworkRuleFields {
    #[serde(default)]
    pub hosts: Vec<String>,
    #[serde(default)]
    pub insecure: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BuildDecl {
    #[serde(default)]
    pub entry: String,
    pub out: String,
    #[serde(default)]
    pub command: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RuntimeDecl {
    pub kind: String,
    #[serde(default)]
    pub entry: String,
}

impl ToolManifest {
    /// 网络规则归一化：`false` → 关闭；对象 → 开 + 白名单；缺失 → 开 + 全放行。
    pub fn network(&self) -> NetworkRule {
        match self.permissions.network.as_ref() {
            Some(NetworkRuleInput::Enabled(false)) => NetworkRule { enabled: false, ..Default::default() },
            Some(NetworkRuleInput::Enabled(true)) => NetworkRule::default(),
            Some(NetworkRuleInput::Rule(fields)) => NetworkRule {
                enabled: true,
                hosts: fields.hosts.clone(),
                insecure: fields.insecure.clone(),
            },
            None => NetworkRule::default(),
        }
    }

    /// 设置默认值。工具脚本常常第一行就读 `aawSettings["某个键"]`，
    /// 所以缺省值必须在这里补齐，不能等用户去管理页点一次保存。
    pub fn settings_defaults(&self) -> serde_json::Map<String, serde_json::Value> {
        let mut map = serde_json::Map::new();
        for field in &self.settings_schema {
            map.insert(field.id.clone(), field.default.clone());
        }
        map
    }

    /// 载体判定，只用于诊断显示。
    pub fn carrier(&self) -> &'static str {
        match self.runtime.as_ref().map(|item| item.kind.as_str()) {
            Some("process") => "L3 进程",
            _ if self.build.is_some() => "L2 打包页",
            _ => "L1 单页",
        }
    }
}

/// 从工具目录读清单。找不到或解析失败都返回人能看懂的错——这个错误会直接
/// 显示在窗口标题上，含混的话用户只会看到"工具打不开"。
pub fn read(dir: &Path) -> Result<ToolManifest, String> {
    let path = dir.join("manifest.json");
    let text = std::fs::read_to_string(&path)
        .map_err(|error| format!("读不到 {}：{error}", path.display()))?;
    let mut manifest: ToolManifest = serde_json::from_str(&text)
        .map_err(|error| format!("manifest.json 格式不对：{error}"))?;
    // 目录名与 id 不一致时以清单为准，但要留痕：工具目录是按 id 建的，
    // 两者不一致通常意味着作者改了 id 却没重新导出。
    if manifest.version.is_empty() {
        manifest.version = "0.0.0".into();
    }
    Ok(manifest)
}
