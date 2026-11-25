fn main() {
    println!("cargo:rerun-if-env-changed=AAW_DESKTOP_UPDATE_PUBLIC_KEY");
    println!("cargo:rerun-if-env-changed=AAW_DESKTOP_UPDATE_SERVER");
    println!("cargo:rerun-if-changed=icons/icon.ico");
    // 独立插件只给工具 WebView 开放动作命令，保留桌面其他应用命令的权限边界。
    tauri_build::try_build(tauri_build::Attributes::new().plugin(
        "aaw-tool-runtime",
        tauri_build::InlinedPlugin::new().commands(&["tool_act"]),
    ))
    .expect("生成工具运行时权限失败");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        // 库单测也是独立 exe。Tauri 的启动资源只嵌入桌面程序，需要为单测补上公共控件依赖。
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
        // 桌面程序已经链接 Tauri 的清单，关闭链接器额外生成的同名资源。
        println!("cargo:rustc-link-arg-bin=desktop=/MANIFEST:NO");
    }
}
