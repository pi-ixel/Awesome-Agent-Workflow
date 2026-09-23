"""在联调环境生长一批"有关联关系"的演示数据。

设计原则：数据不是凭空拼的，而是按真实 AAW 工作流的方式长出来——
一条 SR 从 sr-init 起，经设计、拆分、模块设计到 task-dev，每条 AR 挂真实
数目的 task-dev 产出；人员、仓库、组件、AI Master 归属、时间线彼此对应。

覆盖 11 条内置检测规则所需的形态：
  telemetry_gap        依赖既有仓库（trustruntime / globaltrustauthority-rbs）自然命中
  unassigned_data      未登记仓库 payment-gateway 近 12h 上报 4 次
  adoption_drop        telemetry-server 近期 3 条低采纳、基线 3 条高采纳
  workflow_stalled     awesome-agent-workflow 上一条 30h 无活动的 in_progress 工作流
  workflow_failed      awesome-agent-workflow 上一条步骤 failed
  patch_missing        telemetry-smoke 上一条 done 但未传 diff 的产出
  attribution_stuck    telemetry-server 一条 retry_pending 超 1h
  attribution_failed   telemetry-server 一条 failed 且重试 4 次
  low_adoption         telemetry-server 近期 3 条产出采纳率 30%
  old_version_active   苏婉 7 天内仍用 1.1.1（落后 2 个发布位）
  non_release_version  王倩 24h 内上报非语义化版本 dev-local

归因引擎是仓库内的 MockAttributionEngine，任何产出都返回 80% 采纳率，
因此"低采纳 / 重试中 / 失败"三种状态无法由 mock 自然产生；脚本在真实
产出、真实归因行上做定点修正（不是伪造孤立记录），并打印明细。

用法（在服务器上，用应用 venv 跑）：
  AAW_TELEMETRY_DATABASE_URL=... python seed_ops_demo.py http://127.0.0.1:18080
"""

from __future__ import annotations

import hashlib
import os
import sys
import uuid
from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from aaw_telemetry.models import CodeAttribution, DevRun

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:18080"
ADMIN_PASSWORD = sys.argv[2] if len(sys.argv) > 2 else "123456"
client = httpx.Client(base_url=BASE, timeout=60)


def U(tag: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "aaw-ops-demo/" + tag))


def ms(days_ago: float, hour_offset: float = 0.0) -> int:
    when = datetime.now(UTC) - timedelta(days=days_ago) + timedelta(hours=hour_offset)
    return int(when.timestamp() * 1000)


def make_diff(spec: dict[str, int]) -> bytes:
    """spec: {路径: 新增行数}，生成多文件 unified diff。"""
    parts: list[str] = []
    for path, added in spec.items():
        parts.append(f"diff --git a/{path} b/{path}")
        parts.append(f"--- a/{path}")
        parts.append(f"+++ b/{path}")
        parts.append(f"@@ -0,0 +1,{added} @@")
        parts += [f"+{path} 第 {i:02d} 行新增实现" for i in range(1, added + 1)]
    return ("\n".join(parts) + "\n").encode("utf-8")


class Workflow:
    """按真实链路上报一个工作流的全部步骤消息。"""

    def __init__(
        self,
        tag: str,
        *,
        user_email: str,
        user_name: str,
        version: str,
        sr: str,
        repository: str,
        entry: str = "sr",
        start_days_ago: float,
        step_hours: float = 2.0,
        complete: bool = True,
    ):
        self.tag = tag
        self.user_email = user_email
        self.user_name = user_name
        self.version = version
        self.sr = sr
        self.repository = repository
        self.entry = entry
        self.workflow_id = U(f"{tag}-wf")
        self.t0 = start_days_ago
        self.started_ms = ms(start_days_ago)
        self.step_hours = step_hours
        self.complete = complete
        self.step_seq = 0
        self.dev_targets: list[str] = []
        self._last_updated_ms = self.started_ms

    def _clock(self, *, final: bool = False) -> tuple[int, int, int]:
        offset = self.step_seq * self.step_hours
        # 起始偏移必须容得下整条链路：否则会生长出未来时间的上报，
        # 看板上就是"未来某刻"的假数据。
        if offset >= self.t0 * 24:
            raise ValueError(
                f"{self.tag}: 链路长度 {offset:.1f}h 超过起始偏移 {self.t0 * 24:.1f}h，"
                "会生成未来时间戳；请调小 step_hours 或调大 start_days_ago"
            )
        started = ms(self.t0, hour_offset=offset)
        completed = ms(self.t0, hour_offset=offset + self.step_hours * 0.7)
        updated = completed
        self._last_updated_ms = updated
        self.step_seq += 1
        return started, completed, updated

    def _sync(
        self,
        step_type: str,
        *,
        ar: str | None,
        status: str = "done",
        diff: bytes | None = None,
        step_name: str | None = None,
        upload: bool | None = None,
    ) -> str:
        started, completed, updated = self._clock()
        file_meta = None
        if diff is not None:
            file_meta = {
                "file_name": f"{self.tag}-{step_type}-{self.step_seq}.diff",
                "sha256": hashlib.sha256(diff).hexdigest(),
            }
        payload = {
            "message_id": U(f"{self.tag}-{step_type}-{self.step_seq}"),
            "workflow_id": self.workflow_id,
            "entry": None,
            "aaw_version": self.version,
            "user_email": self.user_email,
            "user_name": self.user_name,
            "repository": self.repository,
            "sr": self.sr,
            "started_at": self.started_ms,
            "completed_at": updated if self.complete else None,
            "updated_at": updated,
            "data": {
                "ar": ar,
                "step_type": step_type,
                "status": status,
                "started_at": started,
                "completed_at": completed if status == "done" else None,
                "file": file_meta,
            },
        }
        if step_name is not None:
            payload["data"].update(
                {
                    "step_id": self.step_seq,
                    "step_name": step_name,
                    "attempt": 1,
                    "execution_type": "skill",
                    "skill_names": ["aaw-workflow"],
                    "task_id": f"{self.tag}-T{self.step_seq:02d}",
                    "development": None,
                }
            )
        response = client.post("/api/v1/telemetry/sync", json=payload)
        response.raise_for_status()
        if diff is not None and (upload if upload is not None else True):
            put = client.put(
                f"/api/v1/objects/step-diffs/{payload['message_id']}",
                content=diff,
                headers={"Content-Type": "application/octet-stream"},
            )
            put.raise_for_status()
            self.dev_targets.append(payload["message_id"])
        return payload["message_id"]

    def run_sr_full(self, ars: list[tuple[str, dict[str, int]]]) -> None:
        self._sync("sr-init", ar=None, step_name="SR 需求澄清")
        self._sync("sr-design", ar=None, step_name="SR 方案设计")
        self._sync("sr-design-gate", ar=None, step_name="SR 设计门禁")
        first_ar = ars[0][0]
        self._sync("ar-split", ar=first_ar, step_name="AR 拆分")
        for ar, spec in ars:
            self._sync("ar-clarify", ar=ar, step_name="AR 澄清")
            self._sync("module-boundary-design", ar=ar, step_name="模块边界设计")
            self._sync("module-detail-design-split", ar=ar, step_name="模块详细设计拆分")
            self._sync("module-test-design", ar=ar, step_name="模块测试设计")
            self._sync("task-split", ar=ar, step_name="任务拆分")
            self._sync("task-dev", ar=ar, step_name="任务开发", diff=make_diff(spec))


def login() -> dict[str, str]:
    body = client.post(
        "/api/v1/anomalies/admin/login", json={"password": ADMIN_PASSWORD}
    )
    body.raise_for_status()
    return {"X-CSRF-Token": body.json()["csrf_token"]}


print(f"→ 生长演示数据到 {BASE}")
admin = login()

# ═════════════════════════ 1. 注册表：补 telemetry-server ═════════════════════
print("→ 注册 telemetry-server 到「遥测平台」并把归属给顾言")
masters = {row["name"]: row["id"] for row in client.get("/api/v1/ai-masters").json()["items"]}
try:
    client.post(
        "/api/v1/admin/registry/components/telemetry-platform/repos",
        headers=admin,
        json={
            "repo_key": "telemetry-server",
            "canonical_url": "https://example.invalid/aaw/telemetry-server.git",
            "target_branch": "main",
            "enabled": True,
        },
    ).raise_for_status()
    print("   已新增 telemetry-server 仓库")
except httpx.HTTPStatusError as exc:
    print(f"   telemetry-server 仓库已存在或新增失败：{exc.response.status_code}")
if "顾言" in masters:
    client.put(
        "/api/v1/ai-masters/repo-assignments/telemetry-server",
        headers=admin,
        json={"ai_master_id": masters["顾言"]},
    ).raise_for_status()
    print(f"   telemetry-server → 顾言({masters['顾言'][:8]})")

# ═════════════════════ 2. 正常链路：周宁的仓库 ═════════════════════
print("→ 周宁(awesome-agent-workflow)：健康 SR 链路")
wf_chenhao = Workflow(
    "chenhao-main", user_email="chenhao@example.com", user_name="陈昊",
    version="2.3.2", sr="SR-9001", repository="awesome-agent-workflow",
    start_days_ago=2, step_hours=1.0,
)
wf_chenhao.run_sr_full([
    ("AR-9001", {"src/core/scheduler.py": 52, "test/core/test_scheduler.py": 28}),
    ("AR-9002", {"src/api/routes.py": 34, "config/routes.yaml": 10}),
])

# ═════════════════════ 3. 林澈的仓库 ═════════════════════
print("→ 林澈(telemetry-smoke)：旧版本用户的健康链路 + 漏传 diff 的产出")
wf_suwan = Workflow(
    "suwan-main", user_email="suwan@example.com", user_name="苏婉",
    version="1.1.1", sr="SR-9002", repository="telemetry-smoke",
    start_days_ago=3, step_hours=1.2,
)
wf_suwan.run_sr_full([
    ("AR-9003", {"smoke/case_order.py": 30, "smoke/case_pay.py": 22}),
])
# 漏传 diff：done 带文件元数据但不上传 → patch_missing
# 用另一个用户上报，避免它成为苏婉的最新版本、把"旧版本持续活跃"顶掉。
wf_smoke_missing = Workflow(
    "smoke-missing", user_email="zhoulan@example.com", user_name="周岚",
    version="2.3.2", sr="SR-9003", repository="telemetry-smoke",
    start_days_ago=2, step_hours=1.0,
)
wf_smoke_missing.run_sr_full([
    ("AR-9004", {"smoke/case_refund.py": 26}),
])
last = wf_smoke_missing._sync(
    "task-dev", ar="AR-9004", step_name="任务开发（补丁待传）",
    diff=make_diff({"smoke/case_refund_extra.py": 18}), upload=False,
)
print(f"   漏传产出 message_id={last[:8]}")

# ═════════════════════ 4. 顾言(telemetry-server)：采纳率下降 ═════════════════════
print("→ 顾言(telemetry-server)：基线 3 条高采纳 + 近期 3 条低采纳")
baseline_targets: list[str] = []
for idx, (sr, days) in enumerate([("SR-9004", 30), ("SR-9005", 25), ("SR-9006", 20)], start=1):
    wf = Workflow(
        f"ops-baseline-{idx}", user_email="lihang@example.com", user_name="李航",
        version="2.3.2", sr=sr, repository="telemetry-server",
        start_days_ago=days, step_hours=6.0,
    )
    wf.run_sr_full([(f"AR-900{4 + idx}", {f"src/handlers/b{idx}.py": 110})])
    baseline_targets += wf.dev_targets

recent_targets: list[str] = []
# step_hours 要保证整条链路不回跑到未来：steps(10) × step_hours ≤ 起始偏移。
for idx, (sr, days, hours) in enumerate(
    [("SR-9007", 6, 4.0), ("SR-9008", 3, 4.0), ("SR-9009", 1, 2.0)], start=1
):
    wf = Workflow(
        f"ops-recent-{idx}", user_email="lihang@example.com", user_name="李航",
        version="2.3.2", sr=sr, repository="telemetry-server",
        start_days_ago=days, step_hours=hours,
    )
    wf.run_sr_full([(f"AR-900{7 + idx}", {f"src/handlers/r{idx}.py": 100})])
    recent_targets += wf.dev_targets

# 归因重试中 / 归因失败：各起一条独立产出，避免吃掉上面三条低采纳产出
stuck_targets: list[str] = []
for idx, (sr, days) in enumerate([("SR-9013", 2.5), ("SR-9014", 2.0)], start=1):
    wf = Workflow(
        f"ops-stuckfail-{idx}", user_email="lihang@example.com", user_name="李航",
        version="2.3.2", sr=sr, repository="telemetry-server",
        start_days_ago=days, step_hours=4.0,
    )
    wf.run_sr_full([(f"AR-901{2 + idx}", {f"src/handlers/s{idx}.py": 90})])
    stuck_targets += wf.dev_targets

# ═════════════════════ 5. 未登记仓库：无法归属 ═════════════════════
print("→ 未登记仓库 payment-gateway：近 12h 上报 4 次")
for idx in range(4):
    wf = Workflow(
        f"pgw-{idx}", user_email="hejun@example.com", user_name="何俊",
        version="2.3.2", sr=f"SR-91{idx:02d}", repository="payment-gateway",
        entry="dev", start_days_ago=0.4, step_hours=0.5,
    )
    wf._sync("dev-init", ar=None, step_name="开发启动")
    wf._sync("dev-design", ar=None, step_name="轻量设计")
    wf._sync("dev-task-dev", ar=None, step_name="任务开发", diff=make_diff({"src/pay.py": 20}))

# ═════════════════════ 6. 非发布版本用户 ═════════════════════
print("→ 王倩：24h 内上报非语义化版本 dev-local")
wf_devlocal = Workflow(
    "wangqian-devlocal", user_email="wangqian@example.com", user_name="王倩",
    version="dev-local", sr="SR-9110", repository="awesome-agent-workflow",
    entry="dev", start_days_ago=0.3, step_hours=0.5,
)
wf_devlocal.run_sr_full([("AR-9110", {"src/tmp/experiment.py": 24})])

# ═════════════════════ 7. 停滞工作流（30h 无活动）═════════════════════
print("→ 停滞工作流：30h 无活动的 in_progress 工作流")
wf_stalled = Workflow(
    "chenhao-stalled", user_email="chenhao@example.com", user_name="陈昊",
    version="2.3.2", sr="SR-9111", repository="awesome-agent-workflow",
    start_days_ago=1.5, step_hours=2.0, complete=False,
)
wf_stalled._sync("sr-init", ar=None, step_name="SR 需求澄清")
wf_stalled._sync("sr-design", ar=None, step_name="SR 方案设计")
wf_stalled._sync("ar-split", ar="AR-9111", step_name="AR 拆分")

# ═════════════════════ 8. 步骤失败（>30min）═════════════════════
print("→ 步骤失败：2h 前进入 failed 的步骤")
wf_failed = Workflow(
    "chenhao-failed", user_email="chenhao@example.com", user_name="陈昊",
    version="2.3.2", sr="SR-9112", repository="awesome-agent-workflow",
    start_days_ago=0.2, step_hours=1.0, complete=False,
)
wf_failed._sync("sr-init", ar=None, step_name="SR 需求澄清")
wf_failed._sync("sr-design", ar=None, step_name="SR 方案设计", status="failed")

# ═════════════════════ 9. 归因状态定点修正 ═════════════════════
print("→ 定点修正归因状态（mock 引擎恒返回 80%，这三态无法自然产生）")
engine = create_engine(os.environ["AAW_TELEMETRY_DATABASE_URL"])
now = datetime.now(UTC).replace(tzinfo=None)
with Session(engine) as session:
    # 9.1 低采纳：近期 3 条产出把 attributed_lines_80 压到 30%
    touched = 0
    for target in recent_targets:
        dev = session.get(DevRun, uuid.UUID(target))
        attr = session.get(CodeAttribution, uuid.UUID(target))
        if dev is None or attr is None or not dev.code_statistics:
            continue
        total = int(dev.code_statistics.get("total_effective_lines") or 0)
        attr.attributed_lines_80 = max(1, int(total * 0.3))
        attr.attributed_lines_60 = max(attr.attributed_lines_80, int(total * 0.4))
        attr.attributed_lines_90 = max(1, int(total * 0.2))
        attr.confidence = 0.41
        attr.result_status = "finalized_match"
        attr.attribution_status = "finalized_match"
        attr.server_updated_at = now
        touched += 1
    print(f"   低采纳修正 {touched} 条")

    # 9.2 重试中（>1h）
    stuck_target = stuck_targets[0]
    stuck = session.get(CodeAttribution, uuid.UUID(stuck_target))
    if stuck is not None:
        stuck.attribution_status = "retry_pending"
        stuck.retry_count = 2
        stuck.result_status = "pending"
        stuck.server_updated_at = now - timedelta(hours=3)
        stuck.next_retry_at = now - timedelta(hours=1)
        print(f"   retry_pending 修正 {stuck_target[:8]}")

    # 9.3 失败（重试 4 次）
    fail_target = stuck_targets[1] if len(stuck_targets) > 1 else None
    if fail_target:
        failed = session.get(CodeAttribution, uuid.UUID(fail_target))
        if failed is not None:
            failed.attribution_status = "failed"
            failed.retry_count = 4
            failed.result_status = "failed"
            failed.server_updated_at = now
            print(f"   failed 修正 {fail_target[:8]}")
    session.commit()

# ═════════════════════ 10. 启用内置规则 ═════════════════════
print("→ 启用 11 条内置检测规则")
rules = client.get("/api/v1/anomalies/rules", headers=admin).json()
if isinstance(rules, dict):
    rules = rules.get("items", [])
enabled = 0
for rule in rules:
    if rule["status"] != "enabled":
        client.post(
            f"/api/v1/anomalies/rules/{rule['id']}/status",
            headers=admin,
            json={"status": "enabled", "reason": "联调环境预置演示数据，开启内置检测"},
        ).raise_for_status()
        enabled += 1
print(f"   启用 {enabled} 条（原有 {len(rules)} 条）")

# ═════════════════════ 11. 触发评估 ═════════════════════
print("→ 触发一轮规则评估")
result = client.post("/api/v1/anomalies/rules/evaluate", headers=admin).json()
for item in result["items"]:
    print(f"   {item['rule_id'][:8]} matches={item['matches']} {item['samples'][:1]}")
summary = client.get("/api/v1/anomalies/summary", headers=admin, params={"admin_view": True}).json()
print(f"\n===== 演示数据就绪：开放异常 {summary['open']} 条 =====")
print(f"运营后台  {BASE}/admin")
