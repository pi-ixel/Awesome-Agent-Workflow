# Telemetry Dashboard 性能分析（Issue #119）

## 结论

Dashboard 高延迟的首要原因是查询层随数据量线性增长的 N+1 SQL，而不是 uvicorn 单 worker 将请求完全串行化。页面刷新会并发调用 8 个业务接口，其中多个接口重复加载相同的 Workflow、Message、DevRun 和 CodeAttribution；工作流列表还会在分页前展开全部记录。

连接池耗尽是查询风暴的结果和放大器。扩大连接池可以减少等待，但不会减少 SQL 总量。直接配置 `16 workers` 和每进程 `20 + 30` 个连接，理论上允许创建 800 个数据库连接，并使进程内后台任务运行 16 份，存在明显的数据库与任务并发风险。

本分支已经消除 Attribution N+1、把工作流分页下推到 SQL 并批量加载当前页关联数据，同时合并重复 projects 请求。合成数据中，1,000 个 Workflow 的完整刷新从 9,025 条 SQL 降至 37 条。连接池上限也已配置化，并补充候选索引与 nginx upstream keepalive；生产 MySQL 的耗时和执行计划仍需上线前验证。

## 证据边界

分析基于主线提交 `9c22654` 和 `tools/profile_dashboard_queries.py` 的合成数据剖析。脚本的 `legacy` 场景保留修复前查询路径，`current` 场景运行当前实现。SQL 条数反映 ORM 执行路径；SQLite 耗时和按每条 SQL 3 ms 计算的等待时间仅用于展示增长趋势，不代表生产 MySQL 实测值。

生产服务器未能通过已配置的运维连接或当前开发机网络访问，因此以下证据尚未取得：

- MySQL `EXPLAIN ANALYZE`、慢查询和 `performance_schema`；
- 实际表行数、数据库 `max_connections` 与活跃连接峰值；
- uvicorn 进程数、线程数和各进程连接池使用量；
- nginx upstream 连接复用率与服务端分段耗时。

## 页面请求与查询放大

页面启动先请求 `filter-options`，随后一次刷新并发请求：

```text
statistics:
  overview
  trends
  projects（当前分页）
  users
  projects（Top N，重复扫描）

additional:
  steps
  workflows
  components
```

各请求独立创建数据库 Session，无法共享前一个请求已经加载的数据。并发降低了浏览器等待的简单累加，但会把重复 SQL 同时压到连接池和数据库。

## 量化结果

合成数据为每个 Workflow 配置一条 Message、一条 DevRun 和一条 CodeAttribution。`page_sql` 是一次页面刷新涉及的全部 SQL 数量；`workflow_list_sql` 是只返回第一页 50 条时工作流列表接口的 SQL 数量。

| Workflow 数 | overview SQL | components SQL | workflow_list SQL | page SQL 总量 | workflow_list 按 3 ms/SQL 估算 |
|---:|---:|---:|---:|---:|---:|
| 10 | 14 | 14 | 31 | 115 | 93 ms |
| 100 | 104 | 104 | 301 | 925 | 903 ms |
| 500 | 504 | 504 | 1,501 | 4,525 | 4,503 ms |
| 1,000 | 1,004 | 1,004 | 3,001 | 9,025 | 9,003 ms |

这组结果说明：

- `overview`、`trends`、`projects`、`users` 和 `components` 基本都是 `N + 常数` 条 SQL；
- `workflows` 基本是 `3N + 1` 条 SQL，且不受 `page_size=50` 限制；
- 生产环境 3～3.7 秒的接口耗时可以由数百次串行数据库往返解释，不需要假设单 worker 完全串行；
- 数据继续增长时，单纯增加 worker 或连接池只会允许更多查询风暴并发进入 MySQL。

在 500 个 Workflow 下，剖析脚本对两个局部优化做了隔离实验，并复测最终实现：

| 场景 | overview SQL | workflow_list SQL | page SQL 总量 | 相对基线下降 |
|---|---:|---:|---:|---:|
| 当前基线 | 504 | 1,501 | 4,525 | — |
| 批量预加载 Attribution | 5 | 1,501 | 1,531 | 66.2% |
| 批量预加载 + workflows 先分页 | 5 | 151 | 181 | 96.0% |
| 当前实现（批量当前页、合并 projects 请求） | 5 | 5 | 32 | 99.3% |

当前实现的完整刷新 SQL 数量基本不随 Workflow 总量增长；到 1,000 条时因 ORM 预加载分批，从 32 条轻微增加为 37 条：

| Workflow 数 | 修复前 SQL | 当前 SQL | 下降 |
|---:|---:|---:|---:|
| 10 | 115 | 32 | 72.2% |
| 100 | 925 | 32 | 96.5% |
| 500 | 4,525 | 32 | 99.3% |
| 1,000 | 9,025 | 37 | 99.6% |

复现命令：

```powershell
cd telemetry-server
.venv\Scripts\python.exe tools/profile_dashboard_queries.py --workflows 500 --scenario legacy
.venv\Scripts\python.exe tools/profile_dashboard_queries.py --workflows 500 --scenario current
.venv\Scripts\python.exe tools/profile_dashboard_queries.py --workflows 500 --scenario eager-attribution
.venv\Scripts\python.exe tools/profile_dashboard_queries.py --workflows 500 --scenario eager-and-page-first
```

## 问题与影响

### P0（已修复）：CodeAttribution 懒加载形成 N+1 SQL

`_devs()` 只加载 `DevRun`。后续聚合逐条访问 `dev.attribution` 时，每条 DevRun 都会额外执行一次 CodeAttribution 查询。该模式存在于 overview、trends、projects、users、components 和 code-attribution 等路径。

影响：

- SQL 数量随 DevRun 数量线性增长；
- 单个请求长时间占用数据库连接；
- 页面并发请求重复触发相同 N+1 查询；
- 扩大连接池后，数据库 CPU、I/O 和锁竞争可能进一步升高。

### P0（已修复）：工作流列表分页发生在全量展开之后

`workflows()` 先加载并排序全部 Workflow，再对每一条调用 `_workflow_item()`；每条 Workflow 都会单独查询 Message 和 DevRun，并触发归因懒加载。全部 item 构造完成后才执行 `_paginate()`。

影响：

- 请求第一页 50 条仍处理整个时间范围内的全部 Workflow；
- SQL 数量约为 `3N + 1`；
- 时间范围越大，接口越慢，分页不能控制数据库工作量；
- 该接口通常成为页面刷新中完成最晚的请求。

### P1（部分修复）：前端并发扇出重复扫描相同数据

一次刷新包含 8 个并发业务请求。overview、trends、projects、users 和 components 都从 Workflow → Message → DevRun 重新加载数据；projects 为当前页与 Top N 再重复请求一次。

影响：

- 500 个 Workflow 的一次刷新约产生 4,525 条 SQL；
- 单用户刷新即可占用约 8 个请求级数据库连接；
- 多用户或自动刷新容易触发连接池等待；
- 生产扩容会提高数据库并发压力，但不会降低每次刷新成本。

### P1：直接使用 16 workers 会放大数据库和后台任务风险

SQLAlchemy Engine 在每个 worker 进程内独立创建。若每进程配置 `pool_size=20`、`max_overflow=30`，16 个 worker 的理论连接上限为：

```text
16 × (20 + 30) = 800
```

应用 lifespan 中的归因调度、图片清理等后台任务也会在每个 worker 启动一份。worker 数增加前需要确认这些任务具备跨进程选主或严格幂等能力。

影响：

- 可能超过 MySQL `max_connections`；
- 大量并发 SQL 会把应用排队转移为数据库排队；
- 后台扫描和文件操作重复执行；
- 内存、线程和连接数量按 worker 成倍增长。

### P2（已增加候选索引，待生产验证）：默认查询缺少贴合访问路径的索引

默认时间筛选使用 `workflow_kind + started_at`，但现有复合索引为 `workflow_kind + project_key + started_at`；未指定项目时，不能完整贴合默认访问路径。components 的历史使用判断执行 `workflow_kind` 下的 `DISTINCT repository`，当前没有 `workflow_kind + repository` 索引。

影响：

- Workflow 和 Message 表增长后扫描成本上升；
- components 的全历史查询不受日期范围限制；
- N+1 修复后，索引可能成为下一层主要瓶颈。

本分支增加 `workflow_kind + started_at` 与 `workflow_kind + repository` 索引；保留与否仍应由生产 MySQL 执行计划和写入成本验证。

### P3（已修复）：nginx upstream 未复用连接

当前 nginx 使用 HTTP/1.1 反向代理，但没有 upstream keepalive 配置。增加 keepalive 可以减少本机 TCP 建连和端口开销。

影响通常在毫秒级，无法单独解释 3 秒以上的业务接口耗时。它适合作为低风险辅助优化，不应代替查询优化。

## 对 Issue #119 现有判断的修正

- Dashboard 路由使用同步 `def`，FastAPI 会在线程池执行；单 worker 不等于 8 个请求必然串行。
- 8 个请求几乎同时开始、同时结束，更符合并发请求共同争抢数据库资源，而不是严格串行。严格串行通常表现为阶梯式完成。
- `_devs([message.id])` 使用 `DevRun.id` 符合当前模型：DevRun 主键就是对应上报消息的 `message_id`，不是字段选择错误。
- 连接池错误是真实故障信号，但将池从 15 个连接扩大到每进程 50 个只缓解等待，不解决每次页面刷新产生数千条 SQL 的根因。

## 建议实施顺序

1. 在生产 MySQL 上采集修复前后 P50/P95、执行计划、慢查询和连接峰值，验证新索引。
2. 将 projects、users、trends、steps 等聚合逐步改为数据库端 `GROUP BY`，降低全量 ORM 对象加载的内存与 CPU。
3. 评估单个聚合端点或服务端共享查询，进一步降低页面剩余的接口扇出。
4. 增加连接池 checkout 时间、SQL 数量、接口分段耗时和慢查询指标。
5. 根据数据库连接预算设置 worker 与连接池，满足：

   ```text
   workers × (pool_size + max_overflow) + 后台/运维保留连接 < MySQL max_connections
   ```

6. 确认后台任务的跨进程执行模型后，再决定是否增加 worker。

## 验收指标

- overview、trends、projects、users、components 的 SQL 数量不随 DevRun 数量线性增长；
- workflows 第一页的 SQL 数量与总 Workflow 数无关，只与 `page_size` 有界相关；
- 500 个 Workflow 的完整页面刷新 SQL 总量从 4,525 降至百条以内，目标进一步压缩到 50 条以内；
- 8 并发页面请求下无连接池等待，数据库活跃连接不超过预算；
- 在生产等价数据集上记录 P50、P95、最大连接数和数据库 CPU，避免只比较一次总耗时。
