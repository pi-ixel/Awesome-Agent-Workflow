# 版本发布指南

本文描述如何发布一个新的 AAW skills 版本，使已安装的 CLI 能通过自动更新机制拿到新包。
机制设计见 `docs/auto-update-design.md`。

发布的基本模型：**把 `aaw-skills-<x.y.z>.zip` 放进服务端的发布目录即完成发布；
把文件删掉即撤回**。服务端不做任何注册或数据库操作，每次请求实时扫描目录。

## 一、发布流程总览

1. 升版本号（五处保持一致）；
2. 按需维护 `scripts/release.yaml`；
3. 运行 `scripts/make_release.py` 打包；
4. 把 zip 放到服务端 `AAW_TELEMETRY_RELEASE_DIR` 目录；
5. 验证 `/api/v1/client/release` 返回新版本。

## 二、升版本号

版本号必须是严格三段、无前导零的 `x.y.z`（正则
`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$`），如 `1.2.0`。`1.02.0`、`v1.2.0`、
`1.2` 均不合法，会被打包脚本和服务端拒绝。

以下 **五处** 必须同时改为同一版本号，打包脚本会强制校验：

| 文件 | 位置 |
| --- | --- |
| `skills/aaw-workflow/scripts/cli/VERSION` | 整个文件就是版本号（**版本源**） |
| `pyproject.toml` | `[project] version` |
| `.claude-plugin/plugin.json` | `version` |
| `.codex-plugin/plugin.json` | `version` |
| `.claude-plugin/marketplace.json` | `plugins[0].version` |

此外，每个 `skills/*/SKILL.md` 的 frontmatter 必须带四段 `version: "x.y.z.n"`
（加引号防 YAML 解析成数字）：前三段必须等于发布版本号，第四段是该 skill
自己的修订号。打包脚本会校验前三段一致；升发布版本时需同步刷新所有 SKILL.md。

## 三、维护 release.yaml（按需）

`scripts/release.yaml` 声明两类特殊 skill，通常保持空列表即可：

```yaml
# definitions 允许引用、但不随包分发的扩展 Skill（更新时要求目标机本地已存在）
external_skills: []
# 本版本明确从 AAW 托管集合中删除的历史 Skill（客户端更新时会移除）
removed_skills: []
```

约束（打包脚本会校验）：名字不得带路径分隔符、不得以 `.aaw-` 开头、
两个列表不得重复、不得与随包分发的 skills 集合交叉。

若本版本变更了 CLI 的第三方依赖，需同步修改两处声明（打包脚本会校验一致）：
`skills/aaw-workflow/scripts/aaw.py` 的 PEP 723 内联 `dependencies` 与根
`pyproject.toml` 的 `[project] dependencies`。依赖来源由各机器自身的 uv
配置决定（内网环境在装机时配置 `uv.toml` 指向可达源），发布物不携带源信息。

## 四、打包

在仓库根目录运行（任意 Python 3.11+ 即可，无第三方依赖）：

```powershell
python scripts/make_release.py
```

脚本自动执行：

1. 读取 `VERSION` 并校验上述五处版本一致；
2. 扫描 `skills/*/SKILL.md` 收集全部随包分发的 skill；
3. 校验 `release.yaml` 与 definitions 中的 skill 引用
   （所有引用必须落在 skills ∪ external_skills 内）；
4. 生成 `release-manifest.yaml`（schema 1，含 version / skills /
   external_skills / removed_skills）并打包；
5. 排除 `__pycache__`、`*.pyc`、`.pytest_cache`、`.DS_Store`；
6. 重新打开 zip 自检内容与 manifest 一致。

产物：`dist/aaw-skills-<version>.zip`。任何校验失败都会报错并以退出码 1 终止，
不会产出半成品包。

## 五、上架到服务端

服务端通过环境变量 `AAW_TELEMETRY_RELEASE_DIR` 指定发布目录（未设置则发布接口
始终返回"无版本"）。发布就是把包放进去：

```bash
# 建议先以临时名上传再原子改名，避免客户端下到半个文件
scp dist/aaw-skills-1.2.0.zip server:/srv/aaw-releases/aaw-skills-1.2.0.zip.uploading
ssh server mv /srv/aaw-releases/aaw-skills-1.2.0.zip.uploading /srv/aaw-releases/aaw-skills-1.2.0.zip
```

规则：

- 目录中只有文件名完全匹配 `aaw-skills-<x.y.z>.zip` 的文件才会被识别，
  临时名（如 `.uploading` 后缀）自动忽略；
- 存在多个包时，接口返回**版本号最大**的那个；
- 删除文件即撤回该版本，无需重启服务；
- 发布新版本也无需重启服务。

## 六、验证

```bash
curl http://<server>:<port>/api/v1/client/release
```

期望返回：

```json
{
  "latest_version": "1.2.0",
  "file_name": "aaw-skills-1.2.0.zip",
  "size_bytes": 233163,
  "released_at": "2026-07-20T01:00:00Z"
}
```

再验证下载接口可用：

```bash
curl -fO http://<server>:<port>/api/v1/client/releases/1.2.0/download/aaw-skills-1.2.0.zip
```

之后任意一台已安装机器上运行 `aaw update`（或等 `aaw start` 触发自动更新）
应能拿到新版本，见 `docs/client-update.md`。

## 七、撤回版本

直接删除发布目录中对应的 zip：

```bash
ssh server rm /srv/aaw-releases/aaw-skills-1.2.0.zip
```

接口随即回落到目录中剩余的最大版本；目录为空时返回 `latest_version: null`，
客户端视为"无可用更新"。

> 注意：撤回只影响尚未更新的客户端；已更新的客户端不会自动降级
> （客户端只在服务端版本**高于**本地版本时才更新）。
