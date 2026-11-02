fn main() {
    println!("cargo:rerun-if-env-changed=AAW_DESKTOP_UPDATE_PUBLIC_KEY");
    println!("cargo:rerun-if-env-changed=AAW_DESKTOP_UPDATE_SERVER");
    tauri_build::build()
}
