from __future__ import annotations

import hashlib
import json
import logging
import re
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Iterator, Protocol

from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..config import ProjectRegistry
from ..errors import ApiError
from ..models import (
    AiMaster,
    AnomalyAction,
    AnomalyArchiveRequest,
    AnomalyEvent,
    AnomalyIssueLink,
    AnomalyRule,
    AnomalyRuleAudit,
    CodeAttribution,
    ComponentRepo,
    DevRun,
    Issue,
    IssueActivity,
    RepoAiMaster,
    StepExecution,
    TelemetryMessage,
    WorkflowRun,
)

logger = logging.getLogger("aaw_telemetry.anomalies")

SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
ISSUE_ASSIGNEES = {"张轶勃", "徐哲威", "宋东方", "张立肖", "孙杨宇鑫"}

# 内置检测规则的历史展示名：文案升级后，名字仍停在这些旧文案上的已种规则
# 会在启动补齐时自动换新名；管理员自定义名不受影响。
_LEGACY_RULE_NAMES: dict[str, set[str]] = {
    "unassigned_data": {"数据无法归属"},
    "patch_missing": {"补丁缺失"},
    "attribution_stuck": {"归因任务卡住"},
}

# 已下架的内置检测类型：启动补齐时把对应规则标记为删除并收尾其事件。
# 信息不丢失的两条（人工门禁超时、版本发生回退）分别并入工作流停滞和
# 旧版本持续活跃的 evidence；其余三条（核心统计突变、状态前后不一致、
# 归因结果质量异常）按设计评审结论直接移除。
_RETIRED_DETECTORS: dict[str, str] = {
    "core_stats_shift": "低量平台持续误报，用量变化不构成异常",
    "workflow_inconsistent": "平台自身数据一致性自检，转服务端日志",
    "manual_gate_timeout": "并入「工作流停滞」，事件里标注在等人工确认",
    "attribution_quality": "被忽略清单与其他归因规则架空，无独立场景",
    "version_rollback": "并入「旧版本持续活跃」，事件里标注回退来源",
}



@dataclass(frozen=True)
class DetectorSpec:
    code: str
    category: str
    name: str
    description: str
    defaults: dict[str, Any]
    enabled: bool = True
    # 面向管理员的一句话判定说明；{参数名} 会被替换为带底色的可调值，
    # 让“这条规则在检测什么、哪个数字可以调”一眼可读。
    sentence: str = ""


DETECTOR_SPECS: dict[str, DetectorSpec] = {
    item.code: item
    for item in (
        DetectorSpec(
            "telemetry_gap",
            "component",
            "数据上报中断",
            "近期活跃仓库长时间没有遥测上报",
            {"max_idle_hours": 72, "active_window_days": 14},
            sentence="近 {active_window_days} 内活跃过的仓库，已连续 {max_idle_hours} 没有任何上报",
        ),
        DetectorSpec(
            "unassigned_data",
            "component",
            "上报了未登记的仓库",
            "上报仓库不能匹配组件登记关系",
            {"window_hours": 24, "min_count": 3},
            sentence="近 {window_hours} 内同一仓库累计有 {min_count} 上报无法匹配到已登记组件",
        ),
        DetectorSpec(
            "adoption_drop",
            "component",
            "采纳率大幅下降",
            "近期产出的采纳率明显低于自身历史水平",
            {"recent_days": 7, "baseline_days": 28, "drop_pp": 25, "min_runs": 3, "min_lines": 60},
            sentence=(
                "近 {recent_days} 产出的采纳率（80% 口径）比之前 {baseline_days} 下降超过 "
                "{drop_pp}，且两侧各有至少 {min_runs} 产出、{min_lines} 有效代码"
            ),
        ),
        DetectorSpec(
            "workflow_stalled",
            "workflow",
            "工作流停滞",
            "进行中的工作流长时间没有活动",
            {"max_idle_hours": 24},
            sentence="进行中的工作流已连续 {max_idle_hours} 没有任何步骤、状态或确认更新",
        ),
        DetectorSpec(
            "workflow_failed",
            "workflow",
            "步骤执行失败",
            "工作流步骤失败或阻塞且未及时恢复",
            {"grace_minutes": 30, "statuses": ["failed", "blocked"]},
            sentence="步骤进入 {statuses} 状态后 {grace_minutes} 仍未恢复",
        ),
        DetectorSpec(
            "patch_missing",
            "attribution",
            "diff 缺失",
            "开发产出结束后没有收到可归因的 diff",
            {"wait_hours": 24},
            sentence="开发产出结束后 {wait_hours} 内仍未收到可归因的 diff",
        ),
        DetectorSpec(
            "attribution_stuck",
            "attribution",
            "归因重试迟迟不成功",
            "归因任务停留在等待重试状态过久",
            {"retry_hours": 1},
            sentence="归因任务在等待重试状态停留超过 {retry_hours}，反复重试仍无法归因",
        ),
        DetectorSpec(
            "attribution_failed",
            "attribution",
            "归因执行失败",
            "归因任务重试后仍然失败",
            {"min_retry_count": 3},
            sentence="归因任务失败重试达到 {min_retry_count} 仍未成功",
        ),
        DetectorSpec(
            "low_adoption",
            "attribution",
            "产出采纳率偏低",
            "单条产出的采纳率低于阈值",
            {"threshold_percent": 50, "window_days": 30},
            sentence=(
                "近 {window_days} 内归因完成的产出，采纳率（80% 口径）低于 "
                "{threshold_percent}"
            ),
        ),
        DetectorSpec(
            "old_version_active",
            "version",
            "旧版本持续活跃",
            "人员持续使用落后于当前正式版本的版本",
            {"active_days": 7, "lag_positions": 1},
            sentence="近 {active_days} 仍在使用、且落后当前正式版本 {lag_positions} 的旧版本",
        ),
        DetectorSpec(
            "non_release_version",
            "version",
            "使用非发布版本",
            "正式使用者持续上报未登记版本",
            {"window_hours": 24, "allowlist": []},
            sentence="持续 {window_hours} 上报非发布版本，且不在允许清单（{allowlist}）内",
        ),
    )
}


@dataclass(frozen=True)
class DetectorHit:
    object_type: str
    object_key: str
    title: str
    summary: str
    repository: str | None = None
    component_id: str | None = None
    user_email: str | None = None
    actual_value: str | None = None
    threshold_value: str | None = None
    evidence: dict[str, Any] | None = None
    detail_target: dict[str, Any] | None = None


class EvidenceQueryPort(Protocol):
    def detect(self, rule: AnomalyRule, now: datetime) -> list[DetectorHit]: ...


class DataArchivePort(Protocol):
    def preview(self, target_type: str, target_id: str) -> dict[str, Any]: ...

    def archive(
        self, target_type: str, target_id: str, reason: str, actor: str, now: datetime
    ) -> None: ...


class IssueBoardPort(Protocol):
    def create(
        self,
        event: AnomalyEvent,
        suggestion: str,
        reporter: str,
        assignee: str,
        now: datetime,
    ) -> Issue: ...


class OwnershipProvider(Protocol):
    def by_repository(self) -> dict[str, uuid.UUID]: ...


def _now() -> datetime:
    return datetime.now(UTC)


@contextmanager
def startup_lock(engine, name: str, timeout_seconds: int = 10) -> Iterator[bool]:
    """启动补种子时串行化多 worker 的执行，拿到锁 yield True，没拿到 yield False。

    MySQL 的 GET_LOCK 按名字在整个 server 上生效，但取、放必须落在同一条连接上。
    所以这里用一条专门的连接占住锁、用完再放——不能挂在 session 上：被包住的
    补种子会自己 commit，commit 会把 session 的连接还回连接池，RELEASE_LOCK 就
    可能跑到另一条物理连接上去，锁等于没放。SQLite / 其他方言没有对应能力，
    直接放行（唯一约束兜底）。
    """
    if engine.dialect.name != "mysql":
        yield True
        return
    with engine.connect() as lock_conn:
        acquired = bool(
            lock_conn.execute(
                text("SELECT GET_LOCK(:name, :timeout)"),
                {"name": name, "timeout": timeout_seconds},
            ).scalar()
        )
        if not acquired:
            logger.warning(
                "启动锁未获取到，跳过内置规则补齐",
                extra={"event": "anomaly.startup_lock_timeout", "lock": name},
            )
        try:
            yield acquired
        finally:
            if acquired:
                lock_conn.execute(text("SELECT RELEASE_LOCK(:name)"), {"name": name})


def _aware(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _iso(value: datetime | None) -> str | None:
    return _aware(value).isoformat() if value else None


def _semver(value: str) -> tuple[int, int, int] | None:
    return tuple(int(x) for x in value.split(".")) if SEMVER.fullmatch(value or "") else None


def _active_key(rule_id: uuid.UUID, object_type: str, object_key: str) -> str:
    raw = f"{rule_id}:{object_type}:{object_key}".encode()
    return hashlib.sha256(raw).hexdigest()


def _jsonable(value: Any) -> Any:
    return json.loads(
        json.dumps(
            value,
            default=lambda item: item.isoformat() if isinstance(item, datetime) else str(item),
        )
    )


def _rule_payload(rule: AnomalyRule) -> dict[str, Any]:
    return {
        "id": str(rule.id),
        "name": rule.name,
        "category": rule.category,
        "detector_type": rule.detector_type,
        "scope_type": rule.scope_type,
        "scope_value": rule.scope_value,
        "params": rule.params,
        "allow_archive": rule.allow_archive,
        "status": rule.status,
        "version": rule.version,
        "change_reason": rule.change_reason,
        "created_by": rule.created_by,
        "updated_by": rule.updated_by,
        "created_at": _iso(rule.created_at),
        "updated_at": _iso(rule.updated_at),
        "last_evaluated_at": _iso(rule.last_evaluated_at),
        "last_match_count": rule.last_match_count,
    }


class EvidenceProvider:
    """Adapter over existing telemetry-owned tables; it never writes them."""

    def __init__(self, session: Session, projects: ProjectRegistry):
        self.session = session
        self.projects = projects
        self._repo_components = {
            row.repo_key: row.component_id for row in session.scalars(select(ComponentRepo)).all()
        }

    def detect(self, rule: AnomalyRule, now: datetime) -> list[DetectorHit]:
        method = getattr(self, f"_detect_{rule.detector_type}", None)
        if method is None:
            raise ApiError(400, "DETECTOR_NOT_IMPLEMENTED", "该异常检测类型尚未实现")
        return [hit for hit in method(rule.params, now) if self._in_scope(rule, hit)]

    def _component(self, repository: str | None) -> str | None:
        return self._repo_components.get(repository or "") or (
            self.projects.component_of(repository) if repository else None
        )

    @staticmethod
    def _in_scope(rule: AnomalyRule, hit: DetectorHit) -> bool:
        if rule.scope_type == "platform":
            return True
        if rule.scope_type == "component":
            return hit.component_id == rule.scope_value
        return hit.repository == rule.scope_value

    def _detect_telemetry_gap(self, params: dict, now: datetime) -> list[DetectorHit]:
        idle = timedelta(hours=float(params["max_idle_hours"]))
        active = timedelta(days=float(params["active_window_days"]))
        rows = self.session.execute(
            select(
                TelemetryMessage.repository, func.max(TelemetryMessage.client_updated_at)
            ).group_by(TelemetryMessage.repository)
        ).all()
        hits = []
        for repo, latest in rows:
            age = now - _aware(latest)
            if idle < age <= active:
                hits.append(
                    DetectorHit(
                        "repository",
                        repo,
                        f"{repo} 数据上报中断",
                        f"最近一次上报距今 {int(age.total_seconds() // 3600)} 小时",
                        repo,
                        self._component(repo),
                        actual_value=f"{int(age.total_seconds() // 3600)} 小时",
                        threshold_value=f"> {params['max_idle_hours']} 小时",
                        evidence={"last_reported_at": _iso(latest)},
                        detail_target={"tab": "components", "repository": repo},
                    )
                )
        return hits

    def _detect_unassigned_data(self, params: dict, now: datetime) -> list[DetectorHit]:
        cutoff = now - timedelta(hours=float(params["window_hours"]))
        rows = self.session.execute(
            select(TelemetryMessage.repository, func.count(TelemetryMessage.id))
            .where(TelemetryMessage.client_updated_at >= cutoff)
            .group_by(TelemetryMessage.repository)
        ).all()
        known = set(self._repo_components)
        return [
            DetectorHit(
                "repository",
                repo,
                f"{repo} 无法归属组件",
                f"最近窗口有 {count} 条未归属上报",
                repo,
                None,
                actual_value=str(count),
                threshold_value=f"≥ {params['min_count']} 条",
                evidence={"count": count, "window_hours": params["window_hours"]},
                detail_target={"tab": "registry", "repository": repo},
            )
            for repo, count in rows
            if repo not in known and count >= int(params["min_count"])
        ]

    def _detect_workflow_stalled(self, params: dict, now: datetime) -> list[DetectorHit]:
        cutoff = now - timedelta(hours=float(params["max_idle_hours"]))
        rows = self.session.scalars(
            select(WorkflowRun).where(
                WorkflowRun.status == "in_progress",
                WorkflowRun.deleted.is_(False),
                WorkflowRun.last_activity_at < cutoff,
            )
        ).all()
        hits = []
        for row in rows:
            # 人工门禁超时已并入本规则：等确认是最常见、也最可解释的停滞形态，
            # 命中时在摘要和证据里标注"在等谁确认"，而不是再开一条事件。
            waiting = self.session.execute(
                select(StepExecution.step_name)
                .where(
                    StepExecution.workflow_run_id == row.id,
                    StepExecution.step_type == "user-confirm",
                    StepExecution.status.in_(["ready", "running"]),
                )
                .limit(1)
            ).scalar()
            summary = (
                f"人工确认「{waiting}」已等待超过 {params['max_idle_hours']} 小时"
                if waiting
                else (
                    "已 "
                    f"{int((now - _aware(row.last_activity_at)).total_seconds() // 3600)} "
                    "小时没有活动"
                )
            )
            hits.append(
                self._workflow_hit(row, "工作流停滞", summary, f"> {params['max_idle_hours']} 小时")
            )
        return hits

    def _detect_workflow_failed(self, params: dict, now: datetime) -> list[DetectorHit]:
        cutoff = now - timedelta(minutes=float(params["grace_minutes"]))
        rows = self.session.execute(
            select(StepExecution, WorkflowRun)
            .join(WorkflowRun)
            .where(
                StepExecution.status.in_(params["statuses"]),
                StepExecution.client_updated_at < cutoff,
                WorkflowRun.deleted.is_(False),
            )
        ).all()
        return [
            self._step_hit(
                step,
                workflow,
                "步骤执行失败",
                f"步骤“{step.step_name}”处于 {step.status} 状态",
                f"> {params['grace_minutes']} 分钟",
            )
            for step, workflow in rows
        ]

    def _detect_workflow_failed(self, params: dict, now: datetime) -> list[DetectorHit]:
        cutoff = now - timedelta(minutes=float(params["grace_minutes"]))
        rows = self.session.execute(
            select(StepExecution, WorkflowRun)
            .join(WorkflowRun)
            .where(
                StepExecution.status.in_(params["statuses"]),
                StepExecution.client_updated_at < cutoff,
                WorkflowRun.deleted.is_(False),
            )
        ).all()
        return [
            self._step_hit(
                step,
                workflow,
                "步骤执行失败",
                f"步骤“{step.step_name}”处于 {step.status} 状态",
                f"> {params['grace_minutes']} 分钟",
            )
            for step, workflow in rows
        ]

    def _detect_patch_missing(self, params: dict, now: datetime) -> list[DetectorHit]:
        cutoff = now - timedelta(hours=float(params["wait_hours"]))
        rows = self.session.execute(
            select(DevRun, WorkflowRun)
            .join(WorkflowRun)
            .where(
                DevRun.completed_at.is_not(None),
                DevRun.completed_at < cutoff,
                DevRun.patch_object_key.is_(None),
                DevRun.admin_excluded.is_(False),
                WorkflowRun.deleted.is_(False),
            )
        ).all()
        return [
            self._dev_hit(
                dev,
                workflow,
                "开发产出 diff 缺失",
                "产出完成后仍未收到可归因的 diff",
                f"> {params['wait_hours']} 小时",
            )
            for dev, workflow in rows
        ]

    def _detect_attribution_stuck(self, params: dict, now: datetime) -> list[DetectorHit]:
        # 只盯 retry_pending：排队慢、执行慢是调度器健康问题，AI Master 无从处理；
        # 反复重试不上来才是用户侧可介入的信号（重跑或申请屏蔽产出）。
        limit = timedelta(hours=float(params["retry_hours"]))
        rows = self.session.execute(
            select(CodeAttribution, DevRun, WorkflowRun)
            .select_from(CodeAttribution)
            .join(DevRun, DevRun.id == CodeAttribution.dev_run_id)
            .join(WorkflowRun, WorkflowRun.id == DevRun.workflow_run_id)
            .where(
                CodeAttribution.attribution_status == "retry_pending",
                CodeAttribution.deleted.is_(False),
                DevRun.admin_excluded.is_(False),
                WorkflowRun.deleted.is_(False),
            )
        ).all()
        return [
            self._attribution_hit(
                attr,
                dev,
                workflow,
                "归因重试迟迟不成功",
                f"已重试 {attr.retry_count} 次仍在等待重试，超过 {params['retry_hours']} 小时",
                f"> {params['retry_hours']} 小时",
            )
            for attr, dev, workflow in rows
            if now - _aware(attr.server_updated_at) > limit
        ]

    def _detect_attribution_failed(self, params: dict, now: datetime) -> list[DetectorHit]:
        del now
        rows = self.session.execute(
            select(CodeAttribution, DevRun, WorkflowRun)
            .select_from(CodeAttribution)
            .join(DevRun, DevRun.id == CodeAttribution.dev_run_id)
            .join(WorkflowRun, WorkflowRun.id == DevRun.workflow_run_id)
            .where(
                CodeAttribution.attribution_status == "failed",
                CodeAttribution.retry_count >= int(params["min_retry_count"]),
                CodeAttribution.deleted.is_(False),
                DevRun.admin_excluded.is_(False),
                WorkflowRun.deleted.is_(False),
            )
        ).all()
        return [
            self._attribution_hit(
                attr,
                dev,
                workflow,
                "归因执行失败",
                f"归因已失败并重试 {attr.retry_count} 次",
                f"≥ {params['min_retry_count']} 次",
            )
            for attr, dev, workflow in rows
        ]

    def _detect_low_adoption(self, params: dict, now: datetime) -> list[DetectorHit]:
        """单条产出的采纳率低于阈值。

        与「采纳率大幅下降」不同：那条比的是仓库自身的历史变化（相对下降），
        这条看的是每条产出自身的绝对水平，按任务定位到具体是哪一条产出低了。

        分母用 code_statistics 的有效行数，与组件页的采纳率口径同源；不设最小
        行数——任务粒度下改动能很少，哪怕只采纳了一行也要能被看到。分母为 0
        （没有可统计的有效行）无法计算比例，跳过。
        """
        cutoff = now - timedelta(days=float(params["window_days"]))
        threshold = float(params["threshold_percent"]) / 100
        rows = self.session.execute(
            select(CodeAttribution, DevRun, WorkflowRun)
            .select_from(CodeAttribution)
            .join(DevRun, DevRun.id == CodeAttribution.dev_run_id)
            .join(WorkflowRun, WorkflowRun.id == DevRun.workflow_run_id)
            .where(
                CodeAttribution.attribution_status.in_(
                    ["finalized_match", "finalized_no_match"]
                ),
                CodeAttribution.deleted.is_(False),
                DevRun.completed_at.is_not(None),
                DevRun.completed_at >= cutoff,
                DevRun.admin_excluded.is_(False),
                WorkflowRun.deleted.is_(False),
            )
        ).all()
        hits = []
        for attr, dev, workflow in rows:
            total = int((dev.code_statistics or {}).get("total_effective_lines", 0))
            if total <= 0:
                continue
            adopted = attr.attributed_lines_80 or 0
            rate = adopted / total
            if rate >= threshold:
                continue
            base = self._attribution_hit(
                attr,
                dev,
                workflow,
                "产出采纳率偏低",
                f"该产出生成 {total} 行，采纳 {adopted} 行（{rate:.0%}）",
                f"< {params['threshold_percent']}%",
            )
            hits.append(
                DetectorHit(
                    **{
                        **base.__dict__,
                        "actual_value": f"{rate:.0%}",
                        "evidence": {
                            **(base.evidence or {}),
                            "effective_lines": total,
                            "attributed_lines_80": adopted,
                            "adoption_rate": round(rate, 4),
                        },
                    }
                )
            )
        return hits

    def _detect_adoption_drop(self, params: dict, now: datetime) -> list[DetectorHit]:
        recent = timedelta(days=float(params["recent_days"]))
        baseline = timedelta(days=float(params["baseline_days"]))
        cutoff_recent = now - recent
        cutoff_baseline = now - (recent + baseline)
        rows = self.session.execute(
            select(DevRun, WorkflowRun, CodeAttribution)
            .select_from(DevRun)
            .join(WorkflowRun, WorkflowRun.id == DevRun.workflow_run_id)
            .outerjoin(CodeAttribution, CodeAttribution.dev_run_id == DevRun.id)
            .where(
                DevRun.completed_at.is_not(None),
                DevRun.completed_at >= cutoff_baseline,
                DevRun.admin_excluded.is_(False),
                WorkflowRun.deleted.is_(False),
            )
        ).all()
        # 近期/基线两侧按仓库聚合；归因未出终态结果的产出两侧都不计——
        # "还没归因完"由 diff 缺失、归因重试、归因失败三条规则负责。
        buckets: dict[str, dict[str, dict[str, int]]] = {}
        for dev, workflow, attr in rows:
            repo = workflow.project_key
            if attr is None or attr.deleted or attr.attribution_status not in (
                "finalized_match", "finalized_no_match"
            ):
                continue
            completed = _aware(dev.completed_at)
            side = "recent" if completed >= cutoff_recent else "baseline"
            slot = buckets.setdefault(workflow.project_key, {"recent": {}, "baseline": {}})[side]
            slot["runs"] = slot.get("runs", 0) + 1
            if dev.code_statistics:
                slot["lines"] = slot.get("lines", 0) + int(
                    dev.code_statistics.get("total_effective_lines", 0)
                )
            slot["adopted"] = slot.get("adopted", 0) + (attr.attributed_lines_80 or 0)
            del repo
        min_runs = int(params["min_runs"])
        min_lines = int(params["min_lines"])
        drop_pp = float(params["drop_pp"])
        hits = []
        for repo, sides in buckets.items():
            recent_side, base_side = sides["recent"], sides["baseline"]
            if (
                recent_side.get("runs", 0) < min_runs
                or base_side.get("runs", 0) < min_runs
                or recent_side.get("lines", 0) < min_lines
                or base_side.get("lines", 0) < min_lines
            ):
                continue
            recent_rate = recent_side["adopted"] / recent_side["lines"]
            base_rate = base_side["adopted"] / base_side["lines"]
            if base_rate - recent_rate < drop_pp / 100:
                continue
            hits.append(
                DetectorHit(
                    "repository",
                    repo,
                    f"{repo} 采纳率大幅下降",
                    (
                        f"近 {int(params['recent_days'])} 天采纳率（80%）"
                        f"{recent_rate:.0%}，之前 {int(params['baseline_days'])} 天为 {base_rate:.0%}"
                    ),
                    repo,
                    self._component(repo),
                    actual_value=f"{recent_rate:.0%}",
                    threshold_value=f"下降 ≥ {drop_pp:.0f} 个百分点",
                    evidence={
                        "recent_runs": recent_side["runs"],
                        "recent_lines": recent_side["lines"],
                        "recent_rate": round(recent_rate, 4),
                        "baseline_runs": base_side["runs"],
                        "baseline_lines": base_side["lines"],
                        "baseline_rate": round(base_rate, 4),
                        "drop_pp": round((base_rate - recent_rate) * 100, 1),
                    },
                    detail_target={"tab": "components", "repository": repo},
                )
            )
        return hits

    def _version_rows(self, now: datetime, window: timedelta) -> dict[str, list[TelemetryMessage]]:
        rows = self.session.scalars(
            select(TelemetryMessage)
            .where(TelemetryMessage.client_updated_at >= now - window)
            .order_by(TelemetryMessage.user_email, TelemetryMessage.client_updated_at)
        ).all()
        result: dict[str, list[TelemetryMessage]] = {}
        for row in rows:
            result.setdefault(row.user_email, []).append(row)
        return result

    def _release_ladder(self) -> list[tuple[int, int, int]]:
        versions = self.session.scalars(select(TelemetryMessage.aaw_version).distinct()).all()
        return sorted({parsed for value in versions if (parsed := _semver(value)) is not None})

    def _detect_old_version_active(self, params: dict, now: datetime) -> list[DetectorHit]:
        ladder = self._release_ladder()
        if not ladder:
            return []
        users = self._version_rows(now, timedelta(days=float(params["active_days"])))
        hits = []
        for _email, rows in users.items():
            latest = rows[-1]
            current = _semver(latest.aaw_version)
            if current in ladder and len(ladder) - 1 - ladder.index(current) >= int(
                params["lag_positions"]
            ):
                # 版本发生回退已并入本规则：回退者必然落在旧版本区间，
                # 摘要里标注"从哪个版本退下来"，解释这条旧版本的来历。
                rollback = self._rollback_from(rows)
                summary = (
                    f"从 {rollback} 回退到 {latest.aaw_version} 后持续使用"
                    if rollback
                    else f"当前 {latest.aaw_version}，最新 {'.'.join(map(str, ladder[-1]))}"
                )
                hits.append(
                    self._version_hit(
                        latest,
                        "旧版本持续活跃",
                        summary,
                        f"落后 ≥ {params['lag_positions']} 个发布位",
                    )
                )
        return hits

    @staticmethod
    def _rollback_from(rows: list[TelemetryMessage]) -> str | None:
        """同一用户近期的上报里是否出现过更高的正式版本（回退来源），没有则返回 None。"""
        parsed = [
            (version := _semver(row.aaw_version))
            for row in rows
            if _semver(row.aaw_version) is not None
        ]
        highest = max(parsed) if parsed else None
        return (
            ".".join(map(str, highest))
            if highest is not None and highest > _semver(rows[-1].aaw_version or "")
            else None
        )

    def _detect_non_release_version(self, params: dict, now: datetime) -> list[DetectorHit]:
        users = self._version_rows(now, timedelta(hours=float(params["window_hours"])))
        allow = set(params["allowlist"])
        return [
            self._version_hit(
                rows[-1],
                "使用非发布版本",
                f"持续上报未登记版本 {rows[-1].aaw_version}",
                "使用正式语义化版本",
            )
            for email, rows in users.items()
            if email not in allow and _semver(rows[-1].aaw_version) is None
        ]

    def _workflow_hit(
        self, row: WorkflowRun, title: str, summary: str, threshold: str
    ) -> DetectorHit:
        return DetectorHit(
            "workflow",
            str(row.id),
            title,
            summary,
            row.project_key,
            self._component(row.project_key),
            row.git_user_email,
            summary,
            threshold,
            {
                "workflow_id": str(row.id),
                "status": row.status,
                "last_activity_at": _iso(row.last_activity_at),
            },
            {"tab": "workflows", "workflow_id": str(row.id), "repository": row.project_key},
        )

    def _step_hit(
        self, step: StepExecution, workflow: WorkflowRun, title: str, summary: str, threshold: str
    ) -> DetectorHit:
        hit = self._workflow_hit(workflow, title, summary, threshold)
        return DetectorHit(
            **{
                **hit.__dict__,
                "evidence": {
                    **(hit.evidence or {}),
                    "step_id": step.step_id,
                    "step_name": step.step_name,
                    "step_status": step.status,
                },
            }
        )

    def _dev_hit(
        self, dev: DevRun, workflow: WorkflowRun, title: str, summary: str, threshold: str
    ) -> DetectorHit:
        return DetectorHit(
            "dev_run",
            str(dev.id),
            title,
            summary,
            workflow.project_key,
            self._component(workflow.project_key),
            workflow.git_user_email,
            summary,
            threshold,
            {
                "dev_run_id": str(dev.id),
                "completed_at": _iso(dev.completed_at),
                "status": dev.status,
            },
            {"tab": "workflows", "workflow_id": str(workflow.id), "dev_run_id": str(dev.id)},
        )

    def _attribution_hit(
        self,
        attr: CodeAttribution,
        dev: DevRun,
        workflow: WorkflowRun,
        title: str,
        summary: str,
        threshold: str,
    ) -> DetectorHit:
        return DetectorHit(
            "attribution",
            str(attr.dev_run_id),
            title,
            summary,
            workflow.project_key,
            self._component(workflow.project_key),
            workflow.git_user_email,
            summary,
            threshold,
            {
                "dev_run_id": str(dev.id),
                "status": attr.attribution_status,
                "retry_count": attr.retry_count,
                "quality_flags": attr.quality_flags or [],
                "updated_at": _iso(attr.server_updated_at),
            },
            {"tab": "attribution", "dev_run_id": str(dev.id), "repository": workflow.project_key},
        )

    def _version_hit(
        self, row: TelemetryMessage, title: str, summary: str, threshold: str
    ) -> DetectorHit:
        return DetectorHit(
            "person_version",
            row.user_email,
            title,
            summary,
            row.repository,
            self._component(row.repository),
            row.user_email,
            row.aaw_version,
            threshold,
            {"current_version": row.aaw_version, "last_reported_at": _iso(row.client_updated_at)},
            {"tab": "versions", "user_email": row.user_email},
        )


class DataArchiveAdapter:
    """Mutates telemetry-owned archive flags without committing the caller's unit of work."""

    def __init__(self, session: Session):
        self.session = session

    def preview(self, target_type: str, target_id: str) -> dict[str, Any]:
        target = self._load(target_type, target_id)
        return {
            "target_type": target_type,
            "target_id": target_id,
            "affected_rows": 1,
            "already_archived": self._archived(target_type, target),
        }

    def archive(
        self, target_type: str, target_id: str, reason: str, actor: str, now: datetime
    ) -> None:
        target = self._load(target_type, target_id)
        if self._archived(target_type, target):
            raise ApiError(409, "DATA_ALREADY_ARCHIVED", "目标数据已经归档")
        if target_type == "workflow":
            target.deleted = True
            target.deleted_reason_code = "anomaly_archive"
            target.deleted_reason = reason
            target.deleted_by = actor
            target.deleted_at = now
        elif target_type == "dev_run":
            target.admin_excluded = True
            target.admin_excluded_reason = reason
            target.admin_excluded_by = actor
            target.admin_excluded_at = now
            target.deleted_reason_code = "anomaly_archive"
        elif target_type == "attribution":
            target.deleted = True
            target.deleted_reason_code = "anomaly_archive"
            target.deleted_reason = reason
            target.deleted_by = actor
            target.deleted_at = now
        else:
            # Event-only screening is completed by the anomaly application service
            # in the same transaction. No telemetry-owned source row is mutated.
            return
        target.server_updated_at = now

    def _load(self, target_type: str, target_id: str):
        try:
            key = uuid.UUID(target_id)
        except ValueError as exc:
            raise ApiError(400, "ARCHIVE_TARGET_INVALID", "归档目标标识无效") from exc
        model = {
            "workflow": WorkflowRun,
            "dev_run": DevRun,
            "attribution": CodeAttribution,
            "event": AnomalyEvent,
        }.get(target_type)
        if model is None:
            raise ApiError(400, "ARCHIVE_NOT_SUPPORTED", "该异常没有可归档的数据对象")
        target = self.session.get(model, key)
        if target is None:
            raise ApiError(404, "ARCHIVE_TARGET_NOT_FOUND", "归档目标不存在")
        return target

    @staticmethod
    def _archived(target_type: str, target) -> bool:
        if target_type == "event":
            return target.disposition == "archived"
        return bool(target.admin_excluded if target_type == "dev_run" else target.deleted)


class IssueBoardAdapter:
    """Creates an issue inside the caller-owned transaction."""

    def __init__(self, session: Session):
        self.session = session

    def create(
        self,
        event: AnomalyEvent,
        suggestion: str,
        reporter: str,
        assignee: str,
        now: datetime,
    ) -> Issue:
        evidence = json.dumps(event.evidence, ensure_ascii=False, default=str, indent=2)
        description = (
            f"异常现象：{event.summary}\n\n优化建议：{suggestion}\n\n"
            f"关键证据：\n{evidence}\n\n来源异常：{event.id}"
        )[:10000]
        issue = Issue(
            id=uuid.uuid4(),
            title=f"[异常] {event.title}"[:100],
            description=description,
            description_doc={"version": 1, "nodes": [{"type": "text", "text": description}]},
            version=1,
            reporter=reporter,
            assignee=assignee,
            status="todo",
            priority="medium",
            component=event.component_id,
            workflow_run_id=(
                uuid.UUID(event.object_key) if event.object_type == "workflow" else None
            ),
            sr=None,
            ar=None,
            created_at=now,
            updated_at=now,
            resolved_at=None,
        )
        self.session.add(issue)
        self.session.flush()
        self.session.add(
            IssueActivity(
                id=uuid.uuid4(),
                issue_id=issue.id,
                action="created",
                details={"source": "anomaly_event", "event_id": str(event.id)},
                created_at=now,
            )
        )
        return issue


class RepositoryOwnershipAdapter:
    def __init__(self, session: Session):
        self.session = session

    def by_repository(self) -> dict[str, uuid.UUID]:
        return {
            row.repo_key: row.ai_master_id
            for row in self.session.scalars(select(RepoAiMaster)).all()
        }


class AnomalyService:
    def __init__(
        self,
        session: Session,
        projects: ProjectRegistry,
        *,
        evidence: EvidenceQueryPort | None = None,
        archive: DataArchivePort | None = None,
        issue_board: IssueBoardPort | None = None,
        ownership: OwnershipProvider | None = None,
    ):
        self.session = session
        self.projects = projects
        self.evidence = evidence or EvidenceProvider(session, projects)
        self.archive = archive or DataArchiveAdapter(session)
        self.issue_board = issue_board or IssueBoardAdapter(session)
        self.ownership = ownership or RepositoryOwnershipAdapter(session)
        self._user_names: dict[str, str] | None = None

    @staticmethod
    def detector_catalog() -> dict[str, Any]:
        return {
            "items": [
                {
                    "code": spec.code,
                    "category": spec.category,
                    "name": spec.name,
                    "description": spec.description,
                    "sentence": spec.sentence,
                    "defaults": spec.defaults,
                    "enabled": spec.enabled,
                }
                for spec in DETECTOR_SPECS.values()
            ]
        }

    def list_rules(self, include_deleted: bool = False) -> dict[str, Any]:
        statement = select(AnomalyRule)
        if not include_deleted:
            statement = statement.where(AnomalyRule.status != "deleted")
        rules = self.session.scalars(statement.order_by(AnomalyRule.updated_at.desc())).all()
        return {"items": [_rule_payload(rule) for rule in rules]}

    def ensure_builtin_rules(self, actor: str = "系统初始化") -> int:
        """Create one editable rule for every built-in detector that is not represented.

        已存在的规则保持管理员改过的配置，但展示名跟随内置文案：
        名字还停在历史内置文案上的规则，升级后自动换新名。
        下架的内置检测类型：对应规则标记删除并按"规则删除"收尾事件，留审计。

        多 worker 并发启动时每个进程都会跑这里：插入用 SAVEPOINT 逐条隔离，
        撞上唯一约束（0026）只作废这一条，不牵连本轮已写入的其他规则。
        """
        rules = {
            row.detector_type: row
            for row in self.session.scalars(
                select(AnomalyRule).where(AnomalyRule.status != "deleted")
            ).all()
        }
        now = _now()
        created = 0
        renamed = 0
        retired = 0
        for code, reason in _RETIRED_DETECTORS.items():
            rule = rules.get(code)
            if rule is None:
                continue
            before = _rule_payload(rule)
            rule.status = "deleted"
            rule.version += 1
            rule.change_reason = reason
            rule.updated_by = actor
            rule.updated_at = now
            self._close_rule_events(rule.id, "rule_deleted", actor)
            self._audit(rule, "deleted", actor, before, _rule_payload(rule), reason)
            retired += 1
        for spec in DETECTOR_SPECS.values():
            rule = rules.get(spec.code)
            if rule is None:
                rule = AnomalyRule(
                    id=uuid.uuid4(),
                    name=spec.name,
                    category=spec.category,
                    detector_type=spec.code,
                    scope_type="platform",
                    scope_value=None,
                    params=dict(spec.defaults),
                    allow_archive=True,
                    status="disabled",
                    version=1,
                    change_reason="系统预置检测规则",
                    created_by=actor,
                    updated_by=actor,
                    created_at=now,
                    updated_at=now,
                )
                try:
                    # add 也要放进 SAVEPOINT：回滚时该对象才会被逐出 session，
                    # 否则它仍是待插入状态，最后 commit 会再撞一次约束。
                    with self.session.begin_nested():
                        self.session.add(rule)
                        self.session.flush()
                except IntegrityError:
                    # 别的 worker 抢先插入了同一条；它已经落在库里，本轮跳过即可。
                    logger.info(
                        "内置规则已由其他进程创建，跳过",
                        extra={
                            "event": "anomaly.rule_seed_conflict",
                            "detector_type": spec.code,
                        },
                    )
                    continue
                self._audit(rule, "created", actor, None, _rule_payload(rule), rule.change_reason)
                created += 1
            elif rule.name != spec.name:
                # 名字还停在历史内置文案（含本轮之前改过的内置文案）上时跟随升级；
                # 管理员自定义名与任何内置文案都对不上，保持不动。
                previous_names = {s.name for s in DETECTOR_SPECS.values()}
                previous_names.update(_LEGACY_RULE_NAMES.get(spec.code, set()))
                if rule.name in previous_names:
                    rule.name = spec.name
                    rule.updated_at = now
                    renamed += 1
        if created or renamed or retired:
            self.session.commit()
        return created

    def rule_detail(self, rule_id: uuid.UUID) -> dict[str, Any]:
        rule = self._rule(rule_id)
        result = _rule_payload(rule)
        audits = self.session.scalars(
            select(AnomalyRuleAudit)
            .where(AnomalyRuleAudit.rule_id == rule.id)
            .order_by(AnomalyRuleAudit.created_at.desc())
        ).all()
        result["audits"] = [
            {
                "action": row.action,
                "version": row.version,
                "reason": row.reason,
                "operator": row.operator,
                "before": row.before,
                "after": row.after,
                "created_at": _iso(row.created_at),
            }
            for row in audits
        ]
        return result

    def preview_rule(self, data: dict[str, Any]) -> dict[str, Any]:
        values = self._validate_rule_data(data)
        now = _now()
        rule = AnomalyRule(
            id=uuid.uuid4(),
            **values,
            version=1,
            created_by="preview",
            updated_by="preview",
            created_at=now,
            updated_at=now,
        )
        hits = self.evidence.detect(rule, now)
        return {
            "matches": len(hits),
            "samples": [
                {
                    "title": hit.title,
                    "summary": hit.summary,
                    "repository": hit.repository,
                    "user_email": hit.user_email,
                }
                for hit in hits[:10]
            ],
        }

    def create_rule(self, data: dict[str, Any], actor: str) -> dict[str, Any]:
        now = _now()
        values = self._validate_rule_data(data)
        duplicate = self.session.scalars(
            select(AnomalyRule.id).where(
                AnomalyRule.detector_type == values["detector_type"],
                AnomalyRule.status != "deleted",
            )
        ).first()
        if duplicate is not None:
            raise ApiError(
                409,
                "RULE_DETECTOR_ALREADY_CONFIGURED",
                "该检测类型已有规则，请在规则管理中编辑",
            )
        rule = AnomalyRule(
            id=uuid.uuid4(),
            **values,
            version=1,
            created_by=actor,
            updated_by=actor,
            created_at=now,
            updated_at=now,
        )
        try:
            with self.session.begin_nested():
                self.session.add(rule)
                self.session.flush()
        except IntegrityError:
            # 上面的预检与插入之间被别的请求抢先建了同一条，按同一种冲突报错。
            raise ApiError(
                409,
                "RULE_DETECTOR_ALREADY_CONFIGURED",
                "该检测类型已有规则，请在规则管理中编辑",
            ) from None
        self._audit(rule, "created", actor, None, _rule_payload(rule), data.get("change_reason"))
        self.session.commit()
        return _rule_payload(rule)

    def update_rule(self, rule_id: uuid.UUID, data: dict[str, Any], actor: str) -> dict[str, Any]:
        rule = self._rule(rule_id)
        if rule.status == "deleted":
            raise ApiError(409, "RULE_DELETED", "已删除规则不能编辑")
        before = _rule_payload(rule)
        previous_status = rule.status
        merged = {**before, **data, "params": data.get("params", rule.params)}
        values = self._validate_rule_data(merged)
        for key in (
            "name",
            "category",
            "detector_type",
            "scope_type",
            "scope_value",
            "params",
            "allow_archive",
            "status",
            "change_reason",
        ):
            setattr(rule, key, values[key])
        rule.version += 1
        rule.updated_by = actor
        rule.updated_at = _now()
        if previous_status == "enabled" and rule.status != "enabled":
            self._close_rule_events(rule.id, "rule_disabled", actor)
        self._audit(rule, "updated", actor, before, _rule_payload(rule), rule.change_reason)
        self.session.commit()
        return _rule_payload(rule)

    def change_rule_status(
        self, rule_id: uuid.UUID, status: str, reason: str, actor: str
    ) -> dict[str, Any]:
        if status not in {"enabled", "disabled"}:
            raise ApiError(400, "RULE_STATUS_INVALID", "规则只能启用或停用")
        rule = self._rule(rule_id)
        before = _rule_payload(rule)
        rule.status = status
        rule.version += 1
        rule.change_reason = reason.strip()
        rule.updated_by = actor
        rule.updated_at = _now()
        if status == "disabled":
            self._close_rule_events(rule.id, "rule_disabled", actor)
        self._audit(rule, status, actor, before, _rule_payload(rule), reason)
        self.session.commit()
        return _rule_payload(rule)

    def delete_rule(self, rule_id: uuid.UUID, reason: str, actor: str) -> dict[str, Any]:
        rule = self._rule(rule_id)
        before = _rule_payload(rule)
        rule.status = "deleted"
        rule.version += 1
        rule.change_reason = reason.strip()
        rule.updated_by = actor
        rule.updated_at = _now()
        self._close_rule_events(rule.id, "rule_deleted", actor)
        self._audit(rule, "deleted", actor, before, _rule_payload(rule), reason)
        self.session.commit()
        return {"id": str(rule.id), "deleted": True}

    def evaluate(
        self, rule_id: uuid.UUID | None = None, *, dry_run: bool = False
    ) -> dict[str, Any]:
        statement = select(AnomalyRule).where(AnomalyRule.status == "enabled")
        if rule_id:
            statement = statement.where(AnomalyRule.id == rule_id)
        rules = self.session.scalars(statement).all()
        now = _now()
        results = []
        for rule in rules:
            hits = self.evidence.detect(rule, now)
            results.append(
                {
                    "rule_id": str(rule.id),
                    "matches": len(hits),
                    "samples": [hit.summary for hit in hits[:5]],
                }
            )
            if not dry_run:
                self._apply_hits(rule, hits, now)
                rule.last_evaluated_at = now
                rule.last_match_count = len(hits)
        if not dry_run:
            self.session.commit()
        return {
            "rules": len(rules),
            "matches": sum(row["matches"] for row in results),
            "items": results,
            "dry_run": dry_run,
        }

    def list_events(
        self,
        *,
        ai_master_id: uuid.UUID | None = None,
        include_closed: bool = False,
        admin_view: bool = False,
        category: str | None = None,
    ) -> dict[str, Any]:
        statement = select(AnomalyEvent)
        if ai_master_id is not None:
            statement = statement.where(AnomalyEvent.ai_master_id == ai_master_id)
        elif not admin_view:
            statement = statement.where(AnomalyEvent.ai_master_id.is_not(None))
        if not include_closed:
            statement = statement.where(
                AnomalyEvent.detection_status == "active",
                AnomalyEvent.disposition.in_(["open", "archive_pending"]),
            )
        if category:
            statement = statement.where(AnomalyEvent.category == category)
        events = self.session.scalars(
            statement.order_by(AnomalyEvent.last_detected_at.desc())
        ).all()
        return {"items": [self._event_payload(event) for event in events], "total": len(events)}

    def summary(
        self, ai_master_id: uuid.UUID | None = None, *, admin_view: bool = False
    ) -> dict[str, Any]:
        items = self.list_events(ai_master_id=ai_master_id, admin_view=admin_view)["items"]
        categories = {key: 0 for key in ("component", "workflow", "attribution", "version")}
        pending = 0
        for item in items:
            categories[item["category"]] += 1
            pending += item["disposition"] == "archive_pending"
        return {"open": len(items), "archive_pending": pending, "categories": categories}

    def event_detail(self, event_id: uuid.UUID) -> dict[str, Any]:
        event = self._event(event_id)
        payload = self._event_payload(event)
        payload["actions"] = [
            self._action_payload(row)
            for row in self.session.scalars(
                select(AnomalyAction)
                .where(AnomalyAction.event_id == event.id)
                .order_by(AnomalyAction.created_at)
            ).all()
        ]
        request = self.session.scalar(
            select(AnomalyArchiveRequest)
            .where(AnomalyArchiveRequest.event_id == event.id)
            .order_by(AnomalyArchiveRequest.created_at.desc())
        )
        payload["archive_request"] = self._archive_payload(request) if request else None
        link = self.session.get(AnomalyIssueLink, event.id)
        payload["issue_id"] = str(link.issue_id) if link else None
        return payload

    def request_archive(
        self, event_id: uuid.UUID, reason: str, requested_by: str
    ) -> dict[str, Any]:
        event = self._event_for_action(event_id)
        rule = self._rule(event.rule_id)
        if not rule.allow_archive:
            raise ApiError(409, "ARCHIVE_NOT_ALLOWED", "该检测规则不允许申请屏蔽")
        target_type = {
            "workflow": "workflow",
            "dev_run": "dev_run",
            "attribution": "attribution",
        }.get(event.object_type, "event")
        target_id = event.object_key if target_type != "event" else str(event.id)
        reason = reason.strip()
        if not reason:
            raise ApiError(400, "ARCHIVE_REASON_REQUIRED", "归档理由不能为空")
        now = _now()
        request = AnomalyArchiveRequest(
            id=uuid.uuid4(),
            event_id=event.id,
            source="event",
            target_type=target_type,
            target_id=target_id,
            reason=reason,
            impact_preview=self.archive.preview(target_type, target_id),
            status="pending",
            requested_by=requested_by.strip() or "AI Master",
            created_at=now,
        )
        event.disposition = "archive_pending"
        event.updated_at = now
        self.session.add_all(
            [
                request,
                self._action(event, "archive_requested", request.requested_by, {"reason": reason}),
            ]
        )
        self.session.commit()
        return self._archive_payload(request)

    def request_archive_for_target(
        self,
        target_type: str,
        target_id: uuid.UUID,
        *,
        reason: str,
        requested_by: str,
    ) -> dict[str, Any]:
        """业务页（工作流/归因）直接对数据对象发起屏蔽申请，无异常事件。

        target_type ∈ workflow / dev_run / attribution；与事件发起的申请
        走同一张屏蔽审核清单和同一条审核通道。
        """
        if target_type not in ("workflow", "dev_run", "attribution"):
            raise ApiError(400, "ARCHIVE_NOT_SUPPORTED", "该对象不支持申请屏蔽")
        reason = reason.strip()
        if not reason:
            raise ApiError(400, "ARCHIVE_REASON_REQUIRED", "屏蔽理由不能为空")
        target_key = str(target_id)
        existing = self.session.scalar(
            select(AnomalyArchiveRequest).where(
                AnomalyArchiveRequest.target_type == target_type,
                AnomalyArchiveRequest.target_id == target_key,
                AnomalyArchiveRequest.status == "pending",
            )
        )
        if existing is not None:
            raise ApiError(409, "ARCHIVE_REQUEST_EXISTS", "该数据已有待审核的屏蔽申请")
        now = _now()
        request = AnomalyArchiveRequest(
            id=uuid.uuid4(),
            event_id=None,
            source="admin_console",
            target_type=target_type,
            target_id=target_key,
            reason=reason,
            impact_preview=self.archive.preview(target_type, target_key),
            status="pending",
            requested_by=requested_by.strip() or "运营管理员",
            created_at=now,
        )
        self.session.add(request)
        self.session.commit()
        return self._archive_payload(request)

    def review_archive(
        self, request_id: uuid.UUID, *, approved: bool, note: str, actor: str
    ) -> dict[str, Any]:
        request = self.session.get(AnomalyArchiveRequest, request_id)
        if request is None:
            raise ApiError(404, "ARCHIVE_REQUEST_NOT_FOUND", "归档申请不存在")
        if request.status != "pending":
            raise ApiError(409, "ARCHIVE_REQUEST_FINISHED", "归档申请已经处理")
        now = _now()
        request.reviewed_by = actor
        request.reviewed_at = now
        request.review_note = note.strip() or None
        if approved:
            self.archive.archive(request.target_type, request.target_id, request.reason, actor, now)
            request.status = "approved"
            action = "archive_approved"
        else:
            if not note.strip():
                raise ApiError(400, "REVIEW_NOTE_REQUIRED", "拒绝归档时必须填写理由")
            request.status = "rejected"
            action = "archive_rejected"
        event = self.session.get(AnomalyEvent, request.event_id) if request.event_id else None
        if event is not None:
            if approved:
                event.disposition = "archived"
                event.detection_status = "recovered"
                event.closed_reason = "data_archived"
                event.active_key = None
                event.recovered_at = now
            else:
                event.disposition = "open"
            event.updated_at = now
            self.session.add(self._action(event, action, actor, {"note": note.strip()}))
        self.session.commit()
        return self._archive_payload(request)

    def list_archive_requests(self, status: str | None = None) -> dict[str, Any]:
        statement = select(AnomalyArchiveRequest)
        if status:
            statement = statement.where(AnomalyArchiveRequest.status == status)
        rows = self.session.scalars(
            statement.order_by(AnomalyArchiveRequest.created_at.desc())
        ).all()
        context = self._archive_target_context(rows)
        return {
            "items": [
                {**self._archive_payload(row), "target_context": context.get(str(row.target_id))}
                for row in rows
            ]
        }

    def _archive_target_context(
        self, rows: list[AnomalyArchiveRequest]
    ) -> dict[str, dict[str, str | None]]:
        """屏蔽对象的可读上下文（仓库 / SR）：审核列表只给裸 UUID 认不出是什么。

        attribution 的 target_id 是归因行的 dev_run_id，与 dev_run 同路反查。
        """
        wf_ids: set[uuid.UUID] = set()
        dev_ids: set[uuid.UUID] = set()
        for row in rows:
            try:
                target = uuid.UUID(str(row.target_id))
            except ValueError:
                continue
            if row.target_type == "workflow":
                wf_ids.add(target)
            elif row.target_type in ("dev_run", "attribution"):
                dev_ids.add(target)
        found: dict[str, dict[str, str | None]] = {}
        if wf_ids:
            for wf in self.session.scalars(select(WorkflowRun).where(WorkflowRun.id.in_(wf_ids))):
                found[str(wf.id)] = {"repository": wf.project_key, "sr": wf.sr}
        if dev_ids:
            for dev in self.session.scalars(select(DevRun).where(DevRun.id.in_(dev_ids))):
                wf = self.session.get(WorkflowRun, dev.workflow_run_id)
                if wf is not None:
                    found[str(dev.id)] = {"repository": wf.project_key, "sr": wf.sr}
        return found

    def create_issue(
        self, event_id: uuid.UUID, *, suggestion: str, reporter: str, assignee: str
    ) -> dict[str, Any]:
        event = self._event_for_action(event_id)
        if self.session.get(AnomalyIssueLink, event.id):
            raise ApiError(409, "ANOMALY_ISSUE_EXISTS", "该异常已经生成问题记录")
        if assignee not in ISSUE_ASSIGNEES:
            raise ApiError(400, "INVALID_ASSIGNEE", "问题负责人不在支持列表中")
        suggestion = suggestion.strip()
        if not suggestion:
            raise ApiError(400, "ISSUE_SUGGESTION_REQUIRED", "请填写优化建议")
        now = _now()
        reporter = reporter.strip() or "AI Master"
        issue = self.issue_board.create(event, suggestion, reporter, assignee, now)
        self.session.add_all(
            [
                AnomalyIssueLink(
                    event_id=event.id,
                    issue_id=issue.id,
                    created_by=reporter,
                    created_at=now,
                ),
                self._action(
                    event,
                    "issue_created",
                    reporter,
                    {"issue_id": str(issue.id)},
                ),
            ]
        )
        event.disposition = "issue_created"
        event.updated_at = now
        self.session.commit()
        return {"issue_id": str(issue.id), "event_id": str(event.id), "status": issue.status}

    def _apply_hits(self, rule: AnomalyRule, hits: list[DetectorHit], now: datetime) -> None:
        existing = {
            row.active_key: row
            for row in self.session.scalars(
                select(AnomalyEvent).where(
                    AnomalyEvent.rule_id == rule.id, AnomalyEvent.active_key.is_not(None)
                )
            ).all()
        }
        matched: set[str] = set()
        owners = self.ownership.by_repository()
        for hit in hits:
            key = _active_key(rule.id, hit.object_type, hit.object_key)
            matched.add(key)
            event = existing.get(key)
            if event is None:
                occurrence = (
                    self.session.scalar(
                        select(func.max(AnomalyEvent.occurrence)).where(
                            AnomalyEvent.rule_id == rule.id,
                            AnomalyEvent.object_type == hit.object_type,
                            AnomalyEvent.object_key == hit.object_key,
                        )
                    )
                    or 0
                ) + 1
                event = AnomalyEvent(
                    id=uuid.uuid4(),
                    rule_id=rule.id,
                    rule_version=rule.version,
                    rule_snapshot=self._snapshot(rule),
                    category=rule.category,
                    detector_type=rule.detector_type,
                    object_type=hit.object_type,
                    object_key=hit.object_key,
                    occurrence=occurrence,
                    active_key=key,
                    detection_status="active",
                    disposition="open",
                    first_detected_at=now,
                    last_detected_at=now,
                    hit_count=1,
                    updated_at=now,
                    title=hit.title,
                    summary=hit.summary,
                    evidence=hit.evidence or {},
                    detail_target=hit.detail_target or {},
                )
                try:
                    with self.session.begin_nested():
                        self.session.add(event)
                        self.session.flush()
                except IntegrityError:
                    event = self.session.scalar(
                        select(AnomalyEvent).where(AnomalyEvent.active_key == key)
                    )
                    if event is None:
                        raise
                else:
                    self.session.add(
                        self._action(event, "detected", "系统检测", {"rule_version": rule.version})
                    )
            else:
                event.rule_version = rule.version
                event.rule_snapshot = self._snapshot(rule)
                event.last_detected_at = now
                event.hit_count += 1
                event.updated_at = now
            event.repository = hit.repository
            event.component_id = hit.component_id
            event.user_email = hit.user_email
            event.ai_master_id = owners.get(hit.repository or "")
            event.title = hit.title
            event.summary = hit.summary
            event.actual_value = hit.actual_value
            event.threshold_value = hit.threshold_value
            event.evidence = hit.evidence or {}
            event.detail_target = hit.detail_target or {}
        for key, event in existing.items():
            if key not in matched:
                self._recover_event(event, now, "condition_recovered")

    def _recover_event(self, event: AnomalyEvent, now: datetime, reason: str) -> None:
        event.detection_status = "recovered"
        event.closed_reason = reason
        event.active_key = None
        event.recovered_at = now
        event.updated_at = now
        if event.disposition == "archive_pending":
            request = self.session.scalar(
                select(AnomalyArchiveRequest).where(
                    AnomalyArchiveRequest.event_id == event.id,
                    AnomalyArchiveRequest.status == "pending",
                )
            )
            if request:
                request.status = "cancelled"
                request.review_note = "异常已自行恢复，申请自动取消"
                request.reviewed_at = now
            event.disposition = "open"
        self.session.add(self._action(event, "recovered", "系统检测", {"reason": reason}))

    def _close_rule_events(self, rule_id: uuid.UUID, reason: str, actor: str) -> None:
        now = _now()
        rows = self.session.scalars(
            select(AnomalyEvent).where(
                AnomalyEvent.rule_id == rule_id, AnomalyEvent.active_key.is_not(None)
            )
        ).all()
        for event in rows:
            self._recover_event(event, now, reason)

    @staticmethod
    def _snapshot(rule: AnomalyRule) -> dict[str, Any]:
        return {
            "name": rule.name,
            "version": rule.version,
            "detector_type": rule.detector_type,
            "scope_type": rule.scope_type,
            "scope_value": rule.scope_value,
            "params": rule.params,
            "allow_archive": rule.allow_archive,
        }

    def _validate_rule_data(self, data: dict[str, Any]) -> dict[str, Any]:
        detector_type = str(data.get("detector_type", ""))
        spec = DETECTOR_SPECS.get(detector_type)
        if spec is None:
            raise ApiError(400, "DETECTOR_TYPE_INVALID", "未知异常检测类型")
        name = str(data.get("name", "")).strip()
        if not name or len(name) > 128:
            raise ApiError(400, "RULE_NAME_INVALID", "规则名称不能为空且不能超过 128 字")
        category = str(data.get("category") or spec.category)
        if category != spec.category:
            raise ApiError(400, "RULE_CATEGORY_MISMATCH", "异常分类与检测类型不匹配")
        scope_type = str(data.get("scope_type", "platform"))
        scope_value = str(data.get("scope_value") or "").strip() or None
        if scope_type not in {"platform", "component", "repository"}:
            raise ApiError(400, "RULE_SCOPE_INVALID", "规则生效范围无效")
        if scope_type != "platform" and not scope_value:
            raise ApiError(400, "RULE_SCOPE_VALUE_REQUIRED", "指定范围时必须选择范围对象")
        params = {**spec.defaults, **(data.get("params") or {})}
        unknown = set(params) - set(spec.defaults)
        if unknown:
            raise ApiError(
                400, "RULE_PARAMS_INVALID", f"检测参数不支持：{', '.join(sorted(unknown))}"
            )
        for key, default in spec.defaults.items():
            value = params[key]
            if (
                isinstance(default, (int, float))
                and not isinstance(default, bool)
                and float(value) <= 0
            ):
                raise ApiError(400, "RULE_PARAMS_INVALID", f"参数 {key} 必须大于 0")
            if isinstance(default, list) and not isinstance(value, list):
                raise ApiError(400, "RULE_PARAMS_INVALID", f"参数 {key} 必须是列表")
        status = str(data.get("status", "draft"))
        if status not in {"draft", "enabled", "disabled"}:
            raise ApiError(400, "RULE_STATUS_INVALID", "规则状态无效")
        return {
            "name": name,
            "category": category,
            "detector_type": detector_type,
            "scope_type": scope_type,
            "scope_value": scope_value,
            "params": params,
            "allow_archive": bool(data.get("allow_archive", True)),
            "status": status,
            "change_reason": str(data.get("change_reason") or "").strip() or None,
        }

    def _rule(self, rule_id: uuid.UUID) -> AnomalyRule:
        rule = self.session.get(AnomalyRule, rule_id)
        if rule is None:
            raise ApiError(404, "ANOMALY_RULE_NOT_FOUND", "异常规则不存在")
        return rule

    def _event(self, event_id: uuid.UUID) -> AnomalyEvent:
        event = self.session.get(AnomalyEvent, event_id)
        if event is None:
            raise ApiError(404, "ANOMALY_EVENT_NOT_FOUND", "异常事件不存在")
        return event

    def _event_for_action(self, event_id: uuid.UUID) -> AnomalyEvent:
        event = self._event(event_id)
        if event.detection_status != "active" or event.disposition != "open":
            raise ApiError(409, "ANOMALY_EVENT_NOT_ACTIONABLE", "异常当前不能执行该处理动作")
        return event

    def _audit(
        self,
        rule: AnomalyRule,
        action: str,
        actor: str,
        before: dict | None,
        after: dict | None,
        reason: str | None,
    ) -> None:
        self.session.add(
            AnomalyRuleAudit(
                id=uuid.uuid4(),
                rule_id=rule.id,
                action=action,
                version=rule.version,
                before=_jsonable(before),
                after=_jsonable(after),
                reason=reason,
                operator=actor,
                created_at=_now(),
            )
        )

    @staticmethod
    def _action(event: AnomalyEvent, action: str, actor: str, details: dict) -> AnomalyAction:
        return AnomalyAction(
            id=uuid.uuid4(),
            event_id=event.id,
            action=action,
            actor=actor,
            details=details,
            created_at=_now(),
        )

    def _latest_user_names(self) -> dict[str, str]:
        """邮箱 → 最近一次上报使用的姓名。异常只存了邮箱，列表要按人显示。

        同一邮箱可能换过 git 配置对应多个姓名，取最近活动的那条。
        每个请求周期只查一次。
        """
        if self._user_names is None:
            rows = self.session.execute(
                select(
                    WorkflowRun.git_user_email,
                    WorkflowRun.git_user_name,
                    func.max(WorkflowRun.last_activity_at),
                ).group_by(WorkflowRun.git_user_email, WorkflowRun.git_user_name)
            ).all()
            names: dict[str, str] = {}
            stamps: dict[str, datetime] = {}
            for email, name, last_at in rows:
                if not email or not name:
                    continue
                if email not in stamps or (last_at or datetime.min) > stamps[email]:
                    stamps[email] = last_at or datetime.min
                    names[email] = name
            self._user_names = names
        return self._user_names

    def _event_payload(self, event: AnomalyEvent) -> dict[str, Any]:
        master = self.session.get(AiMaster, event.ai_master_id) if event.ai_master_id else None
        rule = self.session.get(AnomalyRule, event.rule_id)
        return {
            "id": str(event.id),
            "rule_id": str(event.rule_id),
            "rule_version": event.rule_version,
            "rule": event.rule_snapshot,
            "category": event.category,
            "detector_type": event.detector_type,
            "object_type": event.object_type,
            "object_key": event.object_key,
            "occurrence": event.occurrence,
            "component_id": event.component_id,
            "repository": event.repository,
            "user_email": event.user_email,
            "user_name": self._latest_user_names().get(event.user_email or ""),
            "ai_master_id": str(event.ai_master_id) if event.ai_master_id else None,
            "ai_master_name": master.name if master else None,
            "title": event.title,
            "summary": event.summary,
            "actual_value": event.actual_value,
            "threshold_value": event.threshold_value,
            "evidence": event.evidence,
            "detail_target": event.detail_target,
            "detection_status": event.detection_status,
            "disposition": event.disposition,
            "closed_reason": event.closed_reason,
            "archive_supported": bool(rule and rule.allow_archive),
            "archive_request": self._pending_archive_request(event),
            "first_detected_at": _iso(event.first_detected_at),
            "last_detected_at": _iso(event.last_detected_at),
            "recovered_at": _iso(event.recovered_at),
            "hit_count": event.hit_count,
        }

    def _pending_archive_request(self, event: AnomalyEvent) -> dict[str, Any] | None:
        """屏蔽待审期间，行内状态与申请信息要一起给出；只有事件停在待审态才查。"""
        if event.disposition != "archive_pending":
            return None
        request = self.session.scalars(
            select(AnomalyArchiveRequest)
            .where(
                AnomalyArchiveRequest.event_id == event.id,
                AnomalyArchiveRequest.status == "pending",
            )
            .order_by(AnomalyArchiveRequest.created_at.desc())
            .limit(1)
        ).first()
        return self._archive_payload(request) if request else None

    @staticmethod
    def _archive_payload(request: AnomalyArchiveRequest) -> dict[str, Any]:
        return {
            "id": str(request.id),
            "event_id": str(request.event_id) if request.event_id else None,
            "source": request.source,
            "target_type": request.target_type,
            "target_id": request.target_id,
            "reason": request.reason,
            "impact_preview": request.impact_preview,
            "status": request.status,
            "requested_by": request.requested_by,
            "reviewed_by": request.reviewed_by,
            "review_note": request.review_note,
            "created_at": _iso(request.created_at),
            "reviewed_at": _iso(request.reviewed_at),
        }

    @staticmethod
    def _action_payload(action: AnomalyAction) -> dict[str, Any]:
        return {
            "id": str(action.id),
            "action": action.action,
            "actor": action.actor,
            "details": action.details,
            "created_at": _iso(action.created_at),
        }
