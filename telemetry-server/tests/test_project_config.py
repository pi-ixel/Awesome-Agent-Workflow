from __future__ import annotations

import pytest
from pydantic import ValidationError

from aaw_telemetry.config import (
    DatabaseConfig,
    ProjectEntry,
    ProjectRegistry,
    ProjectsDocument,
    Settings,
    normalize_remote,
)


def test_database_config_builds_an_encoded_sqlalchemy_url():
    config = DatabaseConfig(
        host="db.internal.example",
        port=3307,
        database="telemetry",
        username="aaw-user",
        password="p@ss/word",
    )

    assert config.sqlalchemy_url() == (
        "mysql+pymysql://aaw-user:p%40ss%2Fword@db.internal.example:3307/telemetry"
        "?charset=utf8mb4"
    )


def test_settings_load_database_connection_from_yaml(tmp_path):
    path = tmp_path / "database.yaml"
    path.write_text(
        "\n".join(
            [
                "host: 10.20.30.40",
                "port: 3306",
                "database: aaw_prod",
                "username: telemetry_app",
                "password: secret",
                "charset: utf8mb4",
            ]
        ),
        encoding="utf-8",
    )

    settings = Settings(database_config_file=path)

    assert settings.database_config_file == path
    assert settings.database_url == (
        "mysql+pymysql://telemetry_app:secret@10.20.30.40:3306/aaw_prod?charset=utf8mb4"
    )


def test_database_url_override_does_not_require_a_config_file(tmp_path):
    settings = Settings(
        database_config_file=tmp_path / "missing.yaml",
        database_url="sqlite+pysqlite://",
    )

    assert settings.database_url == "sqlite+pysqlite://"


def test_remote_normalization_removes_protocol_credentials_and_git_suffix():
    assert normalize_remote("git@git.example.com:Team/Repo.git") == "git.example.com/team/repo"
    assert (
        normalize_remote("https://user:secret@git.example.com/Team/Repo.git?token=x")
        == "git.example.com/team/repo"
    )


def test_project_config_rejects_cross_project_alias_collision():
    common = "git@git.example.com:team/repo.git"
    with pytest.raises(ValidationError):
        ProjectsDocument(
            projects={
                "one": ProjectEntry(
                    display_name="One",
                    platform="gitlab",
                    platform_project_id="1",
                    canonical_url=common,
                ),
                "two": ProjectEntry(
                    display_name="Two",
                    platform="gitlab",
                    platform_project_id="2",
                    canonical_url="git@git.example.com:team/two.git",
                    aliases=[common],
                ),
            }
        )


def test_repository_name_fallback_requires_unique_match(projects: ProjectRegistry):
    result = projects.resolve(["git@fork.example.net:someone/example-service.git"])
    assert result is not None
    assert result.key == "team/example-service"


def test_project_display_metadata_is_optional():
    document = ProjectsDocument(
        projects={
            "team/minimal": ProjectEntry(
                canonical_url="git@git.example.com:team/minimal.git"
            )
        }
    )

    assert document.projects["team/minimal"].display_name == ""
    assert document.projects["team/minimal"].platform == ""
    assert document.projects["team/minimal"].platform_project_id == ""


def test_request_limit_has_a_safe_minimum():
    with pytest.raises(ValidationError):
        Settings(max_request_bytes=100)
