//! 契约兼容性关口。
//!
//! # 它为什么必须在 Rust 里
//!
//! P3 之前，打开工具的链路上有一道判定在 Electron 的 `runtime.mjs` 里：不兼容
//! 就加载一张说明页，而不是白屏。现在窗口由 Rust 建，判定必须跟着过来，否则
//! "工具要求第 99 代契约、宿主只有第 2 代"会表现为**窗口开出来一片空白**，
//! 用户只会觉得 AAW 坏了。
//!
//! # 两种不兼容，说法不一样
//!
//! | 情形 | 谁的问题 | 用户能做什么 |
//! |---|---|---|
//! | `requires.contract` 比宿主高 | 宿主太旧 | 升级 AAW |
//! | 依赖了宿主没有的能力 | 工具太新，或能力已被移除 | 装支持当前版本的版本，或让作者改 |
//!
//! 这两种要分开说。混成一句"插件不兼容"，用户既不知道要不要升级，也不知道该
//! 找谁。措辞与前端 `compat.ts` 的 `explainIncompatibility` 保持同一口径：
//! 那里管安装关口（装的时候就拦住），这里管打开关口（装完宿主降级、或能力被
//! 移除之后才发生的）。
//!
//! # 没写 `requires` 一律放行
//!
//! 存量工具一个都不该因为这道关要改。缺省 = 不声明任何要求，这是最强的向后
//! 兼容承诺，也是当初设计 `requires` 时唯一没争议的决定。

use super::manifest::ToolManifest;

/// 判定一个工具能不能在当前宿主上打开。
///
/// 只读清单，不看文件系统：这道关要能在"窗口还没建"的时刻给出答案。
pub fn check(manifest: &ToolManifest) -> Result<(), String> {
    let Some(requires) = &manifest.requires else { return Ok(()) };

    if requires.contract > super::CONTRACT_GENERATION {
        return Err(format!(
            "「{}」需要第 {} 代契约，当前宿主的契约是第 {} 代。这个工具比 AAW 新：请先升级 AAW 桌面版。",
            manifest.name, requires.contract, super::CONTRACT_GENERATION
        ));
    }

    let available = super::caps_capability_names();
    let missing: Vec<&str> = requires
        .capabilities
        .iter()
        .map(String::as_str)
        .filter(|name| !available.contains(name))
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "「{}」依赖了当前宿主没有的能力：{}。多半是这个能力已经被移除了；装一个支持当前版本的版本，或让作者去掉对它的依赖。",
            manifest.name,
            missing.join("、")
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::manifest;

    fn tool(extra: serde_json::Value) -> ToolManifest {
        let mut base = serde_json::json!({
            "id": "compat-sample", "name": "兼容样例", "version": "1.0.0", "html": "<p>x</p>",
        });
        for (key, value) in extra.as_object().cloned().unwrap_or_default() {
            base[key] = value;
        }
        manifest::from_value(&base).expect("清单应当解析成功")
    }

    #[test]
    fn absent_requires_is_always_fine() {
        // 存量工具一个都不该因为这道关而改。
        assert!(check(&tool(serde_json::json!({}))).is_ok());
    }

    #[test]
    fn a_tool_from_the_future_names_both_generations() {
        let error = check(&tool(serde_json::json!({ "requires": { "contract": 99 } }))).unwrap_err();
        assert!(error.contains("第 99 代"), "{error}");
        assert!(error.contains("第 2 代"), "{error}");
        assert!(error.contains("升级"), "{error}");
    }

    #[test]
    fn missing_capabilities_are_listed_one_by_one() {
        let error = check(&tool(serde_json::json!({
            "requires": { "capabilities": ["files", "clipboard", "telepathy"] },
        })))
        .unwrap_err();
        assert!(error.contains("telepathy"), "{error}");
        assert!(!error.contains("files"), "{error}");
        assert!(!error.contains("clipboard"), "{error}");
    }

    #[test]
    fn everything_declared_and_available_passes() {
        assert!(check(&tool(serde_json::json!({
            "requires": { "contract": 2, "capabilities": ["files", "bus"] },
        })))
        .is_ok());
    }
}
