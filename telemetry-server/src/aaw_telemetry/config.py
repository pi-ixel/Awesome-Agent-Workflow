from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import yaml
from pydantic import BaseModel, ConfigDict, Field, SecretStr, model_validator
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
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()


class ProjectEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    canonical_url: str = Field(min_length=1, max_length=2048)
    target_branch: str = Field(default="master", min_length=1, max_length=512)
    enabled: bool = True


class ProjectsDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")

    projects: dict[str, ProjectEntry]

    @model_validator(mode="after")
    def validate_uniqueness(self) -> ProjectsDocument:
        seen_urls: set[str] = set()
        for project in self.projects.values():
            if project.canonical_url in seen_urls:
                raise ValueError(f"Duplicate canonical_url: {project.canonical_url}")
            seen_urls.add(project.canonical_url)
        return self


class ProjectRegistry:
    def __init__(self, document: ProjectsDocument):
        self.document = document
        self._canonical_url_to_project: dict[str, ProjectEntry] = {
            entry.canonical_url: entry for entry in document.projects.values()
        }
        self._alias_to_project: dict[str, ProjectEntry] = {
            key: entry for key, entry in document.projects.items()
        }

    @classmethod
    def load(cls, path: Path) -> ProjectRegistry:
        path = _resolve_config_path(path)
        with path.open("r", encoding="utf-8") as stream:
            raw = yaml.safe_load(stream) or {}
        return cls(ProjectsDocument.model_validate(raw))

    def get(self, project_key: str) -> ProjectEntry | None:
        """Look up project configuration by the reported repository name."""
        return self._alias_to_project.get(project_key)
