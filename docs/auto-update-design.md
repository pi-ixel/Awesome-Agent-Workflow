# AAW CLI 自动更新设计方案

## 一、背景与目标

aaw CLI 及其 skill 集（`skills/aaw-workflow/`）通过 install.sh copy/symlink 或直接仓库
checkout 分发到用户机器，目前没有任何更新通道；且 `aaw_version()` 读仓库根
pyproject.toml，copy 安装后路径落空，版本永远是 fallback `0.1.0`。

目标：

1. 统一版本源，copy/symlink/checkout 三种形态下版本探测一致可靠；
2. server 提供版本查询与安装包下载接口，**发布新版本不重启 server、不动数据库**；
3. CLI 提供 `aaw update` 一键更新，失败时现场零破坏、可恢复。

约束：

- telemetry-server 是稳定组件，发版只发 CLI/skill，不发 server；
- 用户机器不要求有 git、不要求保留源仓库；
- agent 按 SKILL.md 契约解析 CLI 的 stdout（`--json` 时为纯 JSON），任何提示不得污染 stdout。

## 二、职责边界

```
┌─────────────┐  ① 发布: 把 zip 放进 release 目录（scp/rsync，无 API 调用）
│   发布者     │ ────────────────────────────────┐
└─────────────┘                                  ▼
┌─────────────┐   GET /api/v1/client/release   ┌──────────────────────┐
│  aaw CLI    │ ─────────────────────────────▶ │  telemetry-server    │
│             │   ② 查询最新版本 + 文件名        │                      │
│  ~/.aaw/    │ ◀───────────────────────────── │  release 目录（配置） │
│  VERSION    │   GET .../releases/{version}/ │   aaw-skills-*.zip   │
│             │       download/{file_name}     │                      │
│             │   ③ 下载 zip                    └──────────────────────┘
└─────────────┘
   ④ 本地对比版本 → 下载 → staging 解压/结构检查 → 事务换入
```

| 职责 | Server | CLI | 发布者 |
|---|---|---|---|
| 存放安装包 | ✅ release 目录 | — | 放置/删除 zip |
| 判定 latest 版本 | ✅ 扫目录解析文件名 | — | 通过文件名声明 |
| 版本对比 | — | ✅ 本地 VERSION vs latest | — |
| 下载/解压/结构检查/事务换入 | — | ✅ 全部本地执行 | — |
| 更新触发 | — | ✅ 仅手动 `aaw update` | — |
| 撤回一个发布 | — | — | 删掉对应 zip，阻止未更新客户端继续升级 |

Server 只做两件事：报告"最新版本是什么"、提供"对应的 zip"。所有更新决策与
文件操作都在 CLI 端，server 不感知任何客户端状态。

## 三、Server 端设计

### 3.1 配置

`Settings`（`telemetry-server/src/aaw_telemetry/config.py`）新增：

```python
release_dir: Path | None = None   # env: AAW_TELEMETRY_RELEASE_DIR
```

未配置时两个接口分别返回空版本 / 404，其余功能不受影响。

### 3.2 发布目录约定

```
<release_dir>/
  aaw-skills-1.1.0.zip
  aaw-skills-1.2.0.zip      ← 文件名版本号最大者 = latest
```

- 文件名格式 `aaw-skills-<version>.zip`，`<version>` 必须是严格三段版本（如 `1.2.0`）；
  不匹配该格式的文件一律忽略。版本正则统一为：
  `^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$`。
- **放包即发布、删包即撤回发布**：无元数据文件、无发布 API、无鉴权、无数据库表。
  删包不会降级已经更新的客户端；故障版本需通过发布更高版本的修复包处理。
- zip 内容结构：zip 根为一个或多个 skill 顶层目录（当前只有 `aaw-workflow/`）。
  CLI 按"覆盖 zip 中出现的每个顶层目录"处理，将来需要连子技能一起发布时，
  打包时多放目录即可，CLI 无需改动。

### 3.3 接口

新增 `routers/releases.py`（工厂函数 `build_releases_router(settings)`，
在 `main.py` `create_app` 中注册；纯文件系统操作，不需要 session）。

**GET `/api/v1/client/release`** — 查询最新版本

```json
200 {
  "latest_version": "1.2.0",
  "file_name": "aaw-skills-1.2.0.zip",
  "size_bytes": 1048576,
  "released_at": "2026-07-18T01:00:00Z"      // 文件 mtime
}
200 { "latest_version": null }                // 目录未配置 / 无合法包
```

**GET `/api/v1/client/releases/{version}/download/{file_name}`** — 下载指定 zip

- `FileResponse`，`Content-Disposition: attachment; filename=<file_name>`；
- server 按 §3.2 的严格三段规则校验 `version`，且 `file_name` 必须精确等于
  `aaw-skills-{version}.zip`，不允许任意路径或文件名；
- 文件不存在时 404（`ApiError` 标准错误 JSON）。

客户端必须使用查询接口返回的 `latest_version` 和 `file_name` 构造下载 URL，
不再二次查询或下载“当前 latest”。

### 3.4 发布流程（发布者视角）

```bash
# 1. 合入代码，更新 skills/aaw-workflow/scripts/cli/VERSION（如 1.2.0）
# 2. 打包（脚本见 §6）
python scripts/make_release.py            # → dist/aaw-skills-1.2.0.zip
# 3. 上传到 server 的 release 目录
scp dist/aaw-skills-1.2.0.zip server:/data/aaw-releases/
# 完成。server 不重启；发错了可删掉该 zip 阻止后续升级，
# 已升级客户端需另发更高版本的修复包。
```

## 四、CLI 端设计

### 4.1 版本源（Commit 1）

- **`skills/aaw-workflow/scripts/cli/VERSION`**：纯文本一行（初始 `1.1.0`）。
  放在 cli 包内：copy/symlink/zip 分发都天然带上；zip 解压覆盖完成的瞬间，
  版本号即为新值，无需任何登记动作。
- **`cli/version.py`**：`aaw_version()` 读同目录 VERSION（异常 fallback
  `0.0.0`）、`parse_version()` 严格接受三段版本并返回三元整数组、
  `is_newer()` 仅比较该三元组、
  `load_update_state()`/`save_update_state()` 读写 `~/.aaw/update-check.json`
  （原子写、自吞异常）。
- `telemetry.py` 删除旧 `aaw_version()`，改 `from .version import aaw_version`
  保持旧导入路径兼容。
- 版本号统一为 `1.1.0`：pyproject.toml、`.claude-plugin/plugin.json`、
  `.claude-plugin/marketplace.json`、`.codex-plugin/plugin.json` 同步；
  测试加"五处版本一致"守卫用例防再漂移。

### 4.2 版本检查与提示（轻量层，零覆盖动作）

```
next / done 命令主逻辑完成后（stdout 已输出）：
  距上次检查 < 24h ──→ 跳过（零网络）
  否则 GET /api/v1/client/release（timeout 2s）
    成功 → 写 ~/.aaw/update-check.json
    失败 → 静默，但同样刷新 checked_at（endpoint 不可达时最多一天试一次，
           避免每条命令白等超时）

status / next 输出前：读本地缓存（零网络），
  is_newer(latest, 本地版本) → stderr 打一行：
  提示: AAW 新版本 1.2.0 可用（当前 1.1.0），运行 `aaw update` 升级
```

- 提示只走 **stderr**，与既有 `telemetry warning:` 同通道，stdout JSON 契约不变；
- 缓存文件 `~/.aaw/update-check.json`：
  `{"schema": 1, "latest_version": "1.2.0", "checked_at": 1784165400000, "endpoint": "..."}`；
- `AAW_UPDATE_CHECK=0` 完全禁用检查与提示（CI/测试默认设置）。

### 4.3 安装目录定位

CLI 由 aaw-workflow skill 以 `python <skill-dir>/scripts/aaw.py ...` 方式调用：
`<skill-dir>` 是 harness 的 skill 安装目录，而进程工作目录是用户的项目仓库
（`.sdd/` 所在地），两者无关。**更新目标 = 正在运行的 CLI 自身所在位置**，
由 `__file__` 自定位。先做“绝对词法化”，但不穿透链接：

```python
lexical_file = Path(os.path.abspath(__file__))
```

`abspath` 只使用启动时 CWD 将可能的相对 `__file__` 转为绝对路径并折叠 `..`，
不解析 symlink/junction。完成该步后，后续定位与进程 CWD 无关：

```
lexical_file = <skill-dir>/scripts/cli/update.py
  → parents[2] = skill 安装目录（aaw-workflow 本体，被替换对象）
  → parents[3] = skills 根目录（事务目录与其他 skill 的换入位置）
```

- **定位不使用 `resolve()`**：resolve 会穿透链接跳到另一个目录。对
  `lexical_file` 到 skills 根目录的每层路径做 `lstat`，显式检查 symlink、
  Windows junction 和其他 directory reparse point；
- CWD（用户项目目录）全程不参与定位，也不被更新触碰；
- 同机多 harness 安装（如 `~/.claude/skills/` 与 `~/.config/opencode/skills/`
  各有一份 copy）是**相互独立的安装**：`aaw update` 只更新本次被调用的那一份，
  另一份由它自己的 CLI 被调用时提示/更新。

### 4.4 `aaw update` 命令（唯一执行覆盖的入口）

**不做自动更新**：工作流进行中自动替换 CLI/definitions，会让 `.sdd/*/workflow.yaml`
里进行中的状态与新 definitions 不一致，agent 会话中途 CLI 行为突变风险更大。
检查提示 + 人工执行 `aaw update`。

```
0. 守卫与现场检查（基于 §4.3 的自定位）：
   - `lexical_file` 到 skills 根目录的任一层是 symlink、Windows junction
     或其他 directory reparse point → 拒绝，避免写入被重定向的位置。
     POSIX 使用 `lstat`/`S_ISLNK`；Windows 除 symlink 外还要检查 junction
     和 `FILE_ATTRIBUTE_REPARSE_POINT`。
   - **不检测 Git 仓库、`.git`、`install.sh` 或 dirty 状态**。用户手动执行
     `aaw update` 即表示授权更新当前运行的真实目录副本。
   - 打开 skills 根目录下 `.aaw-update.lock`，以非阻塞方式获取安装级内核
     排他锁：POSIX 使用 `fcntl.flock(LOCK_EX | LOCK_NB)`，Windows 使用
     `msvcrt.locking` 锁定固定的一个字节。获取失败则立即拒绝，提示已有更新
     在执行。锁文件写入 PID、开始时间、随机 owner token 和事务 ID，但
     锁文件是否存在不代表锁是否被持有，以内核锁状态为准。进程正常退出、
     异常退出或被杀后由操作系统自动释放。
   - 锁只能由 owner token 匹配且实际持有文件锁的进程主动释放；从获取锁
     到事务恢复、提交和清理全部完成前不释放。
   - 持锁后扫描 skills 根目录下 `.aaw-update-*` 残留事务：
       committed                    → 清理后继续
       未 committed、仅 staging      → 现场未被动过，静默删除后继续
       未 committed、已进 backup/换入 → 先执行内置恢复（等价 recover.py 逻辑），
                                       恢复干净后才允许开新事务
1. GET /api/v1/client/release（实时，绕过 24h 节流）
   - latest 为空或 latest ≤ 本地 VERSION → 打印"已是最新"，退出；
   - 只有 latest > 本地 VERSION 时才继续更新。
2. 使用响应中的 `latest_version` 和 `file_name` 构造
   `/api/v1/client/releases/{version}/download/{file_name}`，将 zip 流式下载到临时文件。
3. 解压到 staging 目录（skills 父目录下 `.aaw-update-<random>/staging/`）
   - 逐成员校验路径不逃逸（防 zip-slip）
4. sanity 检查：每个顶层目录含 SKILL.md；aaw-workflow 还须含
   scripts/aaw.py 与 scripts/cli/VERSION；zip 内 VERSION 必须等于查询接口的
   `latest_version`，且两者都通过严格三段版本校验
5. 对 zip 中所有 skill 执行一个完整更新事务（详见 §5）：
   - 换入前完成所有目标路径、冲突、权限和 staging 完整性预检；
   - 把旧 skill 逐个 rename 到本次事务的 `backup/` 中；
   - 把 staging 中的所有新 skill 逐个 rename 到正式位置；
   - 任一步失败时，按逆序移走已换入的新 skill，再恢复全部旧 skill；
   - 全部换入后，从正式位置重新读取 VERSION，确认其等于
     `latest_version`，并确认事务清单中的所有 skill 和必需入口均存在；
   - 提交前验证任一失败均整体回滚；全部验证成功后才标记 committed，
     然后删除 backup。
6. 打印 "更新完成: 1.1.0 -> 1.2.0"（新版本号从磁盘 VERSION 重读），
   删除 ~/.aaw/update-check.json（清掉旧提示），立即退出进程
```

两条实现纪律：

- 换入动作开始前把本命令所需模块全部 import 完毕，动作完成后**立即退出**——
  避免换入后异常路径 lazy import 到新版本模块，与内存中旧代码混跑；
- 全程不 `chdir` 进被替换目录（Windows 无法 rename 任何进程 CWD 的祖先目录）。

### 4.5 环境变量汇总

| 变量 | 端 | 用途 |
|---|---|---|
| `AAW_TELEMETRY_ENDPOINT` | CLI | 既有；release 接口复用同一 base |
| `AAW_UPDATE_CHECK` | CLI | `0` 禁用版本检查与提示 |
| `AAW_UPDATE_STATE` | CLI | 覆盖缓存文件路径（测试注入） |
| `AAW_TELEMETRY_RELEASE_DIR` | Server | 发布包目录 |

安装目录不提供生产环境变量覆盖。路径定位封装为接受可选路径参数的
内部函数，测试直接注入 tmp 路径；CLI 入口始终使用 `lexical_file` 自定位，
不允许通过外部环境变量更新另一套安装。

## 五、失败模型与恢复

### 5.1 原则：绝不逐文件覆盖

若直接把 zip 逐文件解压到现有目录，中途任何异常（磁盘满、坏 zip 条目、句柄
占用、进程被杀）都会留下**新旧文件混杂的半更新状态**——版本文件可能已是新的
而代码是旧的，且事后无法检测、无法自动恢复。

因此本方案中，下载、解压、写文件和结构检查全部在 staging 目录完成。
对现有安装的改动是一个覆盖 zip 中**全部 skill**的完整事务，不把单个 skill
的 rename 成功当成整体成功。

事务目录位于 skills 父目录下，保证所有 rename 均在同一文件系统内：

```
.aaw-update-<random>/
  transaction.json       # 事务清单与每个 skill 的当前阶段，作为 write-ahead log 原子写
  staging/<skill>/       # 完整的新版本
  backup/<skill>/        # 从正式位置移入的旧版本
  displaced/<skill>/     # 回滚时从正式位置移走的新版本
```

换入次序固定为：持有安装级锁 → 写入事务清单 → 所有旧 skill 移入 backup
→ 所有新 skill 移入正式位置 → 从正式位置验证 VERSION、入口和 skill 清单
→ 标记 committed → 清理 backup/事务目录 → 释放锁。在 committed 之前任一步失败
都进入整体回滚，必须恢复事务清单中的全部旧 skill，不允许保留
部分新版本。

### 5.2 失败矩阵

| 阶段 | 典型失败 | 现场状态 | 处置 |
|---|---|---|---|
| 获取安装级锁 | 另一更新或恢复进程持有内核锁 | **现有安装未被触碰** | 报错退出，不等待也不抢占活锁 |
| 持锁后发现残留事务 | 上一 owner 异常退出 | 依事务阶段而定 | 先按事务清单恢复或清理，完成后才开新事务 |
| 下载 / 解压 / 结构检查 | 网络中断、坏 zip、磁盘满、sanity 失败 | **现有安装未被触碰** | 删除临时文件与事务目录，报错退出 |
| 旧 skill 移入 backup | 任一目录被占用 | 可能已备份部分 skill | 按逆序恢复已移走的旧 skill，报错退出 |
| 新 skill 换入正式位置 | 任一 rename 失败 | 可能已换入部分新 skill | 将已换入的新 skill 移入 displaced，再按逆序恢复全部 backup |
| 提交前验证 | VERSION 不匹配、入口或 skill 缺失 | 新 skill 已全部换入，尚未 committed | 将全部新 skill 移入 displaced，再恢复全部 backup |
| 提交后清理 backup | 杀软扫描等瞬时占用 | 更新已成功，仅残留事务目录 | 静默留存，下次 `aaw update` 开始时按 committed 状态清理 |

### 5.3 进程中断（被杀 / 断电）的恢复

rename 窗口在毫秒级，但仍可能恰好中断。恢复设计：

1. 每次 rename 前先原子写入“即将执行”状态，rename 成功后再原子写入
   “已完成”状态。恢复程序对照事务清单与实际目录位置，处理 rename
   已成功但完成状态尚未落盘的中断窗口；
2. 事务清单记录 owner token 和安装级锁的路径。自动恢复与手动恢复都必须
   先获取同一内核排他锁，避免恢复程序与正在执行的更新并发操作目录；
3. **换入前先打印事务目录绝对路径和恢复指引**，并在事务目录生成
   独立的 `recover.py`；该脚本只依赖 Python 标准库和事务清单，不 import 被更新的 CLI；
4. 中断后运行 `python <transaction-dir>/recover.py`：
   - 未 committed → 移走已换入的新 skill，按逆序恢复所有 backup；
   - 已 committed → 保留全部新 skill，只清理 backup 和其他事务残留。
5. 恢复程序必须可重入：再次中断后重跑不会破坏已恢复的目录。

### 5.4 CLI 自替换与 Windows 句柄

CPython import 完 `.py`/`.pyc` 即关闭文件句柄，运行中的 `aaw update` 进程不
持有 skill 目录内任何打开句柄，rename 自身所在目录可行（与 pip 自升级同思路）。
真正的占用来源是并行进程 CWD、IDE、杀软——均落在 §5.2 第 2 行，报错后
按事务清单回滚即可恢复旧版本。

## 六、打包脚本

`scripts/make_release.py`（仓库根，发布者使用）：

1. 读 `skills/aaw-workflow/scripts/cli/VERSION` 得版本号 `v`，并按 §3.2 严格三段
   版本规则校验；
2. 校验 pyproject / 2×plugin.json / marketplace.json 与 `v` 一致，不一致即失败；
3. 将 `skills/aaw-workflow/` 打成 `dist/aaw-skills-<v>.zip`（zip 根为
   `aaw-workflow/`，排除 `__pycache__`）；
4. 打印 zip 路径与文件大小。

## 七、测试计划

| 范围 | 文件 | 要点 |
|---|---|---|
| 版本源 | `test/aaw_workflow/test_cli_version.py` | `--version` == VERSION 文件；五处版本一致守卫；只接受无前导零的严格三段版本；server、CLI 和打包脚本的版本样例共享同一组合法/非法用例 |
| Server 接口 | `telemetry-server/tests/test_releases.py` | tmp release 目录 fixture：多 zip 按三元整数版本取最大值、非法或非三段文件名忽略、空目录/未配置返回 null、按版本+文件名下载、参数不匹配或文件不存在返回 404 |
| 检查与提示 | `test/aaw_workflow/test_cli_update_hint.py` | `AAW_UPDATE_STATE` 注入缓存：有新版 → stderr 含提示且 stdout 仍为纯 JSON；同版本/坏 JSON/无文件 → 无提示；`AAW_UPDATE_CHECK=0` → 不发请求 |
| update | `test/aaw_workflow/test_cli_update.py` | 内部路径定位函数注入 tmp 安装目录；相对 `__file__` 做绝对词法化且不穿透链接；symlink 拒绝；Windows 上 junction/reparse point 拒绝；不读取 Git/install.sh/dirty 状态；内核文件锁阻止两个更新或恢复进程并发；进程异常退出后锁自动释放；owner token 不匹配不主动解锁；只有 latest > local 时下载；zip VERSION 与 latest 不一致时不换入；zip-slip 和 sanity 失败拒绝；多 skill 在备份/换入/提交前验证任一阶段失败时整体回滚；中断恢复可重入；残留事务先恢复再开新事务；committed 残留清理；"已是最新" no-op |
| 隔离 | `test/aaw_workflow/_cli_base.py` | 默认注入 `AAW_UPDATE_CHECK=0` 与 tmp `AAW_UPDATE_STATE`；`run_cli` 增加 `extra_env` 参数 |

## 八、提交划分

| # | 内容 | 主要文件 |
|---|---|---|
| 1 | 统一版本源 1.1.0 | `cli/VERSION`、`cli/version.py`、`cli/telemetry.py`、pyproject、plugin.json×2、marketplace.json、`test_cli_version.py` |
| 2 | server 发布接口 + 打包脚本 | `config.py`、`routers/releases.py`、`main.py`、`tests/test_releases.py`、`scripts/make_release.py` |
| 3 | `aaw update` + 检查提示 | `cli/update.py`、`cli/main.py`、`_cli_base.py`、`test_cli_update.py`、`test_cli_update_hint.py` |

Commit 2 与 1/3 无依赖可并行；3 依赖 1、2。

## 九、Non-goals（本期不做）

- 自动更新（检查到新版即覆盖）——仅提示 + 手动 `aaw update`；
- 发布 API / 鉴权 / 数据库表——发布 = 放文件；
- `min_version` 强制升级、多 channel（stable/beta）、增量更新；
- PowerShell 安装器（Windows 用户经 zip 更新链路已覆盖）。
