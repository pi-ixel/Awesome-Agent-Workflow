# 客户端更新指南

本文描述已安装的 AAW skills 如何更新到服务端发布的最新版本，以及异常时如何恢复。
机制设计见 `docs/auto-update-design.md`，发布侧操作见 `docs/release-guide.md`。

> 下文的 `aaw <命令>` 是 `python skills/aaw-workflow/scripts/aaw.py <命令>` 的简写
> （与 `SKILL.md` 中的调用方式一致）。

## 一、两种更新方式

### 1. 自动更新（默认，无需操作）

每次运行 `aaw start` 时，CLI 会在触碰任何工作流状态**之前**：

1. 向服务端查询最新版本（`GET /api/v1/client/release`）；
2. 若服务端版本高于本地 `skills/aaw-workflow/scripts/cli/VERSION`，
   下载并原子替换整个 skills 安装；
3. 更新成功后用**新版 CLI** 以原始参数重新执行本次命令（一次性 handoff，
   不会循环重查），对用户表现为一次略慢的 `aaw start`。

网络不可达、服务端无版本等非致命问题只打印警告并继续执行原命令，不阻塞工作流。

### 2. 手动更新

```powershell
aaw update          # 人类可读输出
aaw update --json   # 机器可读输出
```

| 结果 | 退出码 | `--json` 输出 |
| --- | --- | --- |
| 已是最新 | 0 | `{"status": "up_to_date", "from_version": ...}` |
| 更新成功 | 0 | `{"status": "updated", "from_version", "to_version", "updated_skills", "removed_skills"}` |
| 更新失败（已自动回滚） | 1 | `{"status": "failed", "error": ...}` |
| 需要人工恢复 | 2 | `{"status": "recovery_required", "error": ...}` |

## 二、相关环境变量

| 变量 | 说明 |
| --- | --- |
| `AAW_TELEMETRY_ENDPOINT` | 服务端地址（查询与下载都用它），默认指向内置 endpoint |

指向自建服务端示例：

```powershell
$env:AAW_TELEMETRY_ENDPOINT = "http://127.0.0.1:8000"
aaw update
```

## 三、更新过程中发生了什么

了解机制有助于判断异常（细节见设计文档）：

1. **共享锁**：所有 `aaw` 命令启动时都持有安装目录读锁（`skills/.aaw-update.lock`），
   更新需要升级为排他锁——有其他 `aaw` 进程在跑时更新会等待，超时（30s）则放弃本次
   更新，不影响正在运行的命令；
2. **私有 stage**：下载、解压、完整性校验都在 `skills/.aaw-stage-<random>/` 内完成，
   失败只删自己的 stage，不碰正式目录；
3. **WAL 事务**：校验通过后 stage 原子改名为 `skills/.aaw-txn-<id>/`，逐 skill
   backup → swap → verify，全部成功才提交；任何一步失败按事务日志自动回滚；
4. **中断自愈**：进程被杀、断电留下的残留事务，会在下一次任意 `aaw` 命令启动时
   自动恢复（提交或回滚到一致状态），无需人工干预。

更新校验包括：zip 内容与 manifest 一致、每个 skill 有 `SKILL.md`、包内 `VERSION`
等于服务端版本、definitions 引用的 skill 全部可用、安装路径上无
symlink/junction（有则拒绝更新以防写穿链接）。

## 四、异常处理

### 更新失败（退出码 1）

已自动回滚到旧版本，按错误信息处理后重试即可。常见原因：

- 网络不通 / 服务端未部署发布目录 → 检查 `AAW_TELEMETRY_ENDPOINT` 与服务端
  `/api/v1/client/release`；
- 其他 `aaw` 进程占用安装目录导致锁超时 → 等其结束后重试；
- 安装路径上存在 symlink/junction → 移除后重试。

### 需要人工恢复（退出码 2）

极少数情况下（回滚本身失败，例如文件被占用、权限问题），CLI 会保留事务目录并提示
恢复方式。每个事务目录内都带一个独立恢复脚本：

```powershell
# <id> 以实际残留目录为准
python skills\.aaw-txn-<id>\recover.py
```

该脚本只依赖 Python 标准库，可重复执行，会先获取排他锁再按事务日志把安装恢复到
一致状态（已提交则前滚清理，未提交则回滚到旧版本）。确认锁已无人持有时可加
`--assume-locked` 跳过取锁。

### 手动检查残留

正常情况下 `skills/` 下不应存在这些目录，存在即为中断残留（下次运行 `aaw`
会自动处理）：

```text
skills/.aaw-stage-*      下载/校验中的私有暂存（无事务日志，可直接删除）
skills/.aaw-txn-*        换入事务（含 transaction.json 与 recover.py，勿手工删改）
skills/.aaw-handoff-*    一次性 re-exec 交接文件
```

`skills/.aaw-update.lock` 是永久锁锚点文件，内容无意义，**不要删除**。

## 五、验证更新结果

```powershell
aaw --version                                    # 显示当前版本
Get-Content skills\aaw-workflow\scripts\cli\VERSION   # 版本源文件
```

两者应一致且等于服务端 `/api/v1/client/release` 返回的 `latest_version`。
