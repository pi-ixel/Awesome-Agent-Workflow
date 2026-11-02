# Desktop 自动更新与缓存分发

## 行为

默认启动后后台检查，检查结束后每 30 分钟执行下一轮；设置页可手动检查。检查不阻塞登录、会话预加载或 UI。原生 Rust 进程持有唯一状态与任务锁，React 仅订阅状态。

在「设置 → 通用 → Desktop 更新」配置：

| 配置 | 默认 | 行为 |
| --- | --- | --- |
| 自动检查更新 | 开启 | 控制启动检查和定时检查；关闭后仍可手动检查 |
| 检查间隔 | 30 分钟 | 支持 1–1440 分钟整数，修改后按新间隔重新计时 |
| 自动下载更新 | 开启 | 关闭后仅显示发现的版本，点击“下载”才获取安装包 |
| 更新加速服务器 | `http://39.108.107.148:18081` | 可配置完整 HTTP/HTTPS 地址 |
| 使用服务器加速下载 | 开启 | 关闭后从 GitHub 下载 |
| 帮助分发更新 | 开启 | 上传已验证的官方安装包；失败不影响本机更新 |

配置写入更新缓存目录的 `preferences.json`，重启后恢复。旧配置缺少新增字段时补齐默认值。关闭自动检查或自动下载不取消已经开始的任务；后续检查遵循新设置。关闭自动检查时仍可预先修改自动下载策略，手动检查也遵循此策略。发现新版本与安装包已就绪是独立状态，安装始终需要用户确认。

GitHub 的正式 `desktop-vX.Y.Z` release 是发布来源；同仓 CLI release 与预发布版本不会参与比较，也不使用 GitHub 的全局 latest API。查询最近 100 个 release 中带 `desktop-update.json` 的最高 Desktop 版本。服务器缓存签名清单和安装包，网络断开时无需访问 GitHub即可验证。

Windows x64 安装版后台下载，验证后在 Logo 旁显示“更新”。便携版根据注册表安装位置与当前可执行路径的比较识别，仅提供手动下载。更新前锁定版本、重新验证文件、确认正在运行的会话/终端、结束后台任务，再交接 NSIS；普通退出不安装。首次使用需要手动安装带更新模块和公钥的版本。

安装目录参数遵循 [NSIS 命令行约定](https://nsis.sourceforge.io/Docs/Chapter3.html)：`/D=` 放在最后，含空格的路径也不添加引号。路径必须与当前进程的注册安装目录一致。准备期间若出现新任务，会重新要求停止确认。

自动检查失败不弹窗，设置页显示错误；下轮重试。下载和上传均为整包重试。本地缓存每次启动/安装前重新验证；更高版本验证成功前保留已有可安装包。下载中只有一个任务，结束后的下一轮可发现并下载更高版本。安装开始后禁止替换目标。

启动时仅保留仍有效的待安装包，清理更新目录内的旧哈希安装包和中断下载的临时文件。

## 发布签名

`desktop-update.json` 是 `{ "payload": "<base64>", "signature": "<base64>" }`。
签名为 Ed25519，对 payload 解码后的原始 UTF-8 字节签名，**不是**对重新序列化的 JSON 签名。payload 包含：

```json
{"schema":1,"version":"0.2.0","platform":"windows-x86_64","kind":"nsis","file_name":"AAW-Desktop-0.2.0-windows-x64-setup.exe","size":12345,"sha256":"64位小写十六进制","notes":"更新说明"}
```

服务端和客户端都验证签名、平台、稳定版本、精确文件名、大小上限和 SHA256。客户端构建固定 GitHub URL，不从上传者指定的 URL 获取资源。此签名是更新来源验证，不代替 Windows Authenticode。

### 首次配置（维护者操作）

1. 在安全环境生成一对 Ed25519 密钥。私钥使用 raw 32 字节 seed 的 base64，公钥使用 raw 32 字节的 base64。不要提交私钥或放入安装包。下方脚本会生成并加密备份，重复执行会复用已有密钥。
2. GitHub Actions secret：`AAW_DESKTOP_SIGNING_KEY`；repository variable：`AAW_DESKTOP_UPDATE_PUBLIC_KEY`。正式版本的二进制在编译时内置该公钥。
3. 可选 repository variable：`AAW_DESKTOP_UPDATE_SERVER`，默认 `http://39.108.107.148:18081`。
4. telemetry-server 环境变量 `AAW_TELEMETRY_DESKTOP_UPDATE_PUBLIC_KEY` 设置为相同公钥。服务器仅验证，无需私钥。
5. 推送 Desktop release 标签后，工作流先构建安装包，再运行 `desktop/scripts/sign-update.py` 并将清单加入 SHA256SUMS 和 release 附件。密钥缺失或不匹配时签名步骤失败，禁止发布无签名更新。

公钥应长期稳定；更换公钥必须先设计旧客户端的信任迁移，不能直接替换仓库变量。开发构建未设置环境变量时，默认嵌入仓库 `desktop/update-public-key.txt` 中的公钥；CI 的非空 `AAW_DESKTOP_UPDATE_PUBLIC_KEY` 优先。公钥可公开，私钥不得入库。

### 可重复执行的配置流程

Windows 维护机需要 Python 3.11+、PowerShell 7（`pwsh`）、GitHub CLI（`gh`）。以有仓库 Secrets/Variables 管理权限的账号登录。在仓库根目录执行：

```powershell
gh auth status
python -m pip install "cryptography>=44,<47"
python desktop/scripts/configure-update-signing.py --repo pi-ixel/Awesome-Agent-Workflow --server http://39.108.107.148:18081
gh secret list -R pi-ixel/Awesome-Agent-Workflow
gh variable list -R pi-ixel/Awesome-Agent-Workflow
```

脚本通过标准输入写入 GitHub Secret，私钥不进入命令参数或日志。首次生成的私钥以当前 Windows 用户的 DPAPI 加密，保存于 `%LOCALAPPDATA%\AAW\release-signing\desktop-ed25519.dpapi`。重复运行会解密并复用此备份；发现远端已有密钥却缺少本地备份，或公钥不匹配时会拒绝覆盖。

该备份依赖原 Windows 用户及其 DPAPI 密钥，单独复制文件到另一台电脑不能保证解密。应通过组织的安全密钥保管流程留存可恢复备份，勿把私钥粘贴到聊天、文档或仓库。GitHub Secret 写入后不能读回；丢失备份时不能通过随意重建密钥恢复旧客户端信任。

将 `desktop/update-public-key.txt` 和 `telemetry-server/deploy/configure-desktop-updates.py` 复制到服务器，在服务器执行（替换实际文件路径）：

```bash
sudo /opt/aaw-telemetry/.venv/bin/python configure-desktop-updates.py \
  --public-key "$(cat update-public-key.txt)" \
  --nginx-config /www/server/panel/vhost/nginx/aaw-telemetry.conf
```

该脚本适用于当前 systemd 服务名 `aaw-telemetry`、应用端口 `127.0.0.1:18080` 的部署。会备份被修改的配置、创建 `/etc/systemd/system/aaw-telemetry.service.d/desktop-updates.conf`、创建可写缓存目录、校验并重载 Nginx；不替换应用代码，不重启 telemetry。已有自定义上传 location 时应人工核对其中限制。

随后部署包含更新 API 的 telemetry-server（安装本项目新依赖），重启并验收：

```bash
sudo systemctl restart aaw-telemetry
curl --fail http://127.0.0.1:18081/health/live
curl --fail http://127.0.0.1:18081/api/v1/desktop/latest
```

没有缓存包时 `/api/v1/desktop/latest` 返回 `null` 是正常情况；返回 404 表示仍是旧服务端或路由未部署，不能视为升级链路已启用。

本地构建不再需要手动设置公钥环境变量：

```powershell
cd desktop
npm run tauri -- build --debug --no-bundle -- --locked
```

发布前需将代码与公钥合入 main，同步 `desktop/package.json`、`desktop/package-lock.json`、`desktop/src-tauri/Cargo.toml`、`desktop/src-tauri/Cargo.lock`、`desktop/src-tauri/tauri.conf.json` 的版本，再推送对应 `desktop-vX.Y.Z` 标签。确认 release 附件包含安装包、`desktop-update.json` 与 `SHA256SUMS`。没有签名 release 时，本地不再报缺少公钥，但暂时找不到有效更新仍属正常。

### 本次配置记录（2026-11-02）

- GitHub 仓库：`pi-ixel/Awesome-Agent-Workflow`，Secret 和两个 Variables 已写入。
- 公钥：`desktop/update-public-key.txt`，与 GitHub、服务器 drop-in 配置保持一致。
- 服务器：`39.108.107.148:18081`；缓存目录 `/var/lib/aaw-telemetry/desktop-releases`，属主 `aaw-telemetry`。
- Nginx：`/www/server/panel/vhost/nginx/aaw-telemetry.conf`，上传上限 512 MiB、超时 660 秒，已校验并重载。
- systemd 配置已写入，服务已重启，已核对运行进程的公钥与本地一致，健康检查正常。当前更新 API 返回 404，说明仍需部署包含更新路由的新版服务端；本次未部署应用代码或创建 release。

## telemetry-server 配置与 API

新增 `cryptography` 依赖。缓存与上传协调使用独立 SQLite（`cache.sqlite`），避免为安装包写业务 MySQL 数据。多个进程需共享同一本地目录；不支持多个机器各自独立缓存目录却共用一个负载均衡地址。

| 环境变量（均有 `AAW_TELEMETRY_` 前缀） | 默认值 |
| --- | --- |
| `DESKTOP_RELEASE_DIR` | `data/desktop-releases` |
| `DESKTOP_UPDATE_PUBLIC_KEY` | 空；未配置时拒绝上传 |
| `DESKTOP_UPDATE_MAX_BYTES` | 512 MiB |
| `DESKTOP_UPDATE_QUOTA_BYTES` | 2 GiB |
| `DESKTOP_UPDATE_LEASE_SECONDS` | 900 秒 |

| 接口 | 作用 |
| --- | --- |
| `GET /api/v1/desktop/latest` | 返回已完成且签名有效的最高版本 envelope，无包时为 null |
| `POST /api/v1/desktop/uploads` | 提交 envelope，返回 ready / busy / upload；upload 包含临时 token 和哈希 |
| `PUT /api/v1/desktop/uploads/{sha256}` | `Authorization: Bearer <token>`，流式接收原始安装包 |
| `GET /api/v1/desktop/packages/{sha256}` | 下载已验证完成的包 |

上传资格跨进程互斥；同一 token 重复并行上传由独占临时文件拒绝。租约到期可接替，旧上传者不能发布；只有完整校验后才能原子发布。最多 4 个有效上传资格，每个客户端每分钟最多 10 次新资格，已存在的包不重复上传。临时文件在后续查询/申请时清理。缓存达到配额后拒绝新上传并在下轮重试，维护者可调整配额。

### Nginx

生产地址：`http://39.108.107.148:18081/health/live`。上传 location 已按下列参数配置；其他部署环境也需核对上游转发及安装包上传限制：

```nginx
location /api/v1/desktop/uploads/ {
    client_max_body_size 512m;
    proxy_request_buffering off;
    proxy_read_timeout 660s;
    proxy_send_timeout 660s;
    proxy_pass http://127.0.0.1:18080;
}
```

其余 `/api/v1/desktop/` 路径沿用现有代理。多实例部署必须共享缓存目录。客户端可关闭服务器加速，也可只关闭帮助分发；本机安装永远不等待上传完成。

## 验证与上线边界

设置页逐项显示 GitHub 与加速服务器的状态：尚未发布签名版本、服务器尚无缓存、接口未部署或地址错误（404）、网络失败、限流、无效签名。已成功检查且没有更高版本时显示“当前已是最新版本”。某个来源失败不会阻止使用另一来源的有效签名包；来源都无可用结果时保留具体原因，不再统一显示“无法获取有效的更新信息”。

自动测试覆盖签名篡改、坏包、文件大小、缓存验证、版本比较、租约重复/超时、上传未完成不可下载、便携版、运行任务确认、安装器启动失败恢复。

发布前应在 Windows 测试机安装带正式公钥的旧版，发布签名测试新版，验证：GitHub 下载、客户端上传、第二客户端从服务器下载、运行中任务确认、NSIS 覆盖安装与重启。安装器交接后的系统级失败需要日志及人工重试；首期不提供自动回滚。
