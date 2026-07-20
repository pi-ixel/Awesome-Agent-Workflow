# 服务端启动指南

本文描述如何在本地或服务器上启动 AAW Telemetry Server（`telemetry-server/`）及配套的
Portal 看板前端（`telemetry-front/portal/`）。设计范围见 `docs/telemetry-server-design.md`。

## 一、环境要求

| 组件 | 要求 |
| --- | --- |
| Python | 3.11+（生产镜像使用 3.12） |
| 数据库 | MySQL 5.7+，推荐 MySQL 8.0 |
| 前端 | 纯静态页面，无构建、无 Node 运行时；生产用 Nginx 托管 |

## 二、启动服务端（本地开发）

### 1. 创建虚拟环境并安装依赖

```powershell
cd telemetry-server
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -e ".[test]"
```

> 仓库内已有 `.venv` 时可跳过创建，直接激活。

### 2. 启动 MySQL

有 Docker 时直接使用仓库自带的本地 compose（账号 `aaw/aaw`，root 密码 `root`，端口 3306）：

```powershell
docker compose up -d mysql
```

没有 Docker 时自行准备 MySQL 实例，预先创建数据库 `aaw_telemetry` 和账号，
字符集使用 `utf8mb4`。

### 3. 准备配置

```powershell
Copy-Item .env.example .env
```

数据库连接写在 `config/database.yaml`（应用和 Alembic 共用），按实际环境修改：

```yaml
host: 127.0.0.1
port: 3306
database: aaw_telemetry
username: aaw
password: aaw
charset: utf8mb4
```

所有配置项均可用 `AAW_TELEMETRY_` 前缀的环境变量覆盖，常用项：

| 环境变量 | 说明 |
| --- | --- |
| `AAW_TELEMETRY_DATABASE_CONFIG_FILE` | database.yaml 的路径（默认 `config/database.yaml`） |
| `AAW_TELEMETRY_DATABASE_URL` | 完整连接串，优先于 YAML 文件 |
| `AAW_TELEMETRY_PROJECTS_FILE` | 项目配置（默认 `config/projects.yaml`），修改后需重启 |
| `AAW_TELEMETRY_RELEASE_DIR` | 发布包目录，启用客户端自动更新接口时必须设置（见《发布指南》） |
| `AAW_TELEMETRY_LOG_DIRECTORY` / `AAW_TELEMETRY_LOG_LEVEL` | 日志目录与级别 |

> `.env` 由启动器加载，服务本身不隐式读取项目外的配置。

### 4. 初始化 / 升级数据库表结构

```powershell
alembic upgrade head
```

服务启动时不会自动建表，表结构只能通过 Alembic 迁移创建或升级。

### 5. 启动服务

```powershell
uvicorn aaw_telemetry.main:app --reload --no-access-log
```

默认监听 `127.0.0.1:8000`，换端口加 `--host 0.0.0.0 --port 18081`。

### 6. 验证

| 地址 | 用途 |
| --- | --- |
| `http://127.0.0.1:8000/docs` | 接口文档（Swagger UI） |
| `/health/live`、`/health/ready` | 存活 / 就绪检查 |
| `/self-test` | 联调自验控制台（Step 上报、Diff 上传、看板查询） |
| `/api/v1/client/release` | 最新发布包查询（未设置 `AAW_TELEMETRY_RELEASE_DIR` 时返回 `latest_version: null`） |

运行测试：

```powershell
pytest
ruff check .
```

## 三、启动 Portal 前端

前端文件位于 `telemetry-front/portal/`：`bright.html`、`bright.css`、`bright.js`、
`config.js`、`mock-data.js`。运行模式由 `config.js` 控制：

```js
window.APP_CONFIG = {
  apiBase: "/api/v1",   // 后端 API 前缀
  useMock: false,       // true = 使用内建 mock 数据，不发真实请求
  timeout: 15000,
  credentials: "same-origin",
};
```

### 方式 A：本地预览（mock 数据，零依赖）

`config.js` 设 `useMock: true`，然后任意静态服务器打开页面：

```powershell
cd telemetry-front\portal
python -m http.server 8080
# 浏览器打开 http://127.0.0.1:8080/bright.html
```

### 方式 B：本地联调真实后端

`config.js` 改两处后按方式 A 启动静态服务器：

```js
useMock: false,
apiBase: "http://127.0.0.1:8000/api/v1",   // 后端实际地址（跨域直连，仅限本地调试）
```

### 方式 C：生产部署（Nginx 同源反代）

详细步骤见 `telemetry-front/portal/DEPLOY.md`，要点：

1. 把前端 5 个文件放到同一目录，由 Nginx `root` 托管；
2. 用 `nginx.portal.conf` 作为 server 块模板，改 `listen` / `root` / `proxy_pass` 三处；
3. `/api/v1/` 反向代理到后端，前后端同源，`config.js` 保持 `apiBase: "/api/v1"`、
   `useMock: false` 不动。

> 页面中 ECharts 走公网 CDN；内网隔离环境需下载 `echarts.min.js` 到本地并修改
> `bright.html` 的 `<script src>`。

## 四、生产部署（Docker Compose）

服务器上使用 `telemetry-server/compose.remote.yaml`：

```bash
cd telemetry-server
cp .env.example .env          # 补充 MYSQL_PASSWORD / MYSQL_ROOT_PASSWORD 等
docker compose -f compose.remote.yaml up -d
```

生产注意事项（详见 `telemetry-server/README.md`）：

- 在 TLS 终止代理后运行，只信任受控代理传入的头部；
- 当前服务无鉴权，不应直接承载生产或敏感数据；
- 生产数据库同样只能通过 Alembic 迁移升级；
- 日志写入 `/var/log/aaw-telemetry/`，JSON 行格式，按 `request_id` / `event` /
  `message_id` / `workflow_id` 检索。
