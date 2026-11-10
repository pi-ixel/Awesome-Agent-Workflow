# Desktop Windows CI/CD

工作流：`.github/workflows/desktop.yml`。当前平台为 Windows x64，使用 Node.js 24、Rust stable、`windows-2022`。依赖通过 npm/Cargo 锁文件安装，构建的 UI 使用内置生产资源，不连接 Vite 开发服务器。

## 自动检查与下载

- 指向 main 的 PR，以及 main 上涉及 `desktop/**` 或该工作流的更新：运行 TypeScript、ESLint、Vitest、生产前端构建、原生 Rust 测试，再构建 release 可执行文件和 NSIS 安装包。
- Actions 中可手动运行 **Desktop Windows**（首次手动运行需该工作流已合入默认分支）。
- 成功运行后，在对应 Actions 页的 Artifacts 下载 `desktop-windows-x64-<run_id>-<attempt>`，保留 14 天。
- 下载包含 `AAW-Desktop-<version>-windows-x64-setup.exe`、`AAW-Desktop-<version>-windows-x64-portable.zip` 和 `SHA256SUMS`。ZIP 解压得到 `desktop.exe`。
- 流水线不需要本机 iCode 或 AAW 配置；原生测试使用测试子进程。安装后的应用需用户自行配置 ACP agent、AAW 工具及 WebView2。

## 正式发布

Desktop 使用独立的 `desktop-vX.Y.Z` 标签；原有 `vX.Y.Z` 标签继续发布 AAW skills/CLI。

1. 同步修改 `desktop/package.json`、`desktop/package-lock.json`、`desktop/src-tauri/tauri.conf.json`、`desktop/src-tauri/Cargo.toml`、`desktop/src-tauri/Cargo.lock` 中的 Desktop 版本，并将版本变更合入 main。
2. 在 main 的目标提交上创建并推送标签，例如 `git tag desktop-v0.1.0 <commit>`、`git push origin desktop-v0.1.0`。
3. 自动执行完整 Windows 检查、测试与打包。版本必须与标签匹配，标签提交必须在 main 的历史中。
4. 独立 publish 作业下载并校验构建产物，然后直接创建正式 GitHub Release，上传安装包、便携 ZIP 和 SHA256 校验文件。该作业只在 Desktop 标签 push 时执行，并单独持有 `contents: write`；PR/普通构建只读源码权限。

当前仅支持稳定版三段版本号，不创建草稿，也不自动创建标签。Desktop Release 设置 `latest=false`，避免覆盖仓库 AAW skills/CLI 的 Latest 版本入口；Desktop 用户按 `desktop-v` 标签查找发布。

## 缓存、签名与失败处理

npm 与 Rust 缓存用于提速，仅 main push 保存 Rust 缓存。CI 取消过期分支构建，标签发布不自动取消。构建产物仅上传最终安装包和 ZIP，不上传完整 target 或本地配置。

当前未配置 Windows 代码签名证书，不需要新增发布密钥；发布使用内置 `GITHUB_TOKEN`。若以后提供签名证书，再单独增加签名步骤。标签/版本不一致、测试或打包失败均不会执行发布。若安装包已上传但发布步骤因临时错误失败，可重跑失败作业；若同名 Release 已经存在，先核对现有 Release，避免覆盖已经发布的文件。

参考：[Tauri GitHub 构建指南](https://v2.tauri.app/distribute/pipelines/github/)。
