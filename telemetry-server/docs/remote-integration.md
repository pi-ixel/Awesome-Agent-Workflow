# 前端与 CLI 远程联调手册

## 1. 环境

| 项目 | 地址或值 |
|---|---|
| API | `http://39.108.107.148:18081` |
| OpenAPI | `http://39.108.107.148:18081/docs` |
| 自验页 | `http://39.108.107.148:18081/self-test` |
| 鉴权 | 无；不要发送 `Authorization` |

这是无 TLS、无鉴权的公开 PoC。只能发送虚构身份、测试 SR/AR 和专门构造的测试 Diff；不得发送真实源码、生产数据、凭据、Cookie 或其他敏感信息。

数据库连接由服务端 `config/database.yaml` 提供。更换应用服务器或数据库节点时，修改该文件中的主机、端口、库名和账号，执行迁移后再启动服务；CLI 和前端接口地址不受数据库节点变化影响。

## 2. 环境自检

```bash
curl -sS http://39.108.107.148:18081/health/live
curl -sS http://39.108.107.148:18081/health/ready
```

两项都应返回 `{"status":"ok"}`。

打开自验页并点击“运行完整自验”，页面会执行：

```text
上报 task-dev Step
→ 通过固定 URL 上传测试 Diff
→ 完成 Dev 并生成 Mock 归因
→ 查询全部看板接口
```

也可以运行远程烟测脚本：

```powershell
cd D:\dev\workspace-ai\Awesome-Agent-Workflow\telemetry-server
$env:AAW_SMOKE_BASE_URL='http://39.108.107.148:18081'
uv run --python 3.12 python deploy/remote-smoke-test.py
```

脚本成功时输出 `status=passed` 和对应的 `workflow_id`。

## 3. CLI 联调顺序

一次 Diff 采集只包含两次业务请求。完整字段约束以仓库根目录的 `docs/telemetry-api-contract.md` 为准。

### 3.1 上报 Step

```http
POST /api/v1/telemetry/sync
Content-Type: application/json
```

`task-dev + done` 消息必须声明 Diff 文件名和原始字节 SHA-256：

```json
{
  "message_id": "22222222-2222-4222-8222-222222222222",
  "workflow_id": "11111111-1111-4111-8111-111111111111",
  "aaw_version": "remote-smoke",
  "user_email": "smoke@example.com",
  "user_name": "Integration User",
  "repository": "team/example-service",
  "sr": "SR-REMOTE-SMOKE",
  "started_at": 1784163660000,
  "completed_at": 1784165400000,
  "updated_at": 1784165400000,
  "data": {
    "ar": "AR-REMOTE-SMOKE",
    "step_id": 12,
    "step_type": "task-dev",
    "step_name": "T2-task-dev",
    "attempt": 1,
    "execution_type": "skill",
    "skill_names": ["task-dev"],
    "task_id": "T2",
    "status": "done",
    "started_at": 1784163660000,
    "completed_at": 1784165400000,
    "file": {
      "file_name": "remote-smoke.diff",
      "sha256": "<Diff 原始字节的 64 位小写 SHA-256>"
    },
    "development": {
      "workflow_source": "repository",
      "implementation": "completed",
      "tests": "passed",
      "review_and_optimization": "completed",
      "revalidation": "passed"
    }
  }
}
```

新客户端必须用 `workflow_id + step_id + attempt` 标识一次真实执行，使 start/done 合并到同一个 Step。服务端仍兼容缺少这些身份字段的旧消息。

同一 AR 可以按 Task attempt 上报多个增量 Diff。看板汇总的是这些 Diff 的累计有效变更量，不代表 AR 首尾状态之间的最终净代码变化。

首次合法上报返回 `accepted`，原样重试返回 `duplicate`。重试必须复用相同的 `message_id`、时间和消息内容。

### 3.2 上传 Diff

```http
PUT /api/v1/objects/step-diffs/{message_id}
Content-Type: application/octet-stream

<Diff 原始字节>
```

客户端不创建上传会话，不发送文件大小，也不重复发送 SHA-256。服务端使用 Step 消息中声明的 SHA-256 校验请求体。Diff 默认上限为 10 MiB。

成功响应包含：

```json
{
  "request_id": "req-example",
  "message_id": "22222222-2222-4222-8222-222222222222",
  "status": "confirmed",
  "object_key": "step-diffs/22222222-2222-4222-8222-222222222222.diff",
  "sha256": "<已校验的 SHA-256>",
  "confirmed_at": 1784165400456
}
```

收到 `confirmed` 后上传完成。服务端已经同步完成文件落盘、Dev 状态更新、代码统计和 Mock 归因，不再调用单独的确认接口。上传中断时使用同一个 URL 重传完整文件；重复 PUT 相同 Diff 按成功处理。

## 4. 前端联调

前端直接调用看板接口并传入筛选参数：

```http
GET /api/v1/dashboard/overview?from=2026-07-15&to=2026-07-15&sr=SR-REMOTE-SMOKE
GET /api/v1/dashboard/trends?from=2026-07-15&to=2026-07-15&granularity=day
GET /api/v1/dashboard/projects?from=2026-07-15&to=2026-07-15
GET /api/v1/dashboard/users?from=2026-07-15&to=2026-07-15
GET /api/v1/dashboard/steps?from=2026-07-15&to=2026-07-15
GET /api/v1/dashboard/workflows?from=2026-07-15&to=2026-07-15&sr=SR-REMOTE-SMOKE
GET /api/v1/statistics/code-attribution?result_status=finalized_match
GET /api/v1/workflows/{workflow_id}
```

`GET /api/v1/dashboard/filter-options` 只用于构建筛选候选值。所有 `mock-v1` 或带 `mock_attribution` 的数据必须显示“Mock 归因”。前端不上传或展示 Diff，也不跳转 `example.invalid` Mock URL。

## 5. 验收清单

1. 健康检查和自验页运行成功。
2. OpenAPI 只包含固定 Diff PUT，不包含旧上传会话和确认接口。
3. PUT 成功后文件状态为 `confirmed`，Dev 状态为 `completed`。
4. 重复 PUT 相同 Diff 返回相同业务结果，不重复增加统计。
5. SHA-256 不一致返回 `FILE_HASH_MISMATCH`，且不替换已确认文件。
6. 超过上传窗口或 10 MiB 上限的 Diff 被拒绝。
7. 工作流详情、归因列表和聚合接口返回一致结果。
8. 浏览器和 CLI 请求都不包含 `Authorization`。

## 6. 问题反馈

反馈应包含请求时间、调用方、HTTP 方法和路径、状态码、`request_id`、`message_id` 和 `error.code`。不得附带 Token、Cookie、凭据、Diff、源码、SHA-256、`object_key` 或完整请求体。
