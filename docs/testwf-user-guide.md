# testwf 使用说明

`testwf` 是测试工作流的轻量 CLI。它只做两件事：记录开始时的本地代码基线，并在结束时上报开始后产生的测试代码 Diff。

## 1. 前置条件

- Python 3.11 或更高版本；
- 当前目录是 Git 工作区；
- Telemetry Server 已完成数据库迁移并可访问；
- 当前仓库已作为某个组件的 `repos` 子项登记在 Server 的 `projects.yaml`。

首次部署 Server 时执行：

```powershell
cd telemetry-server
alembic upgrade head
```

## 2. 安装

在本仓库中安装 CLI：

```powershell
cd testing-cli
python -m pip install -e .
```

安装成功后可确认命令：

```powershell
testwf --help
```

## 3. 配置 Server 地址

默认 Server 地址为 `http://127.0.0.1:18080`。如部署到其他地址，设置环境变量：

```powershell
$env:TESTWF_TELEMETRY_ENDPOINT = "https://telemetry.example.com"
```

若 Server 已启用 Bearer Token，再设置：

```powershell
$env:TESTWF_TELEMETRY_TOKEN = "<token>"
```

## 4. 标准流程

进入要生成或修改测试代码的 Git 工作区。

### 4.1 开始

```powershell
testwf start --repository team/example-service
```

该命令会：

1. 创建 `.testwf/workflow.json`，记录本次测试工作流的内部 ID；
2. 对当前工作区建立 D0 Git 树快照；
3. 向 `/api/v1/testing/telemetry/sync` 上报开始事件。

`--repository` 的值必须与 Telemetry Server `projects.yaml` 中某个组件的 `repos` 下登记的项目键一致。

随后生成或修改测试代码。可以包含已跟踪、未跟踪或未提交的文件；`.testwf/` 自身不会被纳入采集范围。

### 4.2 结束并上报

```powershell
testwf finished
```

该命令会：

1. 建立当前工作区的 D1 快照；
2. 生成 D0 到 D1 的本地 Git Diff；
3. 上报结束事件；
4. 上传 Diff 至 `/api/v1/testing/objects/code-changes/{message_id}`；
5. 由 Server 进行代码统计和归因，测试看板随后可展示生成量、合入量和采纳率。

如果开始后没有任何本地代码变化，`finished` 会拒绝结束，不会产生空的上报记录。

## 5. 网络失败与补发

网络请求失败不会丢失数据。待发送事件与 Diff 会保存在：

```text
.testwf/telemetry/outbox/
```

下次执行 `testwf start` 或 `testwf finished` 时，CLI 会先尝试补发这些待处理条目。收到 Server 的 `accepted` 或 `duplicate` 回执后，对应 outbox 文件会被删除。

## 6. 常见问题

| 现象 | 处理方式 |
|---|---|
| `No active test workflow` | 先在当前 Git 工作区执行 `testwf start`。 |
| `No local code changes since start` | 确认测试代码已在本地生成或修改后，再执行 `finished`。 |
| Git 命令失败 | 确认当前目录位于可用 Git 工作区，且 Git 可执行。 |
| `telemetry queued` | 网络或 Server 暂不可用；保留 `.testwf` 后稍后再次执行任一命令。 |
| 看板没有数据 | 确认 Server 已执行 `alembic upgrade head`、项目键已注册，且 Diff 上传成功。 |

## 7. 注意事项

- 一次 `start` 必须对应一次 `finished`；完成后可直接再次执行 `start` 开始新一轮采集。
- 不要在 `start` 与 `finished` 之间切换到另一个 Git 工作区。
- `testwf` 与 `aaw` 完全独立，使用 `.testwf` 状态目录和 `/api/v1/testing/*` API，不会写入 AAW 的 `.sdd` 数据。
