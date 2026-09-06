from __future__ import annotations

import logging
from datetime import UTC, datetime

from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..config import (
    ComponentsDocument,
    ProjectRegistry,
    Settings,
    load_components_document,
)
from ..errors import ApiError
from ..models import AiMaster, Component, ComponentAiMaster, ComponentRepo

logger = logging.getLogger("aaw_telemetry.admin.registry")


def _now() -> datetime:
    value = datetime.now(UTC)
    return value.replace(microsecond=(value.microsecond // 1000) * 1000)


class RegistryService:
    """Database-backed registry content with validation and hot reload.

    Every mutation is validated by round-tripping the full proposed state
    through ``ComponentsDocument`` — the same rules that guarded the yaml era
    (reserved ids, unique repo keys, unique canonical urls) — before the
    in-memory registry is swapped.
    """

    def __init__(self, session: Session, registry: ProjectRegistry):
        self.session = session
        self.registry = registry

    # ------------------------------------------------------------------
    # Loading and seeding

    @staticmethod
    def load_document(session: Session) -> ComponentsDocument:
        components: dict[str, dict] = {}
        rows = session.execute(
            select(Component).order_by(Component.position, Component.id)
        ).scalars()
        for component in rows:
            components[component.id] = {
                "name": component.name,
                "se": component.se,
                "repos": {
                    repo.repo_key: {
                        "canonical_url": repo.canonical_url,
                        "target_branch": repo.target_branch,
                        "enabled": repo.enabled,
                    }
                    for repo in component.repos
                },
            }
        return ComponentsDocument.model_validate({"components": components})

    @classmethod
    def load_or_seed(
        cls, session: Session, registry: ProjectRegistry, settings: Settings
    ) -> bool:
        """Point ``registry`` at the database content, seeding from yaml once.

        Returns True when a seed import happened. An empty database and a
        missing/unreadable yaml both end up as an empty registry, which the
        admin page can then fill in.
        """
        if session.execute(select(func.count()).select_from(Component)).scalar_one() > 0:
            registry.replace(cls.load_document(session))
            return False
        try:
            document = load_components_document(settings.projects_file)
        except (OSError, ValueError) as exc:
            logger.warning(
                "注册表为空且 projects.yaml 不可用，跳过种子导入",
                extra={"event": "registry.seed_skipped", "reason": str(exc)},
            )
            registry.replace(ComponentsDocument.model_validate({"components": {}}))
            return False
        cls._persist_document(session, document)
        registry.replace(document)
        logger.info(
            "已从 projects.yaml 导入注册表种子",
            extra={
                "event": "registry.seeded",
                "components": len(document.components),
                "repos": sum(len(c.repos) for c in document.components.values()),
            },
        )
        return True

    # ------------------------------------------------------------------
    # Component CRUD

    def create_component(self, component_id: str, name: str, se: str | None) -> dict:
        if self.session.get(Component, component_id) is not None:
            raise ApiError(409, "COMPONENT_EXISTS", f"组件 {component_id} 已存在")
        position = (
            self.session.execute(select(func.max(Component.position))).scalar_one() or 0
        ) + 1
        now = _now()
        self.session.add(
            Component(
                id=component_id, name=name, se=se, position=position,
                created_at=now, updated_at=now,
            )
        )
        return self._commit_and_reload(
            "registry.component_created", f"组件 {component_id} 已创建", component_id
        )

    def update_component(
        self, component_id: str, name: str | None, se: str | None
    ) -> dict:
        component = self._component(component_id)
        if name is not None:
            component.name = name
        if se is not None:
            component.se = se
        component.updated_at = _now()
        return self._commit_and_reload(
            "registry.component_updated", f"组件 {component_id} 已更新", component_id
        )

    def delete_component(self, component_id: str) -> dict:
        component = self._component(component_id)
        assignment = self.session.execute(
            select(ComponentAiMaster).where(
                ComponentAiMaster.component_id == component_id
            )
        ).scalar_one_or_none()
        if assignment is not None:
            master = self.session.get(AiMaster, assignment.ai_master_id)
            master_name = master.name if master is not None else str(assignment.ai_master_id)
            raise ApiError(
                409,
                "COMPONENT_ASSIGNED",
                f"组件 {component_id} 已被 AI Master {master_name} 认领，请先解除认领",
            )
        self.session.delete(component)
        self.session.flush()
        return self._commit_and_reload(
            "registry.component_deleted", f"组件 {component_id} 已删除", None
        )

    # ------------------------------------------------------------------
    # Repository CRUD

    def create_repo(
        self,
        component_id: str,
        repo_key: str,
        canonical_url: str,
        target_branch: str,
        enabled: bool,
    ) -> dict:
        self._component(component_id)
        if self.session.get(ComponentRepo, repo_key) is not None:
            raise ApiError(409, "REPO_EXISTS", f"仓库 {repo_key} 已存在")
        now = _now()
        self.session.add(
            ComponentRepo(
                repo_key=repo_key,
                component_id=component_id,
                canonical_url=canonical_url,
                target_branch=target_branch,
                enabled=enabled,
                created_at=now,
                updated_at=now,
            )
        )
        return self._commit_and_reload(
            "registry.repo_created",
            f"仓库 {repo_key} 已加入组件 {component_id}",
            component_id,
        )

    def update_repo(
        self,
        component_id: str,
        repo_key: str,
        *,
        canonical_url: str | None,
        target_branch: str | None,
        enabled: bool | None,
    ) -> dict:
        repo = self._repo(component_id, repo_key)
        if canonical_url is not None:
            repo.canonical_url = canonical_url
        if target_branch is not None:
            repo.target_branch = target_branch
        if enabled is not None:
            repo.enabled = enabled
        repo.updated_at = _now()
        return self._commit_and_reload(
            "registry.repo_updated", f"仓库 {repo_key} 已更新", component_id
        )

    def delete_repo(self, component_id: str, repo_key: str) -> dict:
        repo = self._repo(component_id, repo_key)
        self.session.delete(repo)
        self.session.flush()
        return self._commit_and_reload(
            "registry.repo_deleted", f"仓库 {repo_key} 已删除", component_id
        )

    # ------------------------------------------------------------------
    # Snapshot payload for the admin page

    def snapshot(self) -> dict:
        document = self.load_document(self.session)
        assignments = {
            row.component_id: (master.name if master is not None else None)
            for row, master in self.session.execute(
                select(ComponentAiMaster, AiMaster)
                .join(AiMaster, ComponentAiMaster.ai_master_id == AiMaster.id)
            ).all()
        }
        components = []
        for component_id, entry in document.components.items():
            components.append(
                {
                    "id": component_id,
                    "name": entry.name,
                    "se": entry.se,
                    "ai_master": assignments.get(component_id),
                    "repos": [
                        {"repo_key": repo_key, **repo.model_dump()}
                        for repo_key, repo in entry.repos.items()
                    ],
                }
            )
        return {"components": components}

    # ------------------------------------------------------------------
    # Internals

    def _component(self, component_id: str) -> Component:
        component = self.session.get(Component, component_id)
        if component is None:
            raise ApiError(404, "COMPONENT_NOT_FOUND", f"组件 {component_id} 不存在")
        return component

    def _repo(self, component_id: str, repo_key: str) -> ComponentRepo:
        self._component(component_id)
        repo = self.session.get(ComponentRepo, repo_key)
        if repo is None or repo.component_id != component_id:
            raise ApiError(404, "REPO_NOT_FOUND", f"仓库 {repo_key} 不在组件 {component_id} 下")
        return repo

    def _commit_and_reload(
        self, event: str, message: str, component_id: str | None
    ) -> dict:
        try:
            self.session.flush()
            document = self.load_document(self.session)
        except ValidationError as exc:
            self.session.rollback()
            raise ApiError(
                400, "REGISTRY_INVALID", f"注册表校验未通过：{exc.errors()[0]['msg']}"
            ) from exc
        except IntegrityError as exc:
            self.session.rollback()
            raise ApiError(
                400, "REGISTRY_INVALID", "注册表校验未通过：仓库或地址与现有条目冲突"
            ) from exc
        try:
            self.session.commit()
        except Exception as exc:
            self.session.rollback()
            reason = getattr(exc, "orig", None) or exc
            raise ApiError(409, "REGISTRY_CONFLICT", f"注册表写入冲突：{reason}") from exc
        self.registry.replace(document)
        logger.info(message, extra={"event": event, "component_id": component_id})
        return {"message": message, "components": self.snapshot()["components"]}

    @staticmethod
    def _persist_document(session: Session, document: ComponentsDocument) -> None:
        now = _now()
        for position, (component_id, entry) in enumerate(document.components.items()):
            component = Component(
                id=component_id,
                name=entry.name,
                se=entry.se,
                position=position,
                created_at=now,
                updated_at=now,
            )
            component.repos = [
                ComponentRepo(
                    repo_key=repo_key,
                    component_id=component_id,
                    canonical_url=repo.canonical_url,
                    target_branch=repo.target_branch,
                    enabled=repo.enabled,
                    created_at=now,
                    updated_at=now,
                )
                for repo_key, repo in entry.repos.items()
            ]
            session.add(component)
        session.commit()
