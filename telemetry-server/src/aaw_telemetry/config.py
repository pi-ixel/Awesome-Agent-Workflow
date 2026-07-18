from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit

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

    display_name: str = Field(default="", max_length=200)
    platform: str = Field(default="", max_length=32)
    platform_project_id: str = Field(default="", max_length=128)
    canonical_url: str = Field(min_length=1, max_length=2048)
    target_branch: str = Field(default="master", min_length=1, max_length=512)
    enabled: bool = True
    aliases: list[str] = Field(default_factory=list, max_length=100)


class ProjectsDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")

    projects: dict[str, ProjectEntry]

    @model_validator(mode="after")
    def validate_uniqueness(self) -> ProjectsDocument:
        platform_ids: dict[tuple[str, str], str] = {}
        identities: dict[str, str] = {}
        for key, project in self.projects.items():
            if project.platform and project.platform_project_id:
                pair = (project.platform.lower(), project.platform_project_id)
                if pair in platform_ids:
                    raise ValueError(
                        f"duplicate platform project id for {key} and {platform_ids[pair]}"
                    )
                platform_ids[pair] = key
            for raw in [project.canonical_url, *project.aliases]:
                identity = normalize_remote(raw)
                if identity in identities and identities[identity] != key:
                    raise ValueError(
                        "remote identity "
                        f"{identity!r} maps to both {key} and {identities[identity]}"
                    )
                identities[identity] = key
        return self


_SCP_REMOTE = re.compile(r"^(?:[^@/\s]+@)?([^:/\s]+):(.+)$")


def normalize_remote(raw: str) -> str:
    """Normalize an SSH/HTTPS Git remote without retaining credentials."""
    value = raw.strip().replace("\\", "/")
    scp_match = _SCP_REMOTE.match(value) if "://" not in value else None
    if scp_match:
        host, path = scp_match.groups()
    elif "://" in value:
        parsed = urlsplit(value)
        host = (parsed.hostname or "").lower()
        path = parsed.path
    else:
        host = ""
        path = value
    path = re.sub(r"/+", "/", path).strip("/")
    if path.lower().endswith(".git"):
        path = path[:-4]
    if not path:
        raise ValueError("remote has no repository path")
    return f"{host.lower()}/{path.lower()}" if host else path.lower()


@dataclass(frozen=True)
class ResolvedProject:
    key: str
    entry: ProjectEntry


class ProjectRegistry:
    def __init__(self, document: ProjectsDocument):
        self.document = document
        self._identities: dict[str, str] = {}
        self._repository_names: dict[str, set[str]] = {}
        for key, project in document.projects.items():
            for value in [project.canonical_url, *project.aliases]:
                identity = normalize_remote(value)
                self._identities[identity] = key
                name = identity.rsplit("/", 1)[-1]
                self._repository_names.setdefault(name, set()).add(key)

    @classmethod
    def load(cls, path: Path) -> ProjectRegistry:
        path = _resolve_config_path(path)
        with path.open("r", encoding="utf-8") as stream:
            raw = yaml.safe_load(stream) or {}
        return cls(ProjectsDocument.model_validate(raw))

    def resolve(self, remotes: list[str]) -> ResolvedProject | None:
        matches = {
            self._identities[identity]
            for remote in remotes
            if (identity := normalize_remote(remote)) in self._identities
        }
        if len(matches) == 1:
            key = matches.pop()
            return ResolvedProject(key, self.document.projects[key])
        if matches:
            return None
        name_matches: set[str] = set()
        for remote in remotes:
            name = normalize_remote(remote).rsplit("/", 1)[-1]
            candidates = self._repository_names.get(name, set())
            if len(candidates) == 1:
                name_matches.update(candidates)
            elif len(candidates) > 1:
                return None
        if len(name_matches) == 1:
            key = name_matches.pop()
            return ResolvedProject(key, self.document.projects[key])
        return None
