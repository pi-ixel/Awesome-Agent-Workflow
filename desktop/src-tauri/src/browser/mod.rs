pub mod action;
pub mod confirmation;
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
pub mod outcome;
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
#[cfg(test)]
mod confirmation_tests;
