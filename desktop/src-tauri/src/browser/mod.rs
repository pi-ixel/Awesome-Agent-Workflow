pub mod action;
pub mod data;
pub mod diagnostics;
pub mod dialog;
pub mod download;
pub mod enhancements;
pub mod evidence;
pub mod host;
pub mod identity;
pub mod mcp;
pub mod model;
pub mod native_dialog;
pub mod runtime;
pub mod restore;
pub mod security;
pub mod tool;
#[cfg(windows)]
mod profile;
#[cfg(windows)]
mod webview2;
#[cfg(all(windows, feature = "webview2-profile-ci"))]
pub mod bench;

#[cfg(test)]
mod tests;

/// 站点 WebView 没有工作台样式，仅在 AAW 注入的浮层根节点上定义共享变量。
fn with_overlay_radii(script: &str) -> String {
    let declarations = include_str!("../../../src/shared/styles/radii.css")
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with("--radius-"))
        .collect::<String>();
    script.replace("__AAW_RADIUS_DECLARATIONS__", &declarations)
}
