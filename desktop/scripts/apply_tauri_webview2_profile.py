#!/usr/bin/env python3
"""Pass a named WebView2 profile through the three pinned Tauri crates.

Run with the roots of unmodified crates downloaded/extracted into your local
workspace. The tool patches only these roots and does not touch Cargo.toml or
Cargo.lock; use Cargo [patch.crates-io] to opt into the patched copies.
"""
import argparse
from pathlib import Path
import re


def replace_once(text, old, new, path):
    # No fuzzy matching: a wrong crate version or changed implementation aborts.
    if text.count(old) != 1:
        raise SystemExit(f"{path}: expected exactly one source anchor")
    return text.replace(old, new, 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tauri", type=Path, required=True)
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--runtime-wry", type=Path, required=True)
    parser.add_argument("--check", action="store_true", help="validate anchors without writing")
    args = parser.parse_args()

    for root, name, ver in [
        (args.tauri, "tauri", "2.12.4"),
        (args.runtime, "tauri-runtime", "2.12.2"),
        (args.runtime_wry, "tauri-runtime-wry", "2.12.2"),
    ]:
        manifest = (root / "Cargo.toml").read_text()
        package = re.search(r"(?ms)^\[package\]\s*(.*?)(?=^\[|\Z)", manifest)
        if not package or any(
            not re.search(rf'(?m)^\s*{key}\s*=\s*"{re.escape(value)}"\s*$', package[1])
            for key, value in [("name", name), ("version", ver)]
        ):
            raise SystemExit(f"{root}: expected {name} {ver}")

    builder = args.tauri / "src/webview/mod.rs"
    runtime = args.runtime / "src/webview.rs"
    adapter = args.runtime_wry / "src/lib.rs"

    anchor = """  /// Set the environment for the webview.
  /// Useful if you need to share the same environment, for instance when using the [`Self::on_new_window`].
  #[cfg(all(feature = "wry", windows))]
  pub fn with_environment("""
    code = """  /// Select the named WebView2 profile at controller creation.
  ///
  /// Only available on Windows with the Wry runtime. Callers relying on
  /// profile isolation must verify the actual profile before navigating.
  #[cfg(all(feature = "wry", windows))]
  pub fn webview2_profile_name(mut self, name: String) -> Self {
    self.webview_attributes.webview2_profile_name = Some(name);
    self
  }

"""
    changes = {builder: replace_once(builder.read_text(), anchor, code + anchor, builder)}
    anchor = """  pub environment: Option<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment>,
"""
    code = """
  /// Named WebView2 profile to select during controller creation.
  #[cfg(windows)]
  pub webview2_profile_name: Option<String>,
"""
    src = replace_once(runtime.read_text(), anchor, anchor + code, runtime)
    anchor = """      #[cfg(windows)]
      environment: None,
"""
    code = """      #[cfg(windows)]
      webview2_profile_name: None,
"""
    changes[runtime] = replace_once(src, anchor, anchor + code, runtime)
    anchor = """    if let Some(environment) = webview_attributes.environment {
      webview_builder = webview_builder.with_environment(environment);
    }
"""
    code = """
    if let Some(name) = webview_attributes.webview2_profile_name {
      webview_builder = webview_builder.with_profile_name(name);
    }
"""
    changes[adapter] = replace_once(adapter.read_text(), anchor, anchor + code, adapter)
    if not args.check:
        for path, new in changes.items():
            path.write_text(new)
    for path in changes:
        print(f"{'Checked' if args.check else 'Patched'} {path}")


if __name__ == "__main__":
    main()
