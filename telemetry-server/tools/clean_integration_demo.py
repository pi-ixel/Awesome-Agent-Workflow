"""清理上一轮演示数据，便于用修正后的脚本重新生长（可重复执行）。

只删 SR-9xxx 段的演示工作流及其派生的归因、步骤、上报、对象与异常事件；
内置规则、注册表与既有真实数据不动。异常事件全量重建，因为重新评估会
把真实的命中（如既有仓库的停滞、上报中断）一并重新生成出来。
"""

from __future__ import annotations

import os

from sqlalchemy import create_engine, text

engine = create_engine(os.environ["AAW_TELEMETRY_DATABASE_URL"])
STATEMENTS = [
    "DELETE FROM anomaly_action",
    "DELETE FROM anomaly_archive_request",
    "DELETE FROM anomaly_issue_link",
    "DELETE FROM anomaly_event",
    (
        "DELETE o FROM object_upload o JOIN telemetry_message m ON m.id = o.owner_id "
        "WHERE m.sr LIKE 'SR-9%'"
    ),
    (
        "DELETE ca FROM code_attribution ca JOIN dev_run d ON d.id = ca.dev_run_id "
        "JOIN workflow_run w ON w.id = d.workflow_run_id WHERE w.sr LIKE 'SR-9%'"
    ),
    (
        "DELETE d FROM dev_run d JOIN workflow_run w ON w.id = d.workflow_run_id "
        "WHERE w.sr LIKE 'SR-9%'"
    ),
    (
        "DELETE se FROM step_execution se JOIN workflow_run w ON w.id = se.workflow_run_id "
        "WHERE w.sr LIKE 'SR-9%'"
    ),
    "DELETE FROM telemetry_message WHERE sr LIKE 'SR-9%'",
    "DELETE FROM workflow_run WHERE sr LIKE 'SR-9%'",
]
with engine.begin() as conn:
    for statement in STATEMENTS:
        result = conn.execute(text(statement))
        print(f"{result.rowcount:5d}  {statement[:70]}")
print("演示数据已清理")
