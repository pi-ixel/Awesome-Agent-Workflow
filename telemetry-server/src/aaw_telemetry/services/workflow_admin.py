"""管理台「工作流」tab：浏览全量工作流并按三级粒度删除/恢复。

设计说明书《工作流数据管理与删除》：系统不做任何"该删什么"的自动判定，
只提供数据浏览 + 三级删除（工作流 / DevRun / 归因）+ 结构化理由留痕 + 归档恢复。
删除是可恢复的标记而非物理清除，所有统计口径即时过滤（queries.py）。
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from ..config import Settings
from ..errors import ApiError
from ..models import CodeAttribution, DevRun, ObjectUpload, TelemetryMessage, WorkflowRun

logger = logging.getLogger("aaw_telemetry.admin.workflow")

# 结构化理由枚举：防止"删除"沦为糊弄数据的后门（设计说明书 §3.3）
REASON_CODES: dict[str, str] = {
    "trial": "试验性",
    "stalled": "停滞放弃",
    "wrong_repo": "非目标仓库",
    "superseded": "重复生成",
    "unsatisfied": "生成后弃用",
    "no_match_unresolvable": "无法匹配",
    "other": "其他",
}

# 补丁内容预览上限：原文按需查看，全文走下载
PATCH_PREVIEW_CHARS = 20_000


def summarize_diff(text: str) -> dict:
    """统一 diff → 文件级概要：每个文件 +新增/-删除 行数（管理员只关心动了哪些文件）。"""
    files: list[dict] = []
    current: dict | None = None
    for line in text.split("\n"):
        if line.startswith("diff --git "):
            current = {"file": None, "additions": 0, "deletions": 0, "binary": False}
            files.append(current)
            continue
        if current is None:
            continue
        if line.startswith("+++ "):
            name = line[4:].strip()
            if name.startswith("b/"):
                name = name[2:]
            current["file"] = name.strip('"')
        elif line.startswith("Binary files ") or line.startswith("GIT binary patch"):
            current["binary"] = True
        elif line.startswith("-") and not line.startswith("--- "):
            current["deletions"] += 1
        elif line.startswith("+") and not line.startswith("+++ "):
            current["additions"] += 1
    for item in files:
        if not item["file"]:
            item["file"] = "（未知文件）"
    files.sort(key=lambda f: -(f["additions"] + f["deletions"]))
    return {
        "files": files,
        "file_count": len(files),
        "total_additions": sum(f["additions"] for f in files),
        "total_deletions": sum(f["deletions"] for f in files),
    }

WORKFLOW_STATES = ("all", "active", "stalled", "in_progress", "completed")
LIFECYCLES = ("active", "deleted", "all")
# 归因删除只面向已有结论的终态记录；在途/失败的请删整条产出或等终态
ATTRIBUTION_DELETABLE = ("finalized_match", "finalized_no_match")


def _now() -> datetime:
    value = datetime.now(UTC)
    return value.replace(microsecond=(value.microsecond // 1000) * 1000)


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.isoformat()


def validate_reason(reason_code: str, reason: str | None) -> str | None:
    """理由码必选；「其他」必须补备注，避免留痕失效。"""
    if reason_code not in REASON_CODES:
        raise ApiError(
            400,
            "INVALID_REASON_CODE",
            f"未知删除理由 {reason_code}，可选：{'、'.join(REASON_CODES)}",
        )
    note = (reason or "").strip() or None
    if reason_code == "other" and not note:
        raise ApiError(400, "REASON_NOTE_REQUIRED", '删除理由为「其他」时必须填写备注')
    return note


def _deletion_fields(row) -> dict:
    """统一的删除留痕负载（workflow_run / dev_run / code_attribution 通用）。

    dev_run 复用 0019 的 admin_excluded 字段组（语义为删除），在此归一。
    """
    return {
        "deleted": bool(getattr(row, "deleted", False) or getattr(row, "admin_excluded", False)),
        "deleted_reason_code": getattr(row, "deleted_reason_code", None),
        "deleted_reason": getattr(row, "deleted_reason", None)
        or getattr(row, "admin_excluded_reason", None),
        "deleted_by": getattr(row, "deleted_by", None)
        or getattr(row, "admin_excluded_by", None),
        "deleted_at": _iso(
            getattr(row, "deleted_at", None) or getattr(row, "admin_excluded_at", None)
        ),
    }


class WorkflowAdminService:
    """浏览 + 三级删除 + 归档恢复。"""

    def __init__(self, session: Session, settings: Settings):
        self.session = session
        self.settings = settings

    # ------------------------------------------------------------------
    # 列表

    def list_workflows(
        self,
        *,
        user: str | None,
        repository: str | None,
        state: str,
        lifecycle: str,
        workflow_kind: str,
        from_date: date | None,
        to_date: date | None,
        page: int,
        page_size: int,
    ) -> dict:
        if state not in WORKFLOW_STATES:
            raise ApiError(400, "INVALID_FILTER", f"未知状态 {state}")
        if lifecycle not in LIFECYCLES:
            raise ApiError(400, "INVALID_FILTER", f"未知生命周期 {lifecycle}")
        if workflow_kind not in ("aaw", "testing"):
            raise ApiError(400, "INVALID_FILTER", f"未知通道 {workflow_kind}")
        if from_date and to_date and from_date > to_date:
            raise ApiError(400, "INVALID_FILTER", "from 必须早于 to")

        statement = select(WorkflowRun).where(WorkflowRun.workflow_kind == workflow_kind)
        if lifecycle == "active":
            statement = statement.where(WorkflowRun.deleted.is_(False))
        elif lifecycle == "deleted":
            statement = statement.where(WorkflowRun.deleted.is_(True))
        now = datetime.now(UTC)
        threshold = now - timedelta(hours=24)
        if state == "in_progress":
            statement = statement.where(WorkflowRun.status == "in_progress")
        elif state == "completed":
            statement = statement.where(WorkflowRun.status == "completed")
        elif state == "active":
            statement = statement.where(
                WorkflowRun.status == "in_progress",
                WorkflowRun.last_activity_at >= threshold,
            )
        elif state == "stalled":
            statement = statement.where(
                WorkflowRun.status == "in_progress",
                WorkflowRun.last_activity_at < threshold,
            )
        if repository:
            statement = statement.where(WorkflowRun.project_key.like(f"%{repository}%"))
        if user:
            like = f"%{user}%"
            statement = statement.where(
                WorkflowRun.git_user_name.like(like) | WorkflowRun.git_user_email.like(like)
            )
        if from_date is not None:
            start = datetime.combine(from_date, datetime.min.time(), tzinfo=UTC)
            statement = statement.where(WorkflowRun.last_activity_at >= start)
        if to_date is not None:
            end = datetime.combine(
                to_date + timedelta(days=1), datetime.min.time(), tzinfo=UTC
            )
            statement = statement.where(WorkflowRun.last_activity_at < end)

        total = self.session.execute(
            select(func.count()).select_from(statement.subquery())
        ).scalar_one()
        rows = list(
            self.session.scalars(
                statement.order_by(WorkflowRun.last_activity_at.desc(), WorkflowRun.id.asc())
                .offset((page - 1) * page_size)
                .limit(page_size)
            ).all()
        )
        # 归档角标：与生命周期筛选无关的已删除总数，提示"还有多少历史删除"
        deleted_total = self.session.execute(
            select(func.count())
            .select_from(WorkflowRun)
            .where(
                WorkflowRun.workflow_kind == workflow_kind,
                WorkflowRun.deleted.is_(True),
            )
        ).scalar_one()
        return {
            "total": total,
            "page": page,
            "page_size": page_size,
            "deleted_total": deleted_total,
            "items": [self._workflow_row(row) for row in rows],
        }

    def _workflow_row(self, workflow: WorkflowRun) -> dict:
        messages = list(
            self.session.scalars(
                select(TelemetryMessage).where(
                    TelemetryMessage.workflow_run_id == workflow.id
                )
            ).all()
        )
        devs = list(
            self.session.scalars(
                select(DevRun)
                .where(DevRun.workflow_run_id == workflow.id)
                .options(selectinload(DevRun.attribution))
            ).all()
        )
        active = [row for row in devs if not row.admin_excluded]
        live_attrs = [
            row.attribution
            for row in active
            if row.attribution is not None and not row.attribution.deleted
        ]
        # 互斥分类，保证三类之和等于在用归因数（历史数据可能混态）
        matched = no_match = pending = 0
        for a in live_attrs:
            if a.result_status == "finalized_match":
                matched += 1
            elif a.attribution_status in ("pending", "running", "retry_pending", "failed"):
                pending += 1
            else:
                no_match += 1
        latest = messages[-1] if messages else None
        item = {
            "workflow_run_id": str(workflow.id),
            "workflow_kind": workflow.workflow_kind,
            "entry": workflow.entry,
            "sr": workflow.sr,
            "ar": workflow.ar,
            "repository": workflow.project_key,
            "user_name": latest.user_name if latest else workflow.git_user_name,
            "user_email": latest.user_email if latest else workflow.git_user_email,
            "aaw_version": workflow.aaw_version,
            "status": workflow.status,
            "started_at": _iso(workflow.started_at),
            "last_activity_at": _iso(workflow.last_activity_at),
            "steps": len(messages),
            "furthest_step_type": latest.step_type if latest else None,
            "dev_runs": len(active),
            "deleted_dev_runs": sum(row.admin_excluded for row in devs),
            "dev_effective_lines": sum(
                int(row.code_statistics["total_effective_lines"])
                for row in active
                if row.code_statistics
            ),
            "attributed_lines_80": sum(a.attributed_lines_80 for a in live_attrs),
            "attribution_matched": matched,
            "attribution_no_match": no_match,
            "attribution_pending": pending,
            **_deletion_fields(workflow),
        }
        return item

    # ------------------------------------------------------------------
    # 详情（三级同屏：工作流 → 步骤+DevRun → 归因）

    def detail(self, workflow_id: uuid.UUID) -> dict:
        workflow = self.session.get(WorkflowRun, workflow_id)
        if workflow is None:
            raise ApiError(404, "WORKFLOW_NOT_FOUND", f"工作流 {workflow_id} 不存在")
        messages = list(
            self.session.scalars(
                select(TelemetryMessage)
                .where(TelemetryMessage.workflow_run_id == workflow_id)
                .order_by(TelemetryMessage.step_started_at.asc(), TelemetryMessage.id.asc())
            ).all()
        )
        devs = {
            row.id: row
            for row in self.session.scalars(
                select(DevRun)
                .where(DevRun.workflow_run_id == workflow_id)
                .options(selectinload(DevRun.attribution))
            ).all()
        }
        steps = []
        for message in messages:
            dev = devs.get(message.id)
            attribution = dev.attribution if dev is not None else None
            steps.append(
                {
                    "message_id": str(message.id),
                    "step_type": message.step_type,
                    "status": message.status,
                    "step_started_at": _iso(message.step_started_at),
                    "step_completed_at": _iso(message.step_completed_at),
                    "user_name": message.user_name,
                    "repository": message.repository,
                    "file_name": message.file_name,
                    "dev_run": (
                        {
                            "dev_run_id": str(dev.id),
                            "branch": dev.branch,
                            "status": dev.status,
                            "started_at": _iso(dev.started_at),
                            "completed_at": _iso(dev.completed_at),
                            "dev_effective_lines": int(
                                (dev.code_statistics or {}).get("total_effective_lines") or 0
                            ),
                            "attribution": (
                                self._attribution_row(attribution) if attribution else None
                            ),
                            **_deletion_fields(dev),
                        }
                        if dev is not None
                        else None
                    ),
                }
            )
        return {
            "workflow": self._workflow_row(workflow),
            "steps": steps,
        }

    @staticmethod
    def _attribution_row(attribution: CodeAttribution) -> dict:
        return {
            "attributed_lines_60": attribution.attributed_lines_60,
            "attributed_lines_80": attribution.attributed_lines_80,
            "attributed_lines_90": attribution.attributed_lines_90,
            "confidence": attribution.confidence,
            "attribution_status": attribution.attribution_status,
            "result_status": attribution.result_status,
            "algorithm_version": attribution.algorithm_version,
            "matched_mr_iid": attribution.matched_mr_iid,
            "matched_mr_url": attribution.matched_mr_url,
            "mr_merged_at": _iso(attribution.mr_merged_at),
            "matched_at": _iso(attribution.matched_at),
            **_deletion_fields(attribution),
        }

    # ------------------------------------------------------------------
    # 三级删除

    def delete_workflow(
        self,
        workflow_id: uuid.UUID,
        *,
        reason_code: str,
        reason: str | None,
        operator: str | None,
    ) -> dict:
        note = validate_reason(reason_code, reason)
        workflow = self.session.get(WorkflowRun, workflow_id)
        if workflow is None:
            raise ApiError(404, "WORKFLOW_NOT_FOUND", f"工作流 {workflow_id} 不存在")
        if workflow.deleted:
            raise ApiError(409, "ALREADY_DELETED", "该工作流已删除，无需重复操作")
        now = _now()
        workflow.deleted = True
        workflow.deleted_reason_code = reason_code
        workflow.deleted_reason = note
        workflow.deleted_by = (operator or "admin").strip() or "admin"
        workflow.deleted_at = now
        workflow.server_updated_at = now
        self.session.commit()
        logger.info(
            "管理员删除工作流（连带其下全部产出与归因）",
            extra={
                "event": "admin.workflow_deleted",
                "workflow_run_id": str(workflow_id),
                "reason_code": reason_code,
                "reason": note,
                "operator": workflow.deleted_by,
            },
        )
        return {"workflow_run_id": str(workflow_id), "deleted": True}

    def restore_workflow(self, workflow_id: uuid.UUID, *, operator: str | None) -> dict:
        workflow = self.session.get(WorkflowRun, workflow_id)
        if workflow is None:
            raise ApiError(404, "WORKFLOW_NOT_FOUND", f"工作流 {workflow_id} 不存在")
        if not workflow.deleted:
            raise ApiError(409, "NOT_DELETED", "该工作流未被删除，无需恢复")
        workflow.deleted = False
        workflow.deleted_reason_code = None
        workflow.deleted_reason = None
        workflow.deleted_by = None
        workflow.deleted_at = None
        workflow.server_updated_at = _now()
        self.session.commit()
        logger.info(
            "管理员恢复已删除的工作流",
            extra={
                "event": "admin.workflow_restored",
                "workflow_run_id": str(workflow_id),
                "operator": operator or "admin",
            },
        )
        return {"workflow_run_id": str(workflow_id), "deleted": False}

    def _load_dev_run(self, dev_run_id: uuid.UUID) -> DevRun:
        dev_run = self.session.get(DevRun, dev_run_id)
        if dev_run is None:
            raise ApiError(404, "DEV_RUN_NOT_FOUND", f"开发记录 {dev_run_id} 不存在")
        return dev_run

    # ------------------------------------------------------------------
    # 补丁文件内容（快速定位"上报的文件是否有问题"）

    def patch_content(self, dev_run_id: uuid.UUID) -> dict:
        """补丁文件内容预览。读取顺序：活跃补丁 → 归档文件。

        返回 raw 字节供下载路由使用；缺失时 missing=True 而非 404，
        让前端能就地展示原因（未上传 / 超窗归档清理）。
        """
        dev_run = self._load_dev_run(dev_run_id)
        # ObjectUpload 主键是自身 id，须按 owner_id 定位
        upload = self.session.scalar(
            select(ObjectUpload).where(ObjectUpload.owner_id == dev_run_id)
        )
        message = self.session.get(TelemetryMessage, dev_run_id)
        root = self.settings.object_storage_dir.resolve()
        candidates = []
        if dev_run.patch_object_key:
            candidates.append(("live", root / dev_run.patch_object_key))
        if upload is not None and upload.archive_key:
            candidates.append(("archive", root / upload.archive_key))
        raw = None
        source = None
        used_key = None
        for source, path in candidates:
            try:
                resolved = path.resolve()
            except OSError:
                continue
            if not resolved.is_relative_to(root) or not resolved.is_file():
                continue
            raw = resolved.read_bytes()
            used_key = str(path.relative_to(root)) if path.is_relative_to(root) else None
            break
        if raw is None:
            return {
                "dev_run_id": str(dev_run_id),
                "missing": True,
                "reason": "补丁文件不存在（未上传，或超出保留期已被归档清理）",
                "upload_status": upload.status if upload is not None else None,
                "patch_object_key": dev_run.patch_object_key,
            }
        text = raw.decode("utf-8", errors="replace")
        file_name = (message.file_name if message else None) or f"{dev_run_id}.diff"
        return {
            "dev_run_id": str(dev_run_id),
            "missing": False,
            "source": source,
            "object_key": used_key,
            "file_name": file_name,
            "sha256": upload.sha256 if upload is not None else None,
            "upload_status": upload.status if upload is not None else None,
            "size_bytes": len(raw),
            "truncated": len(text) > PATCH_PREVIEW_CHARS,
            "content": text[:PATCH_PREVIEW_CHARS],
            # 文件级概要按全文解析（截断只影响原文预览，不影响统计）
            **summarize_diff(text),
            "raw": raw,
        }

    def delete_dev_run(
        self,
        dev_run_id: uuid.UUID,
        *,
        reason_code: str,
        reason: str | None,
        operator: str | None,
    ) -> dict:
        note = validate_reason(reason_code, reason)
        dev_run = self._load_dev_run(dev_run_id)
        if dev_run.admin_excluded:
            raise ApiError(409, "ALREADY_DELETED", "该开发记录已删除，无需重复操作")
        now = _now()
        # 列名沿用 0019 的 admin_excluded 字段组，语义为"删除"（全口径生效）
        dev_run.admin_excluded = True
        dev_run.admin_excluded_reason = note
        dev_run.admin_excluded_at = now
        dev_run.admin_excluded_by = (operator or "admin").strip() or "admin"
        dev_run.deleted_reason_code = reason_code
        dev_run.server_updated_at = now
        self.session.commit()
        logger.info(
            "管理员删除开发产出（分母剔除其生成行数，归因随之失效）",
            extra={
                "event": "admin.dev_run_deleted",
                "dev_run_id": str(dev_run_id),
                "reason_code": reason_code,
                "reason": note,
                "operator": dev_run.admin_excluded_by,
            },
        )
        return {"dev_run_id": str(dev_run_id), "deleted": True}

    def restore_dev_run(self, dev_run_id: uuid.UUID, *, operator: str | None) -> dict:
        dev_run = self._load_dev_run(dev_run_id)
        if not dev_run.admin_excluded:
            raise ApiError(409, "NOT_DELETED", "该开发记录未被删除，无需恢复")
        dev_run.admin_excluded = False
        dev_run.admin_excluded_reason = None
        dev_run.admin_excluded_at = None
        dev_run.admin_excluded_by = None
        dev_run.deleted_reason_code = None
        dev_run.server_updated_at = _now()
        self.session.commit()
        logger.info(
            "管理员恢复已删除的开发产出",
            extra={
                "event": "admin.dev_run_restored",
                "dev_run_id": str(dev_run_id),
                "operator": operator or "admin",
            },
        )
        return {"dev_run_id": str(dev_run_id), "deleted": False}

    def delete_attribution(
        self,
        dev_run_id: uuid.UUID,
        *,
        reason_code: str,
        reason: str | None,
        operator: str | None,
    ) -> dict:
        note = validate_reason(reason_code, reason)
        attribution = self.session.get(CodeAttribution, dev_run_id)
        if attribution is None:
            raise ApiError(
                409,
                "RECORD_NOT_QUEUED",
                "该记录未入队（无归因结果），如需剔除产出请删除对应的开发记录",
            )
        if attribution.deleted:
            raise ApiError(409, "ALREADY_DELETED", "该归因结果已删除，无需重复操作")
        if attribution.attribution_status not in ATTRIBUTION_DELETABLE:
            raise ApiError(
                409,
                "ATTRIBUTION_NOT_TERMINAL",
                "归因尚无最终结论（在途/失败），请等待终态或改为删除整条开发记录",
            )
        now = _now()
        attribution.deleted = True
        attribution.deleted_reason_code = reason_code
        attribution.deleted_reason = note
        attribution.deleted_by = (operator or "admin").strip() or "admin"
        attribution.deleted_at = now
        attribution.server_updated_at = now
        self.session.commit()
        logger.info(
            "管理员删除归因结果（该产出退回未归因状态）",
            extra={
                "event": "admin.attribution_deleted",
                "dev_run_id": str(dev_run_id),
                "reason_code": reason_code,
                "reason": note,
                "operator": attribution.deleted_by,
                "result_status": attribution.result_status,
            },
        )
        return {"dev_run_id": str(dev_run_id), "deleted": True}

    def restore_attribution(self, dev_run_id: uuid.UUID, *, operator: str | None) -> dict:
        attribution = self.session.get(CodeAttribution, dev_run_id)
        if attribution is None:
            raise ApiError(404, "ATTRIBUTION_NOT_FOUND", f"归因记录 {dev_run_id} 不存在")
        if not attribution.deleted:
            raise ApiError(409, "NOT_DELETED", "该归因结果未被删除，无需恢复")
        attribution.deleted = False
        attribution.deleted_reason_code = None
        attribution.deleted_reason = None
        attribution.deleted_by = None
        attribution.deleted_at = None
        attribution.server_updated_at = _now()
        self.session.commit()
        logger.info(
            "管理员恢复已删除的归因结果",
            extra={
                "event": "admin.attribution_restored",
                "dev_run_id": str(dev_run_id),
                "operator": operator or "admin",
            },
        )
        return {"dev_run_id": str(dev_run_id), "deleted": False}
