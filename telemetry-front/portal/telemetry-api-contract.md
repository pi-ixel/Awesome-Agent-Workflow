# AAW 数据采集系统 HTTP API 契约

## 1. 文档范围

本文定义 AAW CLI、服务端和管理员看板之间的 HTTP 接口，是三端联调的唯一接口事实来源。

- 服务端业务设计：[`telemetry-server-design.md`](./telemetry-server-design.md)
- CLI 能力需求：[`telemetry-cli-requirements.md`](./telemetry-cli-requirements.md)
- 前端能力需求：[`telemetry-frontend-requirements.md`](./telemetry-frontend-requirements.md)

本文不定义 Dev Diff 生成方式、MR 查询实现和 80% 归因算法。

## 2. 通用协议

### 2.1 基础约定

| 项目 | 约束 |
|---|---|
| API 前缀 | `/api/v1` |
| JSON 编码 | UTF-8 |
| JSON Content-Type | `application/json` |
| 对象 Content-Type | `application/octet-stream` |
| 时间 | RFC 3339 UTC，例如 `2026-07-13T10:20:30Z` |
| UUID | RFC 4122 字符串 |
| 日期 | `YYYY-MM-DD` |
| 比率 | `0..1` 小数；不适用时为 `null` |
| 请求追踪 | 服务端响应 `request_id` |

除预签名对象上传 URL 外，所有接口都要求 TLS。

### 2.2 鉴权

| 调用方 | 鉴权 | 可访问范围 |
|---|---|---|
| CLI | `Authorization: Bearer <write-token>` | `/telemetry`、`/objects` |
| 管理员前端 | 内部统一认证会话或 `Bearer <admin-token>` | `/dashboard`、`/statistics`、工作流查询 |

CLI Token 不得访问管理员查询接口；普通成员没有看板查询权限。

### 2.3 字段规则

- 请求中未出现的可更新字段保持原值。
- 只有标记为可空的字段允许显式 `null`。
- 数字字段必须是 JSON number，不接受数字字符串。
- 未声明的请求字段在 `schema_version=1` 下返回 `INVALID_REQUEST`。
- 客户端必须忽略响应中新增加的未知字段。
- 所有计数字段为非负整数，最大值为 `2147483647`。

常用类型：

| 类型 | 格式 |
|---|---|
| `Email` | 去除首尾空格并转为小写，长度 1～320 |
| `GitSha` | 40 或 64 位小写十六进制 |
| `Sha256` | 64 位小写十六进制 |
| `Version` | 长度 1～64 |
| `Branch` | 长度 1～512 |
| `ShortName` | 长度 1～128 |
| `DisplayName` | 长度 1～256 |
| `URL` | 长度不超过 2048 |

### 2.4 成功与错误响应

普通成功响应：

```json
{
  "request_id": "req-01J2EXAMPLE",
  "data": {}
}
```

分页成功响应：

```json
{
  "request_id": "req-01J2EXAMPLE",
  "page": 1,
  "page_size": 50,
  "total": 120,
  "items": []
}
```

请求级错误：

```json
{
  "request_id": "req-01J2EXAMPLE",
  "error": {
    "code": "INVALID_REQUEST",
    "message": "records must contain 1 to 100 items",
    "retryable": false,
    "details": []
  }
}
```

`message` 用于诊断，不作为客户端分支判断条件；客户端只根据 HTTP 状态、`code` 和 `retryable` 处理。

## 3. 公共数据结构

### 3.1 `repository_identity`

```json
{
  "remotes": [
    {"name": "origin", "url": "git@git.company.com:user/order-service.git"},
    {"name": "upstream", "url": "git@git.company.com:platform/order-service.git"}
  ],
  "branch": "feature/SR-123",
  "target_branch_hint": "master"
}
```

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `remotes` | array | 是 | 1～16 项 |
| `remotes[].name` | string | 是 | `ShortName`，同一数组内唯一 |
| `remotes[].url` | string | 是 | `URL`，必须移除用户名密码、Token和无关查询参数 |
| `branch` | string | 是 | `Branch` |
| `target_branch_hint` | string/null | 否 | `Branch` |

不得上传本地仓库绝对路径。

### 3.2 `code_statistics`

```json
{
  "total_effective_lines": 860,
  "files_changed": 14,
  "categories": {
    "production_source": {"effective_lines": 520, "files_changed": 7},
    "test_source": {"effective_lines": 240, "files_changed": 4},
    "sql": {"effective_lines": 60, "files_changed": 1},
    "shell": {"effective_lines": 0, "files_changed": 0},
    "configuration": {"effective_lines": 40, "files_changed": 2},
    "other_script": {"effective_lines": 0, "files_changed": 0}
  },
  "quality_flags": []
}
```

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `total_effective_lines` | integer | 是 | 非负 |
| `files_changed` | integer | 是 | 非负 |
| `categories` | object | 是 | 六个类别都必须出现 |
| `categories.*.effective_lines` | integer | 是 | 非负 |
| `categories.*.files_changed` | integer | 是 | 非负 |
| `quality_flags` | array[string] | 是 | 最多 32 项，每项不超过 128 字符 |

类别有效行之和必须等于 `total_effective_lines`。

## 4. CLI 状态同步

### 4.1 批量同步

```http
POST /api/v1/telemetry/sync:batch
Authorization: Bearer <write-token>
Content-Type: application/json
```

请求体：

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `schema_version` | integer | 是 | 当前固定为 `1` |
| `installation_id` | UUID | 是 | 安装实例 ID，重装前保持稳定 |
| `records` | array | 是 | 1～100 项；整个 JSON 默认不超过 1 MiB |

每条记录：

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `record_type` | string | 是 | `workflow_run`、`step_execution`、`dev_run` |
| `record_id` | UUID | 是 | 对应业务记录 ID |
| `occurred_at` | datetime | 是 | 客户端发生时间 |
| `data` | object | 是 | 由 `record_type` 决定 |

### 4.2 `workflow_run`记录

创建示例：

```json
{
  "record_type": "workflow_run",
  "record_id": "e662dd70-d60c-49b4-81c2-d36e0f568763",
  "occurred_at": "2026-07-13T09:00:00Z",
  "data": {
    "repository_identity": {
      "remotes": [
        {"name": "origin", "url": "git@git.company.com:user/order-service.git"}
      ],
      "branch": "feature/SR-123",
      "target_branch_hint": "master"
    },
    "git_user_email": "zhangsan@company.com",
    "git_user_name": "张三",
    "sr": "SR-123",
    "ar": "AR-456",
    "aaw_version": "0.2.0",
    "status": "in_progress",
    "started_at": "2026-07-13T09:00:00Z",
    "last_activity_at": "2026-07-13T09:00:00Z"
  }
}
```

| 字段 | 类型 | 创建必填 | 可空 | 约束 |
|---|---|---|---|---|
| `repository_identity` | object | 是 | 否 | 见 3.1；更新时可省略 |
| `git_user_email` | Email | 是 | 否 | Git配置邮箱 |
| `git_user_name` | string | 是 | 否 | 长度 1～200 |
| `sr` | string | 是 | 否 | 长度 1～128 |
| `ar` | string | 否 | 是 | 长度 1～128 |
| `aaw_version` | Version | 是 | 否 | 统一发布版本 |
| `status` | string | 是 | 否 | `in_progress`、`completed` |
| `started_at` | datetime | 是 | 否 | 工作流开始时间 |
| `completed_at` | datetime | 否 | 是 | `completed`时必填 |
| `last_activity_at` | datetime | 是 | 否 | 最近有效活动时间 |

`project_key`由服务端解析，不接受CLI直接提交。

### 4.3 `step_execution`记录

```json
{
  "record_type": "step_execution",
  "record_id": "317e6041-d928-4bd7-a3de-e4974c1624db",
  "occurred_at": "2026-07-13T10:20:30Z",
  "data": {
    "workflow_run_id": "e662dd70-d60c-49b4-81c2-d36e0f568763",
    "step_id": 8,
    "step_type": "module-design-gate",
    "step_name": "支付模块设计门禁",
    "skill_names": ["module-design-gate"],
    "execution_type": "skill",
    "attempt": 1,
    "status": "completed",
    "started_at": "2026-07-13T10:00:00Z",
    "ended_at": "2026-07-13T10:20:30Z"
  }
}
```

| 字段 | 类型 | 创建必填 | 可空 | 约束 |
|---|---|---|---|---|
| `workflow_run_id` | UUID | 是 | 否 | 父工作流必须存在 |
| `step_id` | integer | 是 | 否 | 大于等于 1 |
| `step_type` | string | 是 | 否 | `ShortName` |
| `step_name` | string | 是 | 否 | `DisplayName` |
| `skill_names` | array[string] | 是 | 否 | 0～32 项，每项 `ShortName` |
| `execution_type` | string | 是 | 否 | `skill`、`prompt`、`manual`、`noop` |
| `attempt` | integer | 是 | 否 | 大于等于 1 |
| `status` | string | 是 | 否 | `ready`、`running`、`completed`、`failed`、`blocked`、`superseded` |
| `started_at` | datetime | 是 | 否 | 实际开始时间 |
| `ended_at` | datetime | 否 | 是 | 终态时必填，且不早于`started_at` |

唯一键为`workflow_run_id + step_id + attempt`。相同 attempt 重试时必须沿用相同`record_id`。

### 4.4 `dev_run`记录

开始记录：

```json
{
  "record_type": "dev_run",
  "record_id": "4b2435de-c605-4df4-b275-0449082b05bb",
  "occurred_at": "2026-07-13T10:00:00Z",
  "data": {
    "workflow_run_id": "e662dd70-d60c-49b4-81c2-d36e0f568763",
    "step_execution_id": "317e6041-d928-4bd7-a3de-e4974c1624db",
    "branch": "feature/SR-123",
    "head_sha_start": "1111111111111111111111111111111111111111",
    "status": "running",
    "started_at": "2026-07-13T10:00:00Z"
  }
}
```

等待对象记录：

```json
{
  "record_type": "dev_run",
  "record_id": "4b2435de-c605-4df4-b275-0449082b05bb",
  "occurred_at": "2026-07-13T10:25:00Z",
  "data": {
    "status": "waiting_objects",
    "head_sha_end": "2222222222222222222222222222222222222222",
    "completed_at": "2026-07-13T10:25:00Z",
    "window_ends_at": "2026-08-12T10:25:00Z",
    "code_statistics": {
      "total_effective_lines": 860,
      "files_changed": 14,
      "categories": {
        "production_source": {"effective_lines": 520, "files_changed": 7},
        "test_source": {"effective_lines": 240, "files_changed": 4},
        "sql": {"effective_lines": 60, "files_changed": 1},
        "shell": {"effective_lines": 0, "files_changed": 0},
        "configuration": {"effective_lines": 40, "files_changed": 2},
        "other_script": {"effective_lines": 0, "files_changed": 0}
      },
      "quality_flags": []
    }
  }
}
```

对象确认后的完成记录：

```json
{
  "record_type": "dev_run",
  "record_id": "4b2435de-c605-4df4-b275-0449082b05bb",
  "occurred_at": "2026-07-14T08:00:00Z",
  "data": {
    "status": "completed",
    "patch_object_key": "telemetry/2026/07/workflow-id/dev-run-id/dev.patch.zst"
  }
}
```

| 字段 | 类型 | 创建必填 | 可空 | 约束 |
|---|---|---|---|---|
| `workflow_run_id` | UUID | 是 | 否 | 父工作流必须存在 |
| `step_execution_id` | UUID | 是 | 否 | 必须属于同一工作流 |
| `branch` | Branch | 是 | 否 | Dev分支 |
| `head_sha_start` | GitSha | 是 | 否 | Dev开始HEAD |
| `head_sha_end` | GitSha | 否 | 是 | `waiting_objects`起必填 |
| `status` | string | 是 | 否 | `running`、`waiting_objects`、`completed`、`failed`、`superseded` |
| `started_at` | datetime | 是 | 否 | Dev开始时间 |
| `completed_at` | datetime | 否 | 是 | `waiting_objects`起必填 |
| `window_ends_at` | datetime | 否 | 是 | `completed_at + 30天` |
| `code_statistics` | object | 否 | 是 | `waiting_objects`起必填，见3.2 |
| `patch_object_key` | string | 否 | 是 | `completed`必填，必须是已确认对象 |

### 4.5 批量响应

```json
{
  "request_id": "req-01J2EXAMPLE",
  "results": [
    {
      "record_type": "step_execution",
      "record_id": "317e6041-d928-4bd7-a3de-e4974c1624db",
      "status": "accepted",
      "server_updated_at": "2026-07-13T10:20:31Z",
      "error": null
    },
    {
      "record_type": "dev_run",
      "record_id": "4b2435de-c605-4df4-b275-0449082b05bb",
      "status": "rejected",
      "server_updated_at": null,
      "error": {
        "code": "OBJECT_NOT_READY",
        "message": "patch object has not been confirmed",
        "retryable": true
      }
    }
  ]
}
```

单条`status`：

| 值 | 含义 |
|---|---|
| `accepted` | 创建或更新成功 |
| `duplicate` | 相同记录、时间和内容已处理 |
| `stale` | `occurred_at`早于当前记录时间，未覆盖 |
| `rejected` | 字段、关联或状态转换非法 |

批次内容可解析且通过鉴权时返回HTTP 200，单条失败通过`results[].error`表达。请求体整体无法处理时返回请求级4xx/5xx。

### 4.6 幂等、时间与状态

- 只比较同一记录前后两个客户端`occurred_at`，不比较客户端时间与服务端接收时间。
- 相同`record_id + occurred_at + payload`视为`duplicate`。
- 相同`record_id + occurred_at`但内容不同，返回`TIMESTAMP_CONFLICT`。
- 更早时间返回`stale`。
- 工作流状态由客户端时间决定，允许后续合法回退将`completed`重新变为`in_progress`。
- Step和Dev的`completed`、`failed`、`superseded`是终态；重新执行必须创建新的attempt或Dev run。
- Dev正常路径为`running → waiting_objects → completed`。
- 离线补传可以直接创建终态记录，但必须同时提供创建和终态所需全部字段。
- 记录创建后，父级ID、`step_id`、`attempt`、仓库身份、Dev分支和起始HEAD不可修改；身份变化必须创建新记录。

## 5. Dev Patch对象接口

### 5.1 创建上传会话

```http
POST /api/v1/objects/uploads
Authorization: Bearer <write-token>
Content-Type: application/json
```

```json
{
  "object_type": "dev_patch",
  "owner_id": "4b2435de-c605-4df4-b275-0449082b05bb",
  "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "compressed_size_bytes": 483210,
  "compression": "zstd"
}
```

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `object_type` | string | 是 | 固定`dev_patch` |
| `owner_id` | UUID | 是 | 已存在的`dev_run.id` |
| `sha256` | Sha256 | 是 | 压缩后对象哈希 |
| `compressed_size_bytes` | integer | 是 | 1～52428800 |
| `compression` | string | 是 | `zstd`、`gzip` |

响应：

```json
{
  "request_id": "req-01J2EXAMPLE",
  "data": {
    "upload_id": "upl-01J2EXAMPLE",
    "object_key": "telemetry/2026/07/workflow-id/dev-run-id/dev.patch.zst",
    "upload_url": "https://object.example.com/signed-upload",
    "required_headers": {
      "Content-Type": "application/octet-stream"
    },
    "expires_at": "2026-07-13T10:35:00Z",
    "already_completed": false
  }
}
```

相同`owner_id + object_type + sha256`重复申请具有幂等性。

### 5.2 上传对象内容

CLI向`upload_url`执行：

```http
PUT <upload_url>
Content-Type: application/octet-stream
Content-Length: 483210

<compressed binary body>
```

- 该请求使用预签名URL，不携带AAW Bearer Token。
- 必须发送`required_headers`返回的全部Header。
- Body必须是创建会话时计算SHA-256和大小的同一压缩文件。
- URL过期后重新调用创建会话接口。
- 对象存储成功不代表服务端已接受，仍必须确认上传。

### 5.3 确认上传

```http
POST /api/v1/objects/uploads/{upload_id}:complete
Authorization: Bearer <write-token>
Content-Type: application/json
```

```json
{
  "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "compressed_size_bytes": 483210
}
```

响应：

```json
{
  "request_id": "req-01J2EXAMPLE",
  "data": {
    "status": "completed",
    "object_key": "telemetry/2026/07/workflow-id/dev-run-id/dev.patch.zst",
    "verified_at": "2026-07-14T07:59:58Z"
  }
}
```

服务端必须校验对象存在、大小和SHA-256。重复确认返回相同完成结果。

## 6. 管理员查询通用参数

### 6.1 公共过滤参数

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `from` | date | 当前日期前29天 | cohort开始日期 |
| `to` | date | 当前日期 | cohort结束日期 |
| `project_key` | string，可重复 | 全部 | 项目过滤 |
| `git_user_email` | Email，可重复 | 全部 | Git用户过滤 |
| `aaw_version` | Version，可重复 | 全部 | 版本过滤 |
| `sr` | string | 全部 | SR精确匹配 |
| `ar` | string | 全部 | AR精确匹配 |

- `from <= to`。
- 同一字段重复值按OR，不同字段按AND。
- 聚合统一以`workflow_run.started_at`形成cohort。
- 当前活跃/暂停快照不应用`from/to`，仍应用项目、用户和版本过滤。

### 6.2 分页与排序

| 参数 | 类型 | 默认 | 约束 |
|---|---|---|---|
| `page` | integer | 1 | 大于等于1 |
| `page_size` | integer | 50 | 1～100 |
| `sort_by` | string | 接口默认值 | 必须在接口白名单中 |
| `sort_order` | string | `desc` | `asc`、`desc` |

## 7. 管理员看板接口

### 7.0 归因口径（80% / 90% 两档）

看板所有归因指标按**两档一致度阈值**并列返回：

- `attributed_lines_80` / `attribution_rate_80`：合入代码与 AI 生成代码一致度 **≥80%** 的归因行数 / 比率。
- `attributed_lines_90` / `attribution_rate_90`：一致度 **≥90%** 的归因行数 / 比率。

约定：

- 两档共用同一分母 `dev_effective_lines`，即 `attribution_rate_8X = attributed_lines_8X / dev_effective_lines`（分母为 0 时比率为 `null`）。
- 阈值越严归入越少，恒有 `attributed_lines_90 <= attributed_lines_80 <= dev_effective_lines`。
- 80/90 是"一致度阈值"口径，与 §7.8 明细中的 `exact_match_lines` / `fuzzy_match_lines` / `block_match_lines`（匹配"手段"维度）**正交**，两者不可相加换算。

### 7.1 筛选项

```http
GET /api/v1/dashboard/filter-options
Authorization: Bearer <admin-token>
```

```json
{
  "request_id": "req-01J2EXAMPLE",
  "data": {
    "projects": [
      {"project_key": "order-service", "display_name": "订单服务"}
    ],
    "git_users": [
      {"email": "zhangsan@company.com", "name": "张三"}
    ],
    "aaw_versions": ["0.2.0"],
    "result_statuses": ["pending", "finalized_match", "finalized_no_match", "failed"]
  }
}
```

### 7.2 总览

```http
GET /api/v1/dashboard/overview?from=2026-07-01&to=2026-07-31&project_key=order-service
Authorization: Bearer <admin-token>
```

```json
{
  "request_id": "req-01J2EXAMPLE",
  "data": {
    "period": {
      "workflow_runs": 320,
      "completed_workflows": 240,
      "workflow_completion_rate": 0.75,
      "active_users": 46,
      "active_projects": 8,
      "dev_runs": 410,
      "pending_attribution_dev_runs": 22,
      "dev_effective_lines": 58400,
      "attributed_lines_80": 31720,
      "attributed_lines_90": 26980,
      "attribution_rate_80": 0.5432,
      "attribution_rate_90": 0.4619
    },
    "current": {
      "active_workflows": 18,
      "stalled_workflows": 7,
      "activity_threshold_hours": 24
    }
  }
}
```

### 7.3 趋势

```http
GET /api/v1/dashboard/trends?from=2026-07-01&to=2026-07-31&granularity=day
Authorization: Bearer <admin-token>
```

额外参数：`granularity=day|week`，默认`day`。

```json
{
  "request_id": "req-01J2EXAMPLE",
  "data": {
    "granularity": "day",
    "points": [
      {
        "period_start": "2026-07-01",
        "workflow_runs": 12,
        "completed_workflows": 9,
        "dev_effective_lines": 2140,
        "attributed_lines_80": 1260,
        "attributed_lines_90": 1010
      }
    ]
  }
}
```

无数据日期必须返回数值为0的数据点，保证时间序列连续。

### 7.4 项目汇总

```http
GET /api/v1/dashboard/projects?from=2026-07-01&to=2026-07-31&page=1&page_size=50
Authorization: Bearer <admin-token>
```

允许排序：`workflow_runs`、`active_users`、`dev_runs`、`dev_effective_lines`、`attributed_lines_80`、`attributed_lines_90`、`attribution_rate_80`、`attribution_rate_90`。默认`attributed_lines_80 desc`。

```json
{
  "request_id": "req-01J2EXAMPLE",
  "page": 1,
  "page_size": 50,
  "total": 1,
  "items": [
    {
      "project_key": "order-service",
      "display_name": "订单服务",
      "workflow_runs": 82,
      "active_users": 17,
      "dev_runs": 106,
      "pending_attribution_dev_runs": 5,
      "dev_effective_lines": 18200,
      "attributed_lines_80": 10240,
      "attributed_lines_90": 8760,
      "attribution_rate_80": 0.5626,
      "attribution_rate_90": 0.4813
    }
  ]
}
```

### 7.5 Skill/环节汇总

```http
GET /api/v1/dashboard/steps?from=2026-07-01&to=2026-07-31&group_by=step_type
Authorization: Bearer <admin-token>
```

额外参数：`group_by=step_type|skill`，默认`step_type`。

```json
{
  "request_id": "req-01J2EXAMPLE",
  "data": {
    "group_by": "step_type",
    "items": [
      {
        "key": "module-design-gate",
        "display_name": "模块设计门禁",
        "reached": 180,
        "completed": 150,
        "failed": 8,
        "blocked": 12,
        "completion_rate": 0.8333,
        "median_duration_seconds": 420,
        "p90_duration_seconds": 980,
        "retry_count": 36,
        "first_attempt_pass_rate": 0.72
      }
    ]
  }
}
```

非Gate环节的`first_attempt_pass_rate`返回`null`。

### 7.6 工作流列表

```http
GET /api/v1/dashboard/workflows?state=active&page=1&page_size=50
Authorization: Bearer <admin-token>
```

额外参数：`state=in_progress|completed|active|stalled`。允许排序：`started_at`、`last_activity_at`、`dev_effective_lines`、`attributed_lines_80`、`attributed_lines_90`；默认`last_activity_at desc`。

```json
{
  "request_id": "req-01J2EXAMPLE",
  "page": 1,
  "page_size": 50,
  "total": 1,
  "items": [
    {
      "workflow_run_id": "e662dd70-d60c-49b4-81c2-d36e0f568763",
      "project_key": "order-service",
      "project_display_name": "订单服务",
      "git_user_email": "zhangsan@company.com",
      "git_user_name": "张三",
      "sr": "SR-123",
      "ar": "AR-456",
      "aaw_version": "0.2.0",
      "status": "in_progress",
      "activity_state": "active",
      "furthest_step_type": "task-dev",
      "started_at": "2026-07-13T09:00:00Z",
      "last_activity_at": "2026-07-13T10:20:30Z",
      "dev_effective_lines": 860,
      "attributed_lines_80": 620,
      "attributed_lines_90": 510
    }
  ]
}
```

### 7.7 工作流详情

```http
GET /api/v1/workflows/{workflow_run_id}
Authorization: Bearer <admin-token>
```

```json
{
  "request_id": "req-01J2EXAMPLE",
  "data": {
    "workflow": {
      "workflow_run_id": "e662dd70-d60c-49b4-81c2-d36e0f568763",
      "project_key": "order-service",
      "git_user_email": "zhangsan@company.com",
      "git_user_name": "张三",
      "sr": "SR-123",
      "ar": "AR-456",
      "aaw_version": "0.2.0",
      "status": "completed",
      "started_at": "2026-07-13T09:00:00Z",
      "completed_at": "2026-07-13T11:00:00Z",
      "last_activity_at": "2026-07-13T11:00:00Z"
    },
    "step_executions": [],
    "dev_runs": [
      {
        "dev_run_id": "4b2435de-c605-4df4-b275-0449082b05bb",
        "status": "completed",
        "attribution_status": "finalized_match",
        "code_statistics": {},
        "attribution": {}
      }
    ]
  }
}
```

`step_executions`按`step_id asc, attempt asc`排序，`dev_runs`按`started_at asc`排序。

### 7.8 归因结果列表

```http
GET /api/v1/statistics/code-attribution?project_key=order-service&matched_mr_iid=1876&result_status=finalized_match&page=1&page_size=50
Authorization: Bearer <admin-token>
```

额外过滤：`matched_mr_iid`、`result_status=pending|finalized_match|finalized_no_match|failed`。允许排序：`dev_effective_lines`、`attributed_lines_80`、`attributed_lines_90`、`attribution_rate_80`、`attribution_rate_90`、`matched_at`；默认`attributed_lines_80 desc`。

```json
{
  "request_id": "req-01J2EXAMPLE",
  "page": 1,
  "page_size": 50,
  "total": 1,
  "items": [
    {
      "workflow_run_id": "e662dd70-d60c-49b4-81c2-d36e0f568763",
      "dev_run_id": "4b2435de-c605-4df4-b275-0449082b05bb",
      "project_key": "order-service",
      "sr": "SR-123",
      "ar": "AR-456",
      "git_user_email": "zhangsan@company.com",
      "dev_effective_lines": 860,
      "attributed_lines_80": 620,
      "attributed_lines_90": 510,
      "exact_match_lines": 410,
      "fuzzy_match_lines": 180,
      "block_match_lines": 30,
      "attribution_rate_80": 0.7209,
      "attribution_rate_90": 0.5930,
      "confidence": 0.96,
      "quality_flags": [],
      "result_status": "finalized_match",
      "matched_mr_iid": "1876",
      "matched_mr_url": "https://git.company.com/platform/order-service/-/merge_requests/1876",
      "mr_diff_version": "3",
      "mr_source_branch": "feature/SR-123",
      "target_branch": "master",
      "merge_commit_sha": "3333333333333333333333333333333333333333",
      "mr_merged_at": "2026-07-16T08:20:00Z",
      "algorithm_version": "line-attribution-v1",
      "diff_rule_version": "effective-lines-v1",
      "matched_at": "2026-07-16T08:30:00Z"
    }
  ]
}
```

`pending`和`failed`是查询层归一化状态，MR和匹配字段可以为`null`。

### 7.9 用户汇总

```http
GET /api/v1/dashboard/users?from=2026-07-01&to=2026-07-31&page=1&page_size=50
Authorization: Bearer <admin-token>
```

按 Git 用户聚合，结构与 §7.4 项目汇总对称。允许排序：`workflow_runs`、`dev_runs`、`dev_effective_lines`、`attributed_lines_80`、`attributed_lines_90`、`attribution_rate_80`、`attribution_rate_90`。默认`attributed_lines_80 desc`。

```json
{
  "request_id": "req-01J2EXAMPLE",
  "page": 1,
  "page_size": 50,
  "total": 1,
  "items": [
    {
      "git_user_email": "zhangsan@company.com",
      "git_user_name": "张三",
      "workflow_runs": 42,
      "dev_runs": 58,
      "pending_attribution_dev_runs": 3,
      "dev_effective_lines": 9600,
      "attributed_lines_80": 5400,
      "attributed_lines_90": 4620,
      "attribution_rate_80": 0.5625,
      "attribution_rate_90": 0.4813
    }
  ]
}
```

## 8. 错误码

### 8.1 CLI写入错误

| HTTP | 错误码 | `retryable` | 含义 |
|---|---|---|---|
| 400 | `INVALID_REQUEST` | false | JSON、字段或schema非法 |
| 200单条结果 | `TIMESTAMP_CONFLICT` | false | 相同记录和时间对应不同内容 |
| 401 | `UNAUTHORIZED` | false | Token缺失或失效 |
| 200单条结果 | `PROJECT_DISABLED` | false | 项目未启用 |
| 200单条结果 | `PROJECT_NOT_FOUND` | false | remote无法唯一解析项目 |
| 200单条结果 | `INVALID_STATE_TRANSITION` | false | 状态转换非法 |
| 200单条结果 | `OBJECT_NOT_READY` | true | Patch未确认 |
| 413 | `PAYLOAD_TOO_LARGE` | false | 批次或对象超限 |
| 422 | `PATCH_INVALID` | false | Patch无法解压或解析 |
| 429 | `RATE_LIMITED` | true | 触发限流，响应包含`Retry-After` |
| 500 | `INTERNAL_ERROR` | true | 服务内部错误 |
| 503 | `SERVICE_UNAVAILABLE` | true | 服务暂不可用 |

批量接口中的业务错误放在单条`results[].error`中；请求级认证、解析和大小错误使用HTTP错误。

### 8.2 管理员查询错误

| HTTP | 错误码 | 含义 |
|---|---|---|
| 400 | `INVALID_FILTER` | 日期、过滤、分页或排序参数非法 |
| 401 | `UNAUTHORIZED` | 未登录或会话失效 |
| 403 | `ADMIN_REQUIRED` | 当前用户不是管理员 |
| 404 | `WORKFLOW_NOT_FOUND` | 工作流不存在 |
| 429 | `RATE_LIMITED` | 查询限流 |
| 500/503 | `INTERNAL_ERROR` / `SERVICE_UNAVAILABLE` | 服务故障 |

## 9. 版本与兼容规则

- URL主版本为`/api/v1`，请求体schema为`schema_version=1`。
- 增加可选响应字段、增加新查询接口属于向后兼容变更。
- 修改字段含义、删除字段、改变枚举语义或新增必填请求字段属于破坏性变更，必须升级API或schema版本。
- CLI遇到不支持的`schema_version`必须停止上传并提示升级。
- 服务端至少在一个统一发布周期内同时支持当前版本和上一版本。
- 接口实现应基于本文生成OpenAPI定义和契约测试；若生成物与本文冲突，以本文评审后的最新版本为准。

## 10. 联调验收

- 三类`record_type`的创建、增量更新、重复、乱序和离线终态用例通过。
- 相同客户端时间的不同内容能够返回`TIMESTAMP_CONFLICT`。
- Patch创建、实际PUT、确认和Dev完成依赖顺序通过。
- CLI Token无法访问任何管理员查询接口。
- 管理员接口的筛选、重复参数、分页、排序和空数据响应符合本文。
- 总览汇总可以与项目、工作流和归因列表交叉复核。
- 所有错误都包含`request_id`、稳定`code`和明确`retryable`。
