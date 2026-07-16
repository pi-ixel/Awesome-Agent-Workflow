# 日志规范

## 运行方式

服务使用 Python 标准 `logging` 框架，通过 `logging.config.dictConfig` 加载
`config/logging.yaml`，文件 Handler 由 `concurrent-log-handler` 提供。业务代码只负责选择
Logger、级别、事件名和结构化字段；Handler 负责文件写入、切割、保留和 gzip 压缩。

生产环境日志目录为 `/var/log/aaw-telemetry`：

| 文件 | 内容 | 默认保留 |
|---|---|---|
| `server.log` | HTTP 请求、服务运行和业务事件 | 30 份 |
| `error.log` | `ERROR` 及以上事件和异常堆栈 | 90 份 |
| `audit.log` | Step 消息和 Diff 上传审计事件 | 180 份 |

`server.log` 与 `audit.log` 每日零点或达到 100 MiB 时切割；`error.log` 达到 100 MiB
时切割。轮转文件使用 gzip 压缩。`concurrent-log-handler` 使用文件锁保护多进程写入和轮转。

可配置项：

```text
AAW_TELEMETRY_LOGGING_CONFIG_FILE=/opt/aaw-telemetry/config/logging.yaml
AAW_TELEMETRY_LOG_DIRECTORY=/var/log/aaw-telemetry
AAW_TELEMETRY_LOG_LEVEL=INFO
```

修改配置后必须重启服务。

## 格式

每行是一个 UTF-8 JSON 对象，固定包含：

| 字段 | 含义 |
|---|---|
| `timestamp` | RFC 3339 UTC 时间 |
| `level` | `INFO`、`WARNING` 或 `ERROR` |
| `logger` | 产生日志的 Logger |
| `event` | 稳定事件名 |
| `request_id` | 请求追踪 ID；非请求事件为 `-` |

事件按需增加 `method`、`path`、`status_code`、`duration_ms`、`message_id`、
`workflow_id`、`step_type`、`step_status`、`outcome`、`error_code`、`retryable` 和
`bytes_received`。动态值使用独立字段，不拼接到 `event`。

## Logger 与事件

普通模块使用 `logging.getLogger(__name__)`，写入 `server.log`；`ERROR` 事件同时进入
`error.log`。业务审计使用 `logging.getLogger("aaw_telemetry.audit")`，同时写入
`server.log` 和 `audit.log`。

必须记录：

| 事件 | 级别 | 目标日志 |
|---|---|---|
| `service.configured` | INFO | server |
| `http.request_completed` | INFO/WARNING/ERROR | server/error |
| `http.validation_failed` | WARNING | server |
| `http.api_error` | WARNING/ERROR | server/error |
| `http.request_rejected` | WARNING | server |
| `http.unhandled_error` | ERROR | server/error |
| `telemetry.message_processed` | INFO | server/audit |
| `telemetry.message_rejected` | WARNING | server/audit |
| `objects.upload_confirmed` | INFO | server/audit |
| `health.database_unavailable` | ERROR | server/error |

## 安全边界

禁止记录：

- Authorization、Cookie、密码、数据库连接串或环境变量值；
- 完整请求体和响应体；
- Git remote、仓库凭据、本地工作区路径或 Diff 内容；
- Diff SHA-256、`object_key` 和对象存储路径；
- `code_statistics.quality_flags` 原文。

`JsonFormatter` 会丢弃已知敏感字段。业务代码仍不得把敏感值拼接进事件名、异常消息或
其他普通字符串字段。

## 运维检查

```bash
tail -f /var/log/aaw-telemetry/server.log
tail -f /var/log/aaw-telemetry/error.log
tail -f /var/log/aaw-telemetry/audit.log
```

按请求追踪：

```bash
grep 'req-example' /var/log/aaw-telemetry/*.log
```

检查 JSON：

```bash
tail -n 20 /var/log/aaw-telemetry/server.log | jq .
```

任一 HTTP 响应都带 `X-Request-ID`，错误体中的 `request_id` 与其一致。异常堆栈只在
服务端错误中记录。测试必须同时验证目标字段存在、敏感字段不落盘以及轮转文件可以生成
gzip 压缩包。
