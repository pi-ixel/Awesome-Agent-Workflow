# AAW Attribution Service

归因服务是独立于 Telemetry 后端部署的无状态服务。当前实现使用 Mock 引擎，用于固定服务边界和验证部署链路，不产生真实归因结论。

## 服务契约

- `POST /api/v1/attributions`：接收版本化归因请求并返回归因结果。
- `GET /health/live`：存活检查。
- `GET /health/ready`：就绪检查，并返回当前引擎名称。
- `schema_version` 当前为 `1.0`。
- `request_id` 使用后端的 `dev_run_id`，同时作为幂等键。

请求包含项目、开发上下文、遥测元数据、Diff SHA-256、Base64 编码的 Diff 内容和代码统计。归因服务不访问后端数据库，也不持有后端 ORM 模型。

## 本地启动

```powershell
cd attribution-service
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -e ../contracts -e ".[test]"
uvicorn aaw_attribution.main:app --reload --port 8010
```

## 独立部署与升级

```bash
cd attribution-service
cp .env.example .env
docker compose up -d --build
```

只升级归因服务：

```bash
docker compose build attribution
docker compose up -d --no-deps attribution
```

默认仅绑定 `127.0.0.1:18081`。跨主机部署时应通过受控网络或 TLS 代理暴露，并同时在两端配置相同的 Bearer Token。

## 替换真实引擎

内网版本实现 `aaw_attribution.engine.AttributionEngine`，并在 `create_app(engine=...)` 中注入。替换时必须保持 HTTP 路径及 `schema_version=1.0` 的请求、响应字段兼容。真实引擎不得直接依赖 Telemetry 后端的数据库或 Python 包。
