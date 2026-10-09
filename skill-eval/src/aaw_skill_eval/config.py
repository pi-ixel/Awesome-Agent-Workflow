from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="AAW_SKILL_EVAL_",
        env_file=".env",
        extra="ignore",
    )

    data_dir: Path = Field(default_factory=lambda: Path.cwd() / ".skill-eval-data")
    host: str = "127.0.0.1"
    port: int = 18110
    codex_command: str = "codex"
    chrys_command: str = "chrys"
    chrys_home: Path | None = None
    default_timeout_seconds: int = 1800
    setup_timeout_seconds: int = 900
    max_skill_bytes: int = 25 * 1024 * 1024

    @property
    def database_url(self) -> str:
        return f"sqlite+pysqlite:///{(self.data_dir / 'skill-eval.db').as_posix()}"

    @property
    def artifacts_dir(self) -> Path:
        return self.data_dir / "artifacts"

    @property
    def snapshots_dir(self) -> Path:
        return self.data_dir / "skill-snapshots"

    @property
    def suites_dir(self) -> Path:
        return self.data_dir / "suites"

    @property
    def workspaces_dir(self) -> Path:
        return self.data_dir / "workspaces"

    @property
    def chrys_config_dir(self) -> Path:
        if self.chrys_home is not None:
            return self.chrys_home.expanduser().resolve()
        if os.name == "nt" and os.environ.get("APPDATA"):
            return Path(os.environ["APPDATA"]) / "chrys"
        config_home = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
        return config_home / "chrys"

    def ensure_directories(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        for path in (
            self.artifacts_dir,
            self.snapshots_dir,
            self.suites_dir,
            self.workspaces_dir,
        ):
            path.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.ensure_directories()
    return settings
