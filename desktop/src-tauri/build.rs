fn main() {
    println!("cargo:rerun-if-env-changed=AAW_DESKTOP_UPDATE_PUBLIC_KEY");
    println!("cargo:rerun-if-env-changed=AAW_DESKTOP_UPDATE_SERVER");
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::build()
}
