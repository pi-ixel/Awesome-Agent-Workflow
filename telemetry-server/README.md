# AAW Telemetry Server

AAW 工作流遥测采集与管理员统计服务。实现范围以仓库根目录的 `docs/telemetry-server-design.md` 为准。

## 能力范围

- 通过 `POST /api/v1/telemetry/sync` 接收固定结构的单 Step 状态消息，包括开始和终态。
- 以 `message_id` 和规范化内容哈希处理成功写入、原样重试与消息冲突。
- 同一工作流允许多个人参与；人员指标按每条消息的 `user_email` 汇总。
- 使用 MySQL 事务、行锁、外键和唯一约束维护状态一致性。
- 接收并确认 CLI 生成的原始 Diff；对象所有者是对应 Step 的 `message_id`。
- Diff 确认后计算 MVP 代码统计，并持久化明确标记的 `mock-v1` 归因结果。
- 提供总览、趋势、项目、用户、环节、工作流、代码归因和组件使用情况查询。
- 问题许愿池支持结构化描述和 PNG/JPEG/WebP 图片，图片落在对象存储目录并生成去除元数据的预览图。
- 当前 MVP 完全不鉴权，写入和查询接口均匿名访问。
- 输出按访问、业务和错误分流的人类可读日志，不记录 Token、remote 或请求体。

D0/D1、真实 MR 查询、真实代码归因算法、仓库扫描和 `installation_id` 不属于服务端能力。D0/D1 仍只保存在 CLI 本地；Dev Patch 上传属于本版本。Mock 归因只用于验证三端数据通路，不能作为真实归因结论。

## 本地启动

支持 Python 3.11+，生产镜像使用 Python 3.12；数据库要求 MySQL 5.7+，推荐 MySQL 8.0。

```powershell
cd D:\program\Awesome-Agent-Workflow\telemetry-server
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -e ../contracts -e ".[test]"
docker compose up -d mysql
Copy-Item .env.example .env
```

根据部署环境修改数据库配置：

```yaml
# config/database.yaml
host: 10.20.30.40
port: 3306
database: aaw_telemetry
username: aaw
password: replace-with-secret
charset: utf8mb4
```

应用和 Alembic 共用该文件。生产环境必须将文件权限设为 `0600`，不得把真实密码提交到版本库。数据库和账号由数据库管理员或基础设施流程预先创建，应用部署脚本不负责创建远程数据库或授权。

默认读取 `config/database.yaml`。文件位于其他位置时设置：

```text
AAW_TELEMETRY_DATABASE_CONFIG_FILE=/etc/aaw-telemetry/database.yaml
```

容器或紧急切换仍可设置完整的 `AAW_TELEMETRY_DATABASE_URL`；该变量优先于 YAML 文件。

根据实际仓库修改 `config/projects.yaml`。该文件采用组件分组结构：顶层 `components:` 下每个组件包含 `name`（组件名）、`se`（责任人）和 `repos:`（该组件所属仓库，键为上报用的仓库名，值为仓库配置）。Pydantic Settings 会读取进程环境；使用 `.env` 时应由启动器加载，服务本身不隐式读取项目外的配置。
修改项目配置后需要重启服务，使校验后的新配置生效。

问题图片默认存放在 `AAW_TELEMETRY_OBJECT_STORAGE_DIR/issue-images`。临时图片和从描述中
移除的图片在 24 小时后由应用内清理任务删除；默认单张 5 MiB、每个问题 10 张且合计
20 MiB。所有限制均可通过 `.env.example` 中的 `ISSUE_IMAGE_*` 配置覆盖。

日志由 Python 标准 `logging`、`logging.config.dictConfig` 和
`concurrent-log-handler` 管理。默认配置为 `config/logging.yaml`，生产环境写入：

```text
/var/log/aaw-telemetry/server.log
/var/log/aaw-telemetry/error.log
/var/log/aaw-telemetry/access.log
```

日志按日期或 100 MiB 切割，历史文件使用 gzip 压缩。配置文件和日志目录可以分别通过
`AAW_TELEMETRY_LOGGING_CONFIG_FILE` 与 `AAW_TELEMETRY_LOG_DIRECTORY` 覆盖。完整规则见
`docs/logging.md`。

```powershell
alembic upgrade head
uvicorn aaw_telemetry.main:app --reload --no-access-log
```

接口文档位于 `http://127.0.0.1:8000/docs`。存活和就绪检查分别为 `/health/live` 与 `/health/ready`。
联调自验控制台位于 `/self-test`，可运行 Step 上报、Diff 上传/确认、Mock 归因和全部看板查询。
前端与 CLI 的请求样例、联合验收步骤和问题反馈格式见 `docs/remote-integration.md`。

## 验证

```powershell
pytest
ruff check .
```

测试默认使用独立的内存数据库验证协议与领域规则。发布前还应对 MySQL 运行迁移测试和并发幂等测试，具体范围见 `docs/testing.md`。

## 生产要求

- 在 TLS 终止代理后运行服务，并只信任受控代理传入的头部。
- 当前服务没有鉴权，不应直接用于承载生产或敏感数据；公网 PoC 仅允许虚构测试数据。
- 数据库可以部署在独立节点；应用服务器只需能够访问配置文件中的主机和端口，不依赖本机 `mysql.service`。
- 生产数据库只能通过 Alembic 迁移创建或升级，服务启动时不会自动建表。
- 使用多进程部署时仍由 MySQL 行锁和约束保证一致性。
- 问题图片使用本地对象目录时只支持单个应用实例；横向扩容前必须改用共享文件卷或对象存储。
- 服务不会自动备份问题图片；文件丢失时接口返回 404，问题文字和其他字段仍可读取。
- 应用日志独立保存在 `/var/log/aaw-telemetry`；按 `request_id`、`event`、`error_code`、`message_id` 和 `workflow_id` 检索可读文本行。
