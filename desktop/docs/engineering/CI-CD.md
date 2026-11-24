# Desktop Windows CI/CD

工作流：`.github/workflows/desktop.yml`。当前平台为 Windows x64，使用 Node.js 24、Rust stable、`windows-2022`。依赖通过 npm/Cargo 锁文件安装，构建的 UI 使用内置生产资源，不连接 Vite 开发服务器。

## 自动检查与下载

- 指向 main 的 PR，以及 main 上涉及 `desktop/**` 或该工作流的更新：运行 TypeScript、ESLint、Vitest、Edge 界面回归、生产前端构建和原生 Rust 测试。
- Actions 中可手动运行 **Desktop Windows**（首次手动运行需该工作流已合入默认分支）。
- 手动构建与正式标签会并行运行 Windows 打包、前端检查和 Rust 检查。三项通过后，在对应 Actions 页的 Artifacts 下载 `desktop-windows-x64-<run_id>-<attempt>`，保留 14 天。`desktop-windows-x64-candidate-*` 是供验证作业读取的中间产物，保留 2 天。
- 下载包含 `AAW-Desktop-<version>-windows-x64-setup.exe`、`AAW-Desktop-<version>-windows-x64-portable.zip` 和 `SHA256SUMS`。完整解压 ZIP 后运行 `desktop.exe`，同目录下的 `workflow-engine/` 和 `ops-sidecar/` 分别提供工作流和远程项目服务。
- 流水线不需要本机 iCode 或 AAW 配置；原生测试使用测试子进程。安装后的应用需用户自行配置 ACP agent、AAW 工具及 WebView2。

## 正式发布

Desktop 使用独立的 `desktop-vX.Y.Z` 标签；原有 `vX.Y.Z` 标签继续发布 AAW skills/CLI。

1. 同步修改 `desktop/package.json`、`desktop/package-lock.json`、`desktop/src-tauri/tauri.conf.json`、`desktop/src-tauri/Cargo.toml`、`desktop/src-tauri/Cargo.lock` 中的 Desktop 版本，并将版本变更合入 main。
2. 在 main 的目标提交上创建并推送标签，例如 `git tag desktop-v0.1.0 <commit>`、`git push origin desktop-v0.1.0`。
3. 完整前端检查、Rust 检查和 Windows 打包并行运行。版本必须与标签匹配，标签提交必须在 main 的历史中。
4. 三项均通过后，验证作业核对安装包及便携包的 SHA256，并从该标签的源码读取发布说明、生成签名更新清单。
5. 独立 publish 作业校验已签名的产物，随后创建正式 GitHub Release。该作业只在 Desktop 标签 push 时执行，并单独持有 `contents: write`。

当前仅支持稳定版三段版本号，不创建草稿，也不自动创建标签。Desktop Release 设置 `latest=false`，避免覆盖仓库 AAW skills/CLI 的 Latest 版本入口；Desktop 用户按 `desktop-v` 标签查找发布。

## 缓存、签名与失败处理

npm 依赖恢复使用 Node.js 缓存。Rust 测试缓存由 main push 更新，Windows x64 release 打包使用独立的 `desktop-windows-x64-release` 缓存。需要预热时，在 Actions 手动运行 **Desktop Windows** 并选择 `main`，也可用 `gh workflow run desktop.yml --ref main`。成功的手动打包会把 release 依赖缓存写入 main，后续正式标签从这套缓存恢复。预热完成后，对同一提交再运行一次，比较打包作业的 Rust 缓存日志和正式编译耗时。

CI 取消过期分支构建，标签发布不自动取消。正式下载包含安装包、便携 ZIP、SHA256 校验文件、发布说明和签名更新清单。

更新清单使用现有 Ed25519 密钥签名，GitHub Release 使用内置 `GITHUB_TOKEN` 发布。标签与版本不一致，或测试、打包、校验、签名失败时，正式发布会跳过。临时错误可重跑失败作业。若所需产物已经过期，可重跑整次流水线。若同名 Release 已经存在，先核对现有 Release，避免覆盖已经发布的文件。

参考：[Tauri GitHub 构建指南](https://v2.tauri.app/distribute/pipelines/github/)。
