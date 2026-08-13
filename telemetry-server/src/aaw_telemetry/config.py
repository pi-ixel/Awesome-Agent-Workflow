from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import yaml
from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import URL


def _resolve_config_path(path: Path) -> Path:
    if path.is_absolute() or path.exists():
        return path
    candidate = Path(__file__).resolve().parents[2] / path
    return candidate if candidate.exists() else path


class DatabaseConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    host: str = Field(min_length=1)
    port: int = Field(default=3306, ge=1, le=65535)
    database: str = Field(min_length=1)
    username: str = Field(min_length=1)
    password: SecretStr
    charset: str = Field(default="utf8mb4", min_length=1)

    def sqlalchemy_url(self) -> str:
        return URL.create(
            "mysql+pymysql",
            username=self.username,
            password=self.password.get_secret_value(),
            host=self.host,
            port=self.port,
            database=self.database,
            query={"charset": self.charset},
        ).render_as_string(hide_password=False)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="AAW_TELEMETRY_", extra="ignore")

    database_config_file: Path = Path("config/database.yaml")
    database_url: str | None = None
    projects_file: Path = Path("config/projects.yaml")
    object_storage_dir: Path = Path("data/objects")
    release_dir: Path | None = None
    logging_config_file: Path = Path("config/logging.yaml")
    log_directory: Path | None = None
    log_level: str = "INFO"
    max_request_bytes: int = 1024 * 1024
    max_patch_bytes: int = 10 * 1024 * 1024
    upload_session_seconds: int = 3600
    issue_image_max_bytes: int = 5 * 1024 * 1024
    issue_image_max_count: int = 10
    issue_image_max_total_bytes: int = 20 * 1024 * 1024
    issue_image_max_pixels: int = 25_000_000
    issue_image_max_dimension: int = 12_000
    issue_image_preview_dimension: int = 1_600
    issue_image_temp_seconds: int = 86_400
    issue_image_cleanup_interval_seconds: int = 3_600
    issue_image_temp_quota_bytes: int = 1024 * 1024 * 1024
    issue_image_min_free_bytes: int = 2 * 1024 * 1024 * 1024
    issue_image_uploads_per_minute: int = 20
    attribution_service_url: str = "http://127.0.0.1:8010"
    attribution_timeout_seconds: float = 10.0
    attribution_scan_interval_seconds: float = 3600.0
    attribution_api_token: SecretStr | None = None

    @field_validator("attribution_api_token", mode="before")
    @classmethod
    def empty_attribution_token_is_none(cls, value):
        return None if value == "" else value

    @model_validator(mode="after")
    def load_database_and_validate_limits(self) -> Settings:
        if self.database_url is None:
            path = _resolve_config_path(self.database_config_file)
            with path.open("r", encoding="utf-8") as stream:
                database = DatabaseConfig.model_validate(yaml.safe_load(stream) or {})
            self.database_config_file = path
            self.database_url = database.sqlalchemy_url()
        if self.max_request_bytes < 1024:
            raise ValueError("max_request_bytes must be at least 1024")
        if self.max_patch_bytes < self.max_request_bytes:
            raise ValueError("max_patch_bytes must not be smaller than max_request_bytes")
        if not 60 <= self.upload_session_seconds <= 86400:
            raise ValueError("upload_session_seconds must be between 60 and 86400")
        if self.issue_image_max_bytes < 1024:
            raise ValueError("issue_image_max_bytes must be at least 1024")
        if not 1 <= self.issue_image_max_count <= 100:
            raise ValueError("issue_image_max_count must be between 1 and 100")
        if self.issue_image_max_total_bytes < self.issue_image_max_bytes:
            raise ValueError("issue_image_max_total_bytes must fit at least one image")
        if self.issue_image_max_pixels < 1_000_000:
            raise ValueError("issue_image_max_pixels must be at least 1000000")
        if self.issue_image_max_dimension < 1000:
            raise ValueError("issue_image_max_dimension must be at least 1000")
        if self.issue_image_preview_dimension < 100:
            raise ValueError("issue_image_preview_dimension must be at least 100")
        if not 60 <= self.issue_image_temp_seconds <= 604800:
            raise ValueError("issue_image_temp_seconds must be between 60 and 604800")
        if not 60 <= self.issue_image_cleanup_interval_seconds <= 86400:
            raise ValueError(
                "issue_image_cleanup_interval_seconds must be between 60 and 86400"
            )
        if self.issue_image_temp_quota_bytes < self.issue_image_max_bytes:
            raise ValueError("issue_image_temp_quota_bytes must fit at least one image")
        if self.issue_image_min_free_bytes < 0:
            raise ValueError("issue_image_min_free_bytes must not be negative")
        if not 1 <= self.issue_image_uploads_per_minute <= 1000:
            raise ValueError("issue_image_uploads_per_minute must be between 1 and 1000")
        if not self.attribution_service_url.startswith(("http://", "https://")):
            raise ValueError("attribution_service_url must use http or https")
        if not 0.1 <= self.attribution_timeout_seconds <= 300:
            raise ValueError("attribution_timeout_seconds must be between 0.1 and 300")
        if not 10 <= self.attribution_scan_interval_seconds <= 3600:
            raise ValueError("attribution_scan_interval_seconds must be between 10 and 3600")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()


UNASSIGNED_COMPONENT_ID = "__unassigned__"
UNASSIGNED_COMPONENT_NAME = "未归类组件"


class ProjectEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    canonical_url: str = Field(min_length=1, max_length=2048)
    target_branch: str = Field(default="master", min_length=1, max_length=512)
    enabled: bool = True


class ComponentEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=128)
    se: str | None = Field(default=None, max_length=64)
    repos: dict[str, ProjectEntry] = Field(default_factory=dict)


class ComponentsDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")

    components: dict[str, ComponentEntry]

    @model_validator(mode="after")
    def validate_uniqueness(self) -> ComponentsDocument:
        seen_urls: dict[str, str] = {}
        seen_repos: dict[str, str] = {}
        for component_id, component in self.components.items():
            if component_id == UNASSIGNED_COMPONENT_ID:
                raise ValueError(f"component_id {UNASSIGNED_COMPONENT_ID} is reserved")
            for repo_key, repo in component.repos.items():
                if repo_key in seen_repos:
                    raise ValueError(
                        f"Duplicate repo_key {repo_key}: already declared in "
                        f"component {seen_repos[repo_key]}"
                    )
                seen_repos[repo_key] = component_id
                if repo.canonical_url in seen_urls:
                    raise ValueError(f"Duplicate canonical_url: {repo.canonical_url}")
                seen_urls[repo.canonical_url] = repo_key
        return self


@dataclass(frozen=True)
class ComponentView:
    component_id: str
    name: str
    se: str | None
    repo_keys: tuple[str, ...]


class ProjectRegistry:
    def __init__(self, document: ComponentsDocument):
        self.document = document
        self._alias_to_project: dict[str, ProjectEntry] = {}
        self._canonical_url_to_project: dict[str, ProjectEntry] = {}
        self._repo_to_component: dict[str, str] = {}
        self._components: dict[str, ComponentView] = {}
        for component_id, component in document.components.items():
            for repo_key, repo in component.repos.items():
                self._alias_to_project[repo_key] = repo
                self._canonical_url_to_project[repo.canonical_url] = repo
                self._repo_to_component[repo_key] = component_id
            self._components[component_id] = ComponentView(
                component_id=component_id,
                name=component.name,
                se=component.se,
                repo_keys=tuple(component.repos),
            )

    @classmethod
    def load(cls, path: Path) -> ProjectRegistry:
        path = _resolve_config_path(path)
        with path.open("r", encoding="utf-8") as stream:
            raw = yaml.safe_load(stream) or {}
        if isinstance(raw, dict) and "projects" in raw:
            raise ValueError(
                "projects.yaml 已升级为 components 结构（components -> repos），请参考 README 迁移"
            )
        return cls(ComponentsDocument.model_validate(raw))

    def get(self, project_key: str) -> ProjectEntry | None:
        """Look up project configuration by the reported repository name."""
        return self._alias_to_project.get(project_key)

    def components(self) -> list[ComponentView]:
        """Return every configured component in declaration order."""
        return list(self._components.values())

    def component_of(self, project_key: str) -> str | None:
        """Return the component id owning the reported repository name."""
        return self._repo_to_component.get(project_key)
