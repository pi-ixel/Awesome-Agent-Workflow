//! Windows 系统通知与应用链接（ADR 034）。
//!
//! 通知插件在 Windows 上只在弹窗还显示时上报点击，进了通知中心再点就收不到。
//! 这里改为直接调用系统通知接口：点击时打开 `aaw://notification?...`，
//! 由链接拉起的进程把链接转交给已开着的实例后退出；没有实例时就带着链接正常启动。
//! 同一件事的通知用同一个标记，新的替换旧的；已处理的通知可以按标记删除。

use std::sync::Mutex;
#[cfg(windows)]
use std::sync::OnceLock;

use tauri::{AppHandle, Emitter, Manager};

/// 通知点击打开的链接前缀；只接受这一种链接。
pub const ROUTE_PREFIX: &str = "aaw://notification?";
/// 有新链接待取时发给前端的事件；前端收到后调用 `notification_routes_take`。
const ROUTE_EVENT: &str = "aaw://notification-route";
const ROUTE_LIMIT: usize = 4096;

/// 尚未被前端取走的链接（启动时带来的，或其他进程转交的）。
#[derive(Default)]
pub struct NotificationRoutes {
    queued: Mutex<Vec<String>>,
    #[cfg(windows)]
    relay: OnceLock<windows_relay::Registration>,
}

impl NotificationRoutes {
    fn push(&self, route: String) {
        let mut routes = self.queued.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        // 前端长时间不取时只保留最近的几条，避免无界增长。
        if routes.len() >= 16 {
            routes.remove(0);
        }
        routes.push(route);
    }
}

pub fn valid_route(route: &str) -> bool {
    route.starts_with(ROUTE_PREFIX) && route.len() <= ROUTE_LIMIT && !route.contains(['\r', '\n', '\0'])
}

/// 命令行里带的通知链接（由系统按 `aaw://` 链接拉起时）。
pub fn launch_route() -> Option<String> {
    std::env::args().skip(1).find(|arg| valid_route(arg))
}

fn deliver(app: &AppHandle, route: String) {
    app.state::<NotificationRoutes>().push(route);
    let _ = app.emit(ROUTE_EVENT, ());
}

#[tauri::command]
pub fn notification_routes_take(routes: tauri::State<'_, NotificationRoutes>) -> Vec<String> {
    std::mem::take(&mut *routes.queued.lock().unwrap_or_else(std::sync::PoisonError::into_inner))
}

/// 由标记得到系统接受的短标记（Windows 限 64 个字符），同一标记总是同一结果。
fn short_tag(tag: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in tag.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn xml_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c if (c as u32) < 0x20 && c != '\t' && c != '\n' => {}
            c => out.push(c),
        }
    }
    out
}

/// 点击后打开链接的通知内容。
pub fn toast_xml(title: &str, body: &str, route: &str) -> String {
    format!(
        r#"<toast activationType="protocol" launch="{}"><visual><binding template="ToastGeneric"><text>{}</text><text>{}</text></binding></visual></toast>"#,
        xml_escape(route),
        xml_escape(title),
        xml_escape(body)
    )
}

/// 发送通知。返回 false 表示本平台不走这条路，前端改用通知插件。
#[tauri::command]
pub async fn notification_show(
    app: AppHandle,
    title: String,
    body: String,
    route: String,
    tag: String,
) -> Result<bool, String> {
    if !valid_route(&route) {
        return Err("NOTIFICATION_ROUTE_INVALID".into());
    }
    #[cfg(windows)]
    {
        let identifier = app.config().identifier.clone();
        let route = app
            .state::<NotificationRoutes>()
            .relay
            .get()
            .map(|relay| relay.addressed_route(&route))
            .unwrap_or(route);
        tauri::async_runtime::spawn_blocking(move || {
            windows_impl::show(&identifier, &toast_xml(&title, &body, &route), &short_tag(&tag))
        })
        .await
        .map_err(|error| error.to_string())??;
        Ok(true)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, title, body, tag);
        Ok(false)
    }
}

/// 删除通知中心里这个标记的通知；没有则什么也不做。
#[tauri::command]
pub async fn notification_remove(app: AppHandle, tag: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        let identifier = app.config().identifier.clone();
        tauri::async_runtime::spawn_blocking(move || windows_impl::remove(&identifier, &short_tag(&tag)))
            .await
            .map_err(|error| error.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = (app, tag);
        Ok(())
    }
}

/// Holds this process's presence lock until the desktop exits.
pub struct DesktopLaunch {
    #[cfg(windows)]
    _presence: std::fs::File,
}

/// 普通启动和通知启动都必须先取得当前用户的唯一实例锁。
pub fn prepare_launch() -> Option<DesktopLaunch> {
    #[cfg(windows)]
    {
        let route = launch_route();
        match windows_relay::prepare(route.as_deref()) {
            Ok(Some(presence)) => Some(DesktopLaunch {
                _presence: presence,
            }),
            Ok(None) => None,
            Err(error) => {
                eprintln!("AAW 启动检查失败: {error}");
                let message = format!("{error}\n\n本次启动已退出。");
                let title: Vec<u16> = "AAW Desktop\0".encode_utf16().collect();
                let message: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
                unsafe {
                    windows_sys::Win32::UI::WindowsAndMessaging::MessageBoxW(
                        std::ptr::null_mut(),
                        message.as_ptr(),
                        title.as_ptr(),
                        windows_sys::Win32::UI::WindowsAndMessaging::MB_OK
                            | windows_sys::Win32::UI::WindowsAndMessaging::MB_ICONWARNING,
                    );
                }
                None
            }
        }
    }
    #[cfg(not(windows))]
    Some(DesktopLaunch {})
}

/// 应用启动时：注册链接、开始接收转交，并收下自己启动时带来的链接。
pub fn start(app: &AppHandle) -> std::io::Result<()> {
    if let Some(route) = launch_route() {
        app.state::<NotificationRoutes>().push(route);
    }
    #[cfg(windows)]
    {
        if let Err(error) = windows_impl::register(&app.config().identifier, app.config().product_name.as_deref()) {
            eprintln!("通知链接注册失败: {error}");
        }
        let handle = app.clone();
        let relay = windows_relay::listen(move |request| {
            let app = handle.clone();
            let (send, receive) = std::sync::mpsc::sync_channel(1);
            handle
                .run_on_main_thread(move || {
                    let result = crate::tray::show_main(&app).map_err(std::io::Error::other);
                    if result.is_ok() && request != windows_relay::ACTIVATE {
                        deliver(&app, request);
                    }
                    let _ = send.send(result);
                })
                .map_err(std::io::Error::other)?;
            receive
                .recv_timeout(std::time::Duration::from_secs(1))
                .map_err(std::io::Error::other)?
        })?;
        let _ = app.state::<NotificationRoutes>().relay.set(relay);
    }
    #[cfg(not(windows))]
    let _ = deliver;
    Ok(())
}

#[cfg(windows)]
#[path = "notification_links/windows_relay.rs"]
mod windows_relay;

#[cfg(windows)]
mod windows_impl {
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};
    use windows::core::HSTRING;
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    /// 本应用所有通知共用的分组。
    const GROUP: &str = "aaw";

    pub fn show(identifier: &str, xml: &str, tag: &str) -> Result<(), String> {
        let run = || -> windows::core::Result<()> {
            let document = XmlDocument::new()?;
            document.LoadXml(&HSTRING::from(xml))?;
            let toast = ToastNotification::CreateToastNotification(&document)?;
            toast.SetTag(&HSTRING::from(tag))?;
            toast.SetGroup(&HSTRING::from(GROUP))?;
            ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(identifier))?.Show(&toast)
        };
        run().map_err(|error| format!("NOTIFICATION_SHOW_FAILED: {error}"))
    }

    pub fn remove(identifier: &str, tag: &str) -> Result<(), String> {
        ToastNotificationManager::History()
            .and_then(|history| {
                history.RemoveGroupedTagWithId(&HSTRING::from(tag), &HSTRING::from(GROUP), &HSTRING::from(identifier))
            })
            .map_err(|error| format!("NOTIFICATION_REMOVE_FAILED: {error}"))
    }

    /// 注册 `aaw://` 链接指向当前程序。开发版没有安装时建的快捷方式，另外登记通知用的应用标识。
    pub fn register(identifier: &str, product: Option<&str>) -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|error| error.to_string())?;
        let exe = exe.display().to_string();
        let classes = RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey("Software\\Classes")
            .map_err(|error| error.to_string())?
            .0;
        let (scheme, _) = classes.create_subkey("aaw").map_err(|error| error.to_string())?;
        let name = product.unwrap_or("AAW Desktop");
        scheme.set_value("", &format!("URL:{name}")).map_err(|error| error.to_string())?;
        scheme.set_value("URL Protocol", &"").map_err(|error| error.to_string())?;
        let (icon, _) = scheme.create_subkey("DefaultIcon").map_err(|error| error.to_string())?;
        icon.set_value("", &format!("\"{exe}\",0")).map_err(|error| error.to_string())?;
        let (command, _) = scheme
            .create_subkey("shell\\open\\command")
            .map_err(|error| error.to_string())?;
        command
            .set_value("", &format!("\"{exe}\" \"%1\""))
            .map_err(|error| error.to_string())?;
        if cfg!(debug_assertions) {
            let (app_id, _) = classes
                .create_subkey(format!("AppUserModelId\\{identifier}"))
                .map_err(|error| error.to_string())?;
            app_id.set_value("DisplayName", &format!("{name}（开发版）")).map_err(|error| error.to_string())?;
        }
        Ok(())
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_notification_links_are_accepted() {
        assert!(valid_route("aaw://notification?kind=run&runId=1"));
        assert!(!valid_route("aaw://other?x=1"));
        assert!(!valid_route("https://example.com"));
        assert!(!valid_route("aaw://notification?x=1\nmore"));
        assert!(!valid_route(&format!("{ROUTE_PREFIX}{}", "a".repeat(ROUTE_LIMIT))));
    }

    #[test]
    fn toast_text_and_link_are_escaped() {
        let xml = toast_xml("a<b>", "x & \"y\"", "aaw://notification?a=1&b=2");
        assert!(xml.contains("launch=\"aaw://notification?a=1&amp;b=2\""));
        assert!(xml.contains("<text>a&lt;b&gt;</text>"));
        assert!(xml.contains("<text>x &amp; &quot;y&quot;</text>"));
    }

    #[test]
    fn tags_are_short_and_stable() {
        let tag = short_tag(&"wf:run:reply:node:1".repeat(20));
        assert_eq!(tag.len(), 16);
        assert_eq!(tag, short_tag(&"wf:run:reply:node:1".repeat(20)));
        assert_ne!(short_tag("a"), short_tag("b"));
    }
}
