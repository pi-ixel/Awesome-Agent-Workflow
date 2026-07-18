# AAW CLI 自动更新设计方案

## 一、背景与目标

aaw CLI 及其完整 Skill 集（当前为 `skills/` 下 12 个含 `SKILL.md` 的目录）通过
现有安装流程 copy/symlink 或直接仓库 checkout 分发到用户机器，目前没有任何
更新通道；且 `aaw_version()` 读仓库根
pyproject.toml，copy 安装后路径落空，版本永远是 fallback `0.1.0`。

目标：

1. 统一版本源，copy/symlink/checkout 三种形态下版本探测一致可靠；
2. server 提供版本查询与安装包下载接口，**发布新版本不重启 server、不动数据库**；
3. `aaw start` 每次进入后立即查询 latest，有新版时在创建 workflow 前
   自动更新完整包；失败时现场零破坏、可恢复。

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
   ④ 本地对比版本 → 下载 → stage 解压/结构检查 → 事务换入
```

| 职责 | Server | CLI | 发布者 |
|---|---|---|---|
| 存放安装包 | ✅ release 目录 | — | 放置/删除 zip |
| 判定 latest 版本 | ✅ 扫目录解析文件名 | — | 通过文件名声明 |
| 版本对比 | — | ✅ 本地 VERSION vs latest | — |
| 下载/解压/结构检查/事务换入 | — | ✅ 全部本地执行 | — |
| 更新触发 | — | ✅ 每次 `aaw start` 自动检查；`aaw update` 可手动触发 | — |
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
- zip 是完整 Skill 发布包，包含仓库 `skills/` 下所有含 `SKILL.md` 的目录；
  当前为 12 个 Skill。`question-tracker-mcp/` 等不含 `SKILL.md` 的辅助目录
  不属于本 Skill 更新包。打包脚本按目录结构动态发现，不在代码中
  硬编码 12 个名称。
- zip 根必须包含 `release-manifest.json`：

  ```json
  {
    "schema": 1,
    "version": "1.2.0",
    "skills": [
      "aaw-workflow",
      "ar-clarify",
      "module-asis-analysis"
    ],
    "external_skills": [],
    "removed_skills": []
  }
  ```

  `skills` 是本版本完整托管集合；示例仅省略了其余项。`external_skills` 是
  definitions 允许引用但不随包分发的扩展 Skill；`removed_skills` 是本版本
  明确从 AAW 托管集合中删除的历史 Skill。三个列表不得重复或交叉。
- zip 中除 manifest 外的顶层项必须与 `skills` 完全一致，每个目录必须
  含 `SKILL.md`。缺失、额外顶层项、重复名称、绝对路径、`.` / `..` 或
  `.aaw-*` 保留名称均拒绝。
- 更新只管理 manifest 中 `skills` 和 `removed_skills` 声明的目录，不删除
  用户自有 Skill。新增 Skill 自动随包换入；`removed_skills` 也必须先移入
  backup，只在整体 committed 后才真正删除。

### 3.3 接口

新增 `routers/releases.py`（工厂函数 `build_releases_router(settings)`，
在 `main.py` `create_app` 中注册；纯文件系统操作，不需要 session）。

**GET `/api/v1/client/release`** — 查询最新版本

HTTP 200：

```json
{
  "latest_version": "1.2.0",
  "file_name": "aaw-skills-1.2.0.zip",
  "size_bytes": 1048576,
  "released_at": "2026-07-18T01:00:00Z"
}
```

目录未配置或无合法包时同样返回 HTTP 200：

```json
{"latest_version": null}
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
# 3. 先上传为不会被 server 识别的临时名，再在同一文件系统内原子改名发布
scp dist/aaw-skills-1.2.0.zip server:/data/aaw-releases/.aaw-skills-1.2.0.zip.uploading
ssh server 'mv /data/aaw-releases/.aaw-skills-1.2.0.zip.uploading \
  /data/aaw-releases/aaw-skills-1.2.0.zip'
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
  `is_newer()` 仅比较该三元组。
- `telemetry.py` 删除旧 `aaw_version()`，改 `from .version import aaw_version`
  保持旧导入路径兼容。
- 版本号统一为 `1.1.0`：pyproject.toml、`.claude-plugin/plugin.json`、
  `.claude-plugin/marketplace.json`、`.codex-plugin/plugin.json` 同步；
  测试加"五处版本一致"守卫用例防再漂移。

### 4.2 自动检查时机

- **不使用 24h 或任何本地版本查询缓存**。每次执行 `aaw start`，
  先完成不依赖网络的本地残留事务恢复，随后的第一项业务操作就是
  实时请求 `GET /api/v1/client/release`。
- 版本查询发生在加载 workflow definitions、创建 `.sdd/<SR>/` 或写入
  `workflow.yaml` **之前**。
- `status` / `next` / `done` / `user-confirm` / `rollback` 不查询版本、不触发
  更新，日常推进已有 workflow 时没有更新网络延迟；但为避免与另一
  进程的完整包换入并发，它们在命令生命周期内持有安装级共享锁。
- `aaw update` 保留为显式入口，用于长期不新建 workflow 时主动升级、
  失败重试和发布验证。
- 所有更新进度、警告与失败信息只走 **stderr**；`start --json` 的 stdout
  只由最终执行 start 业务逻辑的进程输出。

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
  另一份在它自己执行 `start` 或 `aaw update` 时单独更新。

`scripts/aaw.py` 在 `import cli.main` 之前就打开 skills 根目录下
`.aaw-update.lock`。普通命令获取共享锁并持有到进程退出；这保证模块导入、
definitions 读取和 workflow 写入期间不会发生目录换入。锁是跨平台的统一
读写锁语义，不是仅适用于 Windows 的方案：

- Linux、macOS 等 POSIX 平台使用 `fcntl.flock(fd, LOCK_SH | LOCK_NB)` /
  `fcntl.flock(fd, LOCK_EX | LOCK_NB)`；
- Windows 使用 Python 标准库 `ctypes` 调用 `LockFileEx`，不设置
  `LOCKFILE_EXCLUSIVE_LOCK` 即共享锁，设置该标志即排他锁，并统一使用
  `LOCKFILE_FAIL_IMMEDIATELY` 对锁文件第 0 字节的固定 1-byte 区间做非阻塞尝试；
  `msvcrt.locking` 不提供本方案
  所需的共享锁语义，不作为实现；
- 两端都用 `time.monotonic()` 控制 30 秒 deadline，在非阻塞尝试之间做短暂等待；
  进程正常退出、异常退出或被杀后由操作系统随文件描述符/handle 关闭自动释放锁；
- `.aaw-update.lock` 是安装级永久锁锚点，只创建一次，任何更新、恢复、暂存清理
  和事务清理都不得删除、改名或替换它。否则 POSIX 进程可能分别锁住不同 inode，
  Windows 进程也可能持有不同文件对象，导致互斥失效。

### 4.4 `aaw start` 自动更新与 `aaw update`

`start` 进入后先做必要的本地安装一致性恢复；在干净现场上，第一项
业务操作就是实时查询 latest。`aaw update` 复用同一套恢复、查询、下载
和事务换入逻辑，区别只在于失败处理和更新成功后是否重新执行
`start`。

```
0. `scripts/aaw.py` 在导入 CLI 模块前已获取安装级共享锁。所有命令先做
   本地一致性预检：
   - 在共享锁下扫描 skills 根目录下名称严格匹配 `.aaw-txn-<id>/` 且包含
     合法 `transaction.json` 的残留事务：
       committed                    → 清理 backup/事务目录
       未 committed、尚未移动正式目录 → 现场未被动过，删除事务目录
       未 committed、已进 backup/换入 → 先执行内置恢复
   - 如果发现残留，释放共享锁并在 30 秒内获取排他锁；获锁后重新扫描，
     只对仍存在的事务恢复/清理，然后重新获取共享锁再继续。
     恢复或清理失败必须报错退出，不得查询 server 或继续 start。
   - 共享或排他锁在 30 秒内无法获取时，不得使用可能正在被替换的
     definitions 继续，任何命令都报错退出。
1. `start` 立即 GET /api/v1/client/release；`aaw update` 也执行同样的实时查询：
   - 查询成功且 latest 为空或 latest ≤ 本地 VERSION → `start` 继续正常业务逻辑；
     `aaw update` 打印"已是最新"并退出；
   - 查询成功且 latest > 本地 VERSION → 继续下载和事务更新；
   - 查询超时、server 不可用或响应非法 → `start` 向 stderr 输出 warning 并
     使用当前本地版本继续；`aaw update` 报错退出。
   - 查询请求包含连接、发送和读取响应在内的总 deadline 为 30 秒，不自动重试。
2. 确认有新版后，在当前共享锁下执行基于 §4.3 自定位的初步守卫：
   - `lexical_file` 到 skills 根目录的任一层是 symlink、Windows junction
     或其他 directory reparse point → 拒绝，避免写入被重定向的位置。
     POSIX 使用 `lstat`/`S_ISLNK`；Windows 除 symlink 外还要检查 junction
     和 `FILE_ATTRIBUTE_REPARSE_POINT`。
   - **不检测 Git 仓库、`.git`、`install.sh` 或 dirty 状态**。用户手动执行
     `aaw update` 即表示授权更新当前运行的真实目录副本。
   - 链接守卫或其他换入前检查失败时，自动更新模式只向
     stderr 输出 warning 并使用当前版本继续 `start`；`aaw update` 则报错退出。
     已经开始移动正式目录后，必须先按 §5 完成回滚才能决定是否继续。
3. 使用响应中的 `latest_version` 和 `file_name` 构造
   `/api/v1/client/releases/{version}/download/{file_name}`，将 zip 流式下载到临时文件。
   下载的连接和每次阻塞读取超时均为 30 秒；只要持续有数据读取就不限制总下载时长，
   不自动重试。下载完成后的字节数必须等于查询接口返回的 `size_bytes`，否则按
   下载失败处理；该长度检查仅用于发现截断，不承担内容摘要校验。
4. 在共享锁阶段解压到 skills 根目录下的独立工作区
   `.aaw-stage-<random>/payload/`。该名称不匹配残留事务扫描的 `.aaw-txn-*`，
   因此不会被另一个共享锁持有者当成中断事务恢复或删除。
   - 逐成员校验路径不逃逸（防 zip-slip）
5. sanity 检查：
   - manifest 合法，顶层 Skill 目录与 `skills` 完全一致，每个都含 `SKILL.md`；
   - `aaw-workflow` 必须存在并含 `scripts/aaw.py` 与 `scripts/cli/VERSION`；
   - manifest version、zip 内 VERSION 和查询接口的 `latest_version` 三者必须相等，
     且都通过严格三段版本校验；
   - 解析内置 definitions 的所有 `execution: skill` / `skill: [...]` 引用，
     每个名称必须出现在 manifest `skills` 或 `external_skills`；其中每个
     `external_skills` 引用还必须在当前 skills 根目录下存在同名目录并含
     `SKILL.md`，否则不得换入一个无法执行的内置 workflow。
   - 对 manifest `skills` 和 `removed_skills` 指向的每个已存在目标目录单独
     做 `lstat`；任一目标是 symlink、junction 或 directory reparse point 均拒绝整个更新。
6. 换入前从共享锁升级为排他锁：释放共享锁，在 30 秒内获取排他锁，
   然后重新扫描残留事务并重读本地 VERSION。如果另一进程已经更新到
   相同或更高版本，删除本进程精确的 `.aaw-stage-<id>`，通过 handoff 重新执行当前版本的
   `start`；`aaw update` 返回已是最新。不允许已导入旧模块的进程直接继续 start。
7. 在排他锁下再次校验 manifest 全部已存在目标的 `lstat` 和冲突状态；
   先在本进程的 `.aaw-stage-<id>` 内写好并持久化 transaction.json/recover.py，
   再将该目录原子改名为 `.aaw-txn-<id>`，
   对 manifest 声明的完整托管集合执行一个更新事务（详见 §5）：
   - 换入前完成所有目标路径、冲突、权限和 payload 完整性预检；
   - 把旧 skill 逐个 rename 到本次事务的 `backup/` 中；
   - 把 payload 中的所有新 skill 逐个 rename 到正式位置；
   - 任一步失败时，按逆序移走已换入的新 skill，再恢复全部旧 skill；
   - 全部换入后，从正式位置重新读取 VERSION，确认其等于
     `latest_version`，并确认事务清单中的所有 skill 和必需入口均存在；
   - 提交前验证任一失败均整体回滚；全部验证成功后才标记 committed，
     然后删除 backup。
8. 更新失败且整体回滚成功：
   - 自动更新模式：释放排他锁并重新获取共享锁，向 stderr 输出 warning，
     使用当前旧版本继续 `start`；
   - `aaw update`：报错退出。
   如果回滚未成功，两种模式都必须立即报错退出，不允许继续创建 workflow。
9. 更新成功：
   - `aaw update`：向 stdout 打印"更新完成: 1.1.0 -> 1.2.0"并退出；
   - 自动更新模式：不在已导入旧模块的进程中继续 start。保留原始 argv，
     在 skills 根目录生成 `.aaw-handoff-<random>.json` 一次性 handoff 文件，
     显式释放排他锁，然后以 `os.execv(sys.executable, ...)` 重新执行换入后的 `scripts/aaw.py`
     和原始 `start` argv。
```

handoff 是一次性“进程接力凭据”，不是版本缓存。旧进程在更新前已导入
旧版 Python 模块，不能在换入新文件后继续执行 `start`；handoff 只保存
目标版本、创建时间和随机 token，原始 `start` argv 直接作为 `execv` 参数传递，
不写入文件。新进程消费 handoff 后就知道
“文件已换入，本次不再查询 server，直接执行原 start”，从而避免循环更新。

`aaw update --json` 的 stdout 是单个稳定 JSON 对象，进度信息仍只走 stderr：

```json
{
  "status": "updated",
  "from_version": "1.1.0",
  "to_version": "1.2.0",
  "updated_skills": ["aaw-workflow", "ar-clarify"],
  "removed_skills": []
}
```

`status` 取值为 `up_to_date` / `updated` / `failed` / `recovery_required`。前两者退出码为 0，
`failed` 为 1，`recovery_required` 为 2。只有 `updated` 必须返回 Skill 变更列表；
无可用包时的 `latest_version` 为 `null`。

三条实现纪律：

- 换入动作开始前把更新、回滚和重新执行所需模块全部 import 完毕；
  换入后除了从正式位置做提交前文件验证，不再 lazy import 被替换目录中的模块；
- 全程不 `chdir` 进被替换目录（Windows 无法 rename 任何进程 CWD 的祖先目录）。
- 重新执行的新进程必须先消费 handoff，确认本地 VERSION 已等于或高于
  handoff 的目标版本，然后不再请求 server，直接执行原始 `start` 参数。
  handoff 必须包含随机 token 并且只能成功消费一次；消费时先原子移走/
  删除 handoff 文件再继续。验证失败则报错退出，防止重新执行循环。
  如果 `execv` 本身失败，删除 handoff、向 stderr 说明“更新已完成但 start 未执行”
  并非零退出；用户重跑原 `start` 即可。

### 4.5 环境变量汇总

| 变量 | 端 | 用途 |
|---|---|---|
| `AAW_TELEMETRY_ENDPOINT` | CLI | 既有；release 接口复用同一 base |
| `AAW_TELEMETRY_RELEASE_DIR` | Server | 发布包目录 |

安装目录不提供生产环境变量覆盖。路径定位封装为接受可选路径参数的
内部函数，测试直接注入 tmp 路径；CLI 入口始终使用 `lexical_file` 自定位，
不允许通过外部环境变量更新另一套安装。
重新执行时传递的 handoff 文件路径与 token 是单次进程间协议，不是用户配置项。

### 4.6 向后兼容契约

完整包更新会替换 CLI、definitions、`aaw-workflow/SKILL.md` 与其他 skill。
由于用户级安装可能被多个项目共享，项目 A 的 `start` 触发更新后，项目 B
的已有 workflow 下次会由新版 CLI 继续处理。因此可进入本自动更新通道的发布
必须满足：

- 新版 CLI 能读取所有仍受支持的旧 `workflow.yaml`；schema 变化必须带可回滚的
  自动迁移，迁移失败不得部分写入 workflow；
- `start/status/next/done/user-confirm/rollback` 的命令参数和 JSON 契约只能
  向后兼容扩展，不得删除字段或改变既有字段语义；
- 当前 Agent 在调用 `start` 前可能已加载旧版 `aaw-workflow/SKILL.md`，因此
  旧版 Skill 契约必须能驱动新版 CLI。破坏性契约升级不得进入本自动更新通道；
- 本契约覆盖发布包中的全部 12 个 Skill，不只是 `aaw-workflow`：同一兼容
  范围内不得破坏 Skill 名称、触发意图、必需输入、交付件路径/格式、
  `--data` schema、references 模板和子 Skill 之间的契约；未来由 manifest
  新增并纳入完整包的 Skill 自动受同一兼容性契约约束；
- YAML definitions 的 schema 必须向后兼容。新字段必须有默认语义；已有
  `execution`、`skill`、`input`、`output`、`data_schema` 等字段不得在同一
  兼容范围内被删除或改变语义；
- 本期假定 release endpoint 中的所有发布都满足上述契约；不兼容版本的
  分发、主版本阻断和独立迁移流程不在本期范围。

### 4.7 YAML 扩展边界

完整包更新会原子替换 `aaw-workflow/`，因此不允许把用户扩展 YAML 直接
写入受管的 `aaw-workflow/scripts/cli/definitions/`。definitions 分为三层：

1. 内置：`aaw-workflow/scripts/cli/definitions/`，由发布包管理并随更新替换；
2. 安装级扩展：`<skills-root>/.aaw-extensions/definitions/`，与某一 harness 安装绑定；
3. 项目级扩展：`<project>/.sdd/.aaw/definitions/`，只对当前项目生效。

更新事务不得触碰后两层。CLI 按“内置 → 安装级 → 项目级”顺序加载，
但同名 entrypoint、step/template 或 edge 不做静默覆盖，必须报出冲突的两个
来源路径。扩展 YAML 的 `skill` 引用在运行时校验：对应的安装目录必须
存在且含 `SKILL.md`；因此新增 YAML 节点和新 Skill 都无需修改 CLI 硬编码。

打包阶段只校验内置 definitions：其 `skill` 引用必须位于 manifest `skills`
或 `external_skills`。这使新增内置 YAML/打包 Skill 可自动扩展，同时允许显式
声明由用户或其他插件提供的外部 Skill。

## 五、失败模型与恢复

### 5.1 原则：绝不逐文件覆盖

若直接把 zip 逐文件解压到现有目录，中途任何异常（磁盘满、坏 zip 条目、句柄
占用、进程被杀）都会留下**新旧文件混杂的半更新状态**——版本文件可能已是新的
而代码是旧的，且事后无法检测、无法自动恢复。

因此本方案中，下载、解压、写文件和结构检查全部在 stage 目录完成。
对现有安装的改动是一个覆盖 manifest `skills` 和 `removed_skills` 声明目标
的完整事务，不把单个 Skill 的 rename 成功当成整体成功，也不触碰
未在 manifest 中声明的用户自有 Skill 和 `.aaw-extensions/`。

共享锁阶段只创建不会触碰现有安装的预事务工作区：

```
.aaw-stage-<random>/
  release-manifest.json  # 下载包中经初步校验的发布清单
  payload/<skill>/       # 解压并完成 sanity 检查的新版本
```

共享锁阶段的 stage 不带 `transaction.json`，也不参与残留事务恢复。只有获取
排他锁、重新读取本地版本并再次检查目标后，才在本进程的 stage 内预写并持久化
事务清单与独立恢复脚本，再把 stage 在 skills 根目录内原子改名为事务目录。
因此不会出现一个已可见的 `.aaw-txn-*` 却没有恢复信息，且 stage、事务目录和
正式 Skill 都在同一文件系统内：

```
.aaw-txn-<random>/
  release-manifest.json  # 经校验的本次发布清单副本
  transaction.json       # 事务清单与每个 skill 的当前阶段，作为 write-ahead log 原子写
  payload/<skill>/       # 完整的新版本（来自同名 .aaw-stage 工作区）
  backup/<skill>/        # 从正式位置移入的旧版本
  displaced/<skill>/     # 回滚时从正式位置移走的新版本
```

换入次序固定为：持有安装级排他锁 → 在 stage 内持久化事务清单/recover.py
→ stage 原子改名为 transaction → 把 `skills` 和
`removed_skills` 中所有已存在旧目录移入 backup → 把 `skills` 中的所有新目录
移入正式位置 → 从正式位置验证 VERSION、入口、manifest 和 Skill 清单
→ 标记 committed → 清理 backup/事务目录 → 释放锁。在 committed 之前任一步失败
都进入整体回滚，必须恢复事务清单中的全部旧 skill，不允许保留
部分新版本。

transaction.json 的每次 write-ahead 状态更新都采用“同目录临时文件写入并 flush
→ 原子 `os.replace`”的方式；POSIX 还要 `fsync` 文件及其父目录，Windows 要对
文件 handle 执行 `FlushFileBuffers`。任何正式目录 rename 都只能发生在对应的
“即将执行”状态持久化之后。

多个 updater 可以各自在共享锁下下载，因此任何进程都只能删除自己持有精确路径的
`.aaw-stage-<id>`，不得用 glob 清理其他 stage。进程被强杀后遗留的 stage 不含
正式安装状态，不参与事务恢复；本期宁可保留这种无害孤立目录，也不冒险误删另一个
正在等待排他锁的 updater 工作区。

### 5.2 失败矩阵

| 阶段 | 典型失败 | 现场状态 | 处置 |
|---|---|---|---|
| 普通 CLI 命令获取共享锁 | 更新/恢复进程持有排他锁 | 安装可能正在事务换入 | 最多等待 30 秒；超时则报错，不导入或运行 CLI 业务模块 |
| 获取安装级排他锁 | 另一 CLI 进程持有共享锁，或另一更新/恢复进程持有排他锁 | **现有安装未被触碰** | Linux/macOS 和 Windows 均最多等待 30 秒；超时后两种模式都报错，不在变动中的安装上继续 start |
| 持锁后发现残留事务 | 上一 owner 异常退出 | 依事务阶段而定 | 先按事务清单恢复或清理，完成后才开新事务 |
| 下载 / 解压 / 结构检查 | 网络中断、坏 zip、磁盘满、sanity 失败 | **现有安装未被触碰** | 删除本进程精确的临时文件与 `.aaw-stage-<id>`；自动模式警告后继续 start，手动 update 报错 |
| 托管/删除集合的旧 Skill 移入 backup | 任一目录被占用 | 可能已备份部分 Skill | 按逆序恢复已移走的全部目录，报错退出 |
| 新 skill 换入正式位置 | 任一 rename 失败 | 可能已换入部分新 skill | 将已换入的新 skill 移入 displaced，再按逆序恢复全部 backup |
| 提交前验证 | VERSION 不匹配、入口或 skill 缺失 | 新 skill 已全部换入，尚未 committed | 将全部新 skill 移入 displaced，再恢复全部 backup |
| 提交后清理 backup | 杀软扫描等瞬时占用 | 更新已成功，仅残留事务目录 | 静默留存，下次 `start` 或 `aaw update` 进入更新流程时按 committed 状态清理 |

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

### 5.4 CLI 自替换与平台文件句柄

CPython import 完 `.py`/`.pyc` 即关闭文件句柄，运行中的自动或手动更新进程不
持有 skill 目录内任何打开句柄。Linux/macOS 允许 rename 已打开文件所在目录；
Windows 对目录占用更严格，因此实现还必须保证进程 CWD 不在被替换目录内，并在
换入前关闭 zip、临时文件以及 Skill 目录下的所有显式句柄。并行进程由安装级
共享/排他锁隔离；IDE、杀软等锁外部占用仍落在 §5.2 的目录 rename 失败场景，
报错后按事务清单整体回滚。

## 六、打包脚本

`scripts/make_release.py`（仓库根，发布者使用）：

1. 读 `skills/aaw-workflow/scripts/cli/VERSION` 得版本号 `v`，并按 §3.2 严格三段
   版本规则校验；
2. 校验 pyproject / 2×plugin.json / marketplace.json 与 `v` 一致，不一致即失败；
3. 扫描 `skills/*/SKILL.md`，动态得到本次 `skills` 列表（当前 12 个）；
   新增或删除 Skill 不需修改打包脚本中的名称常量；
4. 读发布配置 `scripts/release.yaml` 中显式声明的 `external_skills` 和
   `removed_skills`，生成
   `release-manifest.json`；校验名称合法、列表不交叉；
5. 解析 `aaw-workflow/scripts/cli/definitions/**/*.yaml`，收集所有 Skill 引用，
   确认每个都位于 manifest `skills` 或 `external_skills`；
6. 将 manifest 和 `skills` 列表中的全部目录打成
   `dist/aaw-skills-<v>.zip`，排除 `__pycache__`、`.pyc`、测试缓存和本地临时文件；
7. 重新打开生成的 zip，按客户端同样的 manifest/顶层目录规则自检；
8. 打印 zip 路径、文件大小、版本及 Skill 数量。

## 七、测试计划

| 范围 | 文件 | 要点 |
|---|---|---|
| 版本源 | `test/aaw_workflow/test_cli_version.py` | `--version` == VERSION 文件；五处版本一致守卫；只接受无前导零的严格三段版本；server、CLI 和打包脚本的版本样例共享同一组合法/非法用例 |
| Server 接口 | `telemetry-server/tests/test_releases.py` | tmp release 目录 fixture：多 zip 按三元整数版本取最大值、非法/非三段/`.uploading` 临时文件名忽略、空目录/未配置返回 null、按版本+文件名下载、参数不匹配或文件不存在返回 404 |
| 发布包 | `test/aaw_workflow/test_release_package.py` | 动态发现当前 12 个含 SKILL.md 的目录；manifest 与 zip 顶层完全一致；新增 Skill 自动入包；非 Skill 辅助目录不入包；保留/非法/交叉名称拒绝；内置 YAML 引用必须位于 `skills` 或 `external_skills`；打包后自检 |
| start 自动更新 | `test/aaw_workflow/test_cli_auto_update.py` | 每次 `start` 先恢复本地残留事务，再在加载 definitions/写 workflow 前实时查询；无新版或 server 不可用时也必须恢复；其他命令不发请求；30 秒查询 deadline；latest ≤ local 时只执行 start；查询失败时 stderr warning 且本地 start 成功；更新失败且回滚成功时使用旧版继续；更新成功后保留原 argv 重新执行；handoff token 只能消费一次、消费后不再请求 server；版本未达目标、伪造/重放 handoff 报错；`start --json` stdout 只有最终业务 JSON |
| update 事务 | `test/aaw_workflow/test_cli_update.py` | 内部路径定位函数注入 tmp 安装目录；相对 `__file__` 做绝对词法化且不穿透链接；当前 CLI 路径和 manifest 所有已存在目标的 symlink/junction/reparse point 拒绝；不读取 Git/install.sh/dirty 状态；Linux/macOS 的 `flock` 与 Windows 的 `LockFileEx` 分平台测试相同共享/排他语义；普通命令持有共享锁时可并发执行，排他更新必须等待全部共享锁释放；更新或恢复进程持有排他锁时新的普通命令不得导入 CLI 模块；锁等待 30 秒后失败；进程异常退出后锁自动释放；锁文件在更新和清理后保持同一文件对象；查询/下载后从共享锁升级为排他锁必须重读版本；并发 updater 各自的 `.aaw-stage-*` 不被当成残留事务或互相删除；事务清单必须先于 `.aaw-txn-*` 可见并在每次 rename 前持久化；manifest 缺失/额外目录/非法引用拒绝；external Skill 缺失拒绝；30 秒下载连接与读取超时及 `size_bytes` 截断检测；zip VERSION/manifest version/latest 不一致时不换入；zip-slip 和 sanity 失败拒绝；新增/替换/删除 Skill 在备份/换入/提交前验证任一阶段失败时整体回滚；用户自有 Skill 和扩展目录不变；中断恢复可重入；残留事务先恢复再查询 server；committed 残留清理；手动 `aaw update --json` 的全部状态、字段和退出码 |
| YAML 扩展 | `test/aaw_workflow/test_cli_definition_extensions.py` | 内置/安装级/项目级加载顺序；同名节点冲突报出两个来源；扩展引用的 Skill 目录必须存在且含 SKILL.md；完整包更新后扩展 YAML 与用户自有 Skill 保留 |
| 隔离 | `test/aaw_workflow/_cli_base.py` | 默认将 release 查询指向本地可控 fixture server，不依赖真实网络；`run_cli` 增加 `extra_env` 参数仅用于 handoff 子进程协议等进程级测试 |

## 八、提交划分

| # | 内容 | 主要文件 |
|---|---|---|
| 1 | 统一版本源 1.1.0 | `cli/VERSION`、`cli/version.py`、`cli/telemetry.py`、pyproject、plugin.json×2、marketplace.json、`test_cli_version.py` |
| 2 | server 发布接口 + 完整包打包脚本 | `config.py`、`routers/releases.py`、`main.py`、`tests/test_releases.py`、`scripts/release.yaml`、`scripts/make_release.py`、`test_release_package.py` |
| 3 | `start` 自动更新 + `aaw update` + 安装级读写锁 + YAML 扩展目录 | `scripts/aaw.py`、`cli/update.py`、`cli/main.py`、`cli/workflow.py`、`_cli_base.py`、`test_cli_auto_update.py`、`test_cli_update.py`、`test_cli_definition_extensions.py` |

Commit 2 与 1/3 无依赖可并行；3 依赖 1、2。

## 九、Non-goals（本期不做）

- 常驻进程、后台轮询、定时任务或 server 主动推送——自动更新只在
  `aaw start` 调用时同步触发；
- 发布 API / 鉴权 / 数据库表——发布 = 放文件；
- `min_version` 强制升级、多 channel（stable/beta）、增量更新；
- 跨主版本自动更新阻断、不兼容版本协商与独立迁移通道；
- 被强杀进程遗留的无害 `.aaw-stage-*` 自动垃圾回收；
- PowerShell 安装器（Windows 用户经 zip 更新链路已覆盖）。
