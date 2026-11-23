# WebView2 命名配置补丁

这三个目录来自下列 crates.io 包，保留上游许可证。正式构建通过 Cargo 的本地补丁使用固定版本，无需修改 Cargo 缓存。

| 包 | 版本 | 上游 crate SHA256 |
| --- | --- | --- |
| tauri | 2.12.4 | f316751027fc2644221d1a448564d519efb07067fda584879d9cda966391d212 |
| tauri-runtime | 2.12.2 | 7c55766d99cea69055904d1735b93c2049302b2e09effd462120deb5581d78e9 |
| tauri-runtime-wry | 2.12.2 | 8d61892587aea2a85245bcaec98c6fe46268874c0a0deae5535fb71ca7b93eae |

Windows 侧只新增一条传递链。Tauri 的 WebviewBuilder 写入配置名，Runtime 保留该属性，Runtime Wry 将它交给已锁定的 Wry 0.57.0 的 with_profile_name。未指定配置名时走原路径。上游开始提供等价入口后可以移除这三个补丁。
