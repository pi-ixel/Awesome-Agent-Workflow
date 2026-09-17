"""本地演示数据预置脚本。

前置条件：
  1. mock 归因引擎已启动（tools/mock_engine.py，端口 8010）
  2. 遥测服务已按 tools/run_local_demo.ps1 启动（端口 8000，SQLite 演示库）

脚本通过真实 API 预置一组覆盖全部演示点的数据：
  - 版本运营：多用户多版本（旧版本存量 / 非发布账号 / 升级轨迹 / 窗口外沉默用户）
  - 归因状态：已匹配、未匹配、退避重试（AR 含 FAIL）、超窗失败（91 天前完成）
  - 管理面：未入队（等待补丁）、无关化（含恢复口径演示）、积压体检、失败分组
  - 双口径：一条带行数的未匹配记录被无关化后，合入意图口径与全量口径拉开差异

用法：python tools/seed_demo_data.py
"""

from __future__ import annotations

import hashlib
import sys
import time
import uuid
from datetime import UTC, datetime, timedelta

import httpx

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"
client = httpx.Client(base_url=BASE, timeout=30)


def U(tag: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "aaw-demo/" + tag))


def ms(days_ago: float) -> int:
    when = datetime.now(UTC) - timedelta(days=days_ago)
    return int(when.timestamp() * 1000)


def make_diff(path: str, added: int) -> bytes:
    lines = [
        f"diff --git a/{path} b/{path}",
        f"--- a/{path}",
        f"+++ b/{path}",
        f"@@ -1,2 +1,{added + 2} @@",
        " context line",
    ]
    lines += [f"+added line {i:03d} in {path}" for i in range(1, added + 1)]
    return ("\n".join(lines) + "\n").encode("utf-8")


def sync(
    tag: str,
    *,
    user_email: str,
    user_name: str,
    version: str,
    when_days_ago: float,
    step_type: str = "task-dev",
    sr: str,
    ar: str | None = None,
    repository: str = "awesome-agent-workflow",
    with_file: bool = False,
    upload: bool | None = None,
) -> str:
    started = ms(when_days_ago)
    updated = ms(when_days_ago - 0.02)  # updated 略晚于 started
    diff = make_diff(f"src/{tag}.py", {"small": 12, "mid": 40, "big": 88}.get(tag[-4:], 24))
    if upload is None:
        upload = with_file
    payload = {
        "message_id": U(f"{tag}-msg"),
        "workflow_id": U(f"{tag}-wf"),
        "entry": "sr",
        "aaw_version": version,
        "user_email": user_email,
        "user_name": user_name,
        "repository": repository,
        "sr": sr,
        "started_at": started,
        "completed_at": updated,
        "updated_at": updated,
        "data": {
            "ar": ar,
            "step_type": step_type,
            "status": "done",
            "started_at": started + 60_000,
            "completed_at": updated - 60_000,
            "file": (
                {
                    "file_name": f"{tag}.diff",
                    "sha256": hashlib.sha256(diff).hexdigest(),
                }
                if with_file
                else None
            ),
        },
    }
    response = client.post("/api/v1/telemetry/sync", json=payload)
    response.raise_for_status()
    if upload:
        upload = client.put(
            f"/api/v1/objects/step-diffs/{payload['message_id']}",
            content=diff,
            headers={"Content-Type": "application/octet-stream"},
        )
        upload.raise_for_status()
    return payload["message_id"]


def records() -> dict[str, dict]:
    body = client.get(
        "/api/v1/admin/attribution/records", params={"page_size": 100, "excluded": "all"}
    ).raise_for_status().json()
    return {item["dev_run_id"]: item for item in body["items"]}


def wait_for(expect: dict[str, str], timeout: float = 60.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        client.post("/api/v1/admin/attribution/scan")
        current = records()
        actual = {
            tag: current[msg_id]["record_status"]
            for tag, msg_id in targets.items()
            if msg_id in current
        }
        if all(actual.get(tag) == status for tag, status in expect.items()):
            print(f"  ✓ 归因状态就绪: {expect}")
            return
        time.sleep(1.0)
    raise SystemExit(f"等待超时，当前状态: {actual}，期望: {expect}")


print(f"→ 预置演示数据到 {BASE}")

# ── 版本运营视图数据 ─────────────────────────────────────────────
# 张轶渤：20 天前 1.1.1，现已升到 2.3.2（升级轨迹演示，计入“已用最新版”）
sync("zyb-design", user_email="zhangyibo@example.com", user_name="张轶渤",
     version="1.1.1", when_days_ago=20, step_type="task-design", sr="SR-2001")
msg_zyb_3d = sync("zyb-dev-3d", user_email="zhangyibo@example.com", user_name="张轶渤",
                  version="2.3.2", when_days_ago=3, sr="SR-2001", ar="AR-2001",
                  with_file=True)
msg_zyb_1d = sync("zyb-dev-1d", user_email="zhangyibo@example.com", user_name="张轶渤",
                  version="2.3.2", when_days_ago=1, sr="SR-2002", ar="AR-2002",
                  with_file=True)

# 徐哲威：仍在 1.1.1（旧版本名单，落后 1 个版本位）
msg_xuzw = sync("xuzw-dev", user_email="xuzhewei@example.com", user_name="徐哲威",
                version="1.1.1", when_days_ago=1, sr="SR-2003", ar="AR-2003",
                with_file=True)

# 宋东方：0.1.0（落后 2 位），AR 带 NOMATCH → 未匹配，且带 40 行生成（双口径演示主角）
msg_songdf = sync("mid", user_email="songdongfang@example.com", user_name="宋东方",
                  version="0.1.0", when_days_ago=5, sr="SR-2004",
                  ar="AR-3001-NOMATCH", repository="telemetry-smoke", with_file=True)

# 张立肖：版本号是 remote-smoke（非发布版本账号，单独计数）
msg_zhanglx = sync("zhanglx-dev", user_email="zhanglixiao@example.com", user_name="张立肖",
                   version="remote-smoke", when_days_ago=1, sr="SR-2005", ar="AR-2005",
                   with_file=True)

# 王五：最新版，只到设计步骤（无生成）
sync("wangwu-design", user_email="wangwu@example.com", user_name="王五",
     version="2.3.2", when_days_ago=0.08, step_type="task-design", sr="SR-2006")

# ── 未入队 / 无关化 ─────────────────────────────────────────────
# 孙杨宇鑫：带补丁文件但未上传 → 未入队（等待补丁）
msg_sun = sync("sun-dev", user_email="sunyangyuxin@example.com", user_name="孙杨宇鑫",
               version="2.3.2", when_days_ago=0.08, sr="SR-2007", ar="AR-2007",
               with_file=True, upload=False)
# 周八：同样未入队（后续可在页面上现场演示“无关化”）
msg_zhou = sync("zhou-dev", user_email="zhouba@example.com", user_name="周八",
                version="2.3.2", when_days_ago=0.12, sr="SR-2008", ar="AR-2008",
                with_file=True, upload=False)

# ── 退避重试 / 超窗失败 ─────────────────────────────────────────
# 钱九：AR 含 FAIL → mock 引擎 500 → 退避重试（失败分组演示）
msg_qian = sync("qian-dev", user_email="qianjiu@example.com", user_name="钱九",
                version="2.3.2", when_days_ago=0.02, sr="SR-2009", ar="AR-9001-FAIL",
                with_file=True)

# 赵六：91 天前完成开发并上传 → 超出 90 天重试窗口被自动置失败（强制重跑演示）
# 另有一条 45 天前的设计上报：窗口外沉默用户，不进入版本名单
sync("zl-design", user_email="zhaoliu@example.com", user_name="赵六",
     version="1.1.1", when_days_ago=45, step_type="task-design", sr="SR-2010")
msg_zhao = sync("zhao-dev", user_email="zhaoliu@example.com", user_name="赵六",
                version="1.1.1", when_days_ago=91, sr="SR-2010", ar="AR-2010",
                with_file=True)

targets = {
    "zyb_3d": msg_zyb_3d, "zyb_1d": msg_zyb_1d, "xuzw": msg_xuzw,
    "songdf": msg_songdf, "zhanglx": msg_zhanglx, "sun": msg_sun,
    "zhou": msg_zhou, "qian": msg_qian, "zhao": msg_zhao,
}

print("→ 等待归因调度达到预期状态…")
wait_for({
    "zyb_3d": "finalized_match", "zyb_1d": "finalized_match",
    "xuzw": "finalized_match", "songdf": "finalized_no_match",
    "zhanglx": "finalized_match", "sun": "not_queued",
    "zhou": "not_queued", "qian": "retry_pending", "zhao": "failed",
})

print("→ 无关化宋东方的未匹配记录（演示双口径）")
client.post(
    f"/api/v1/admin/attribution/records/{msg_songdf}/exclude",
    json={"reason": "实验性生成，不以合入为目的", "operator": "演示种子"},
).raise_for_status()

current = records()
by_tag = {tag: current[msg] for tag, msg in targets.items()}
overview = client.get("/api/v1/dashboard/overview").json()["period"]
roster = client.get("/api/v1/admin/versions/roster").json()
health = client.get("/api/v1/admin/attribution/health").json()

print("\n========== 演示数据就绪 ==========")
print(f"版本基准: {roster['latest_version']}（来源 {roster['release_source']}）"
      f" · 活跃 {roster['active_users']} 人 · 旧版本 {roster['on_old']} 人"
      f" · 非发布账号 {roster['non_release_users']}")
print(f"旧版本名单: {[(r['user_name'], r['version'], r['behind']) for r in roster['items']]}")
print(f"积压体检: {health['backlog']}")
full_rate = overview["attribution_rate_80"]
intent_rate = overview["attribution_rate_80_merge_intent"]
print(f"双口径: 全量采纳率 {full_rate and round(full_rate, 3)}"
      f" · 合入意图 {intent_rate and round(intent_rate, 3)}"
      f" · 实验性占比 {overview['experimental_share'] and round(overview['experimental_share'], 3)}"
      f" · 已无关化 {overview['excluded_lines']} 行")
print("==================================")
print(f"管理台  {BASE}/admin")
print(f"采纳看板 {BASE}/portal/bright.html")
