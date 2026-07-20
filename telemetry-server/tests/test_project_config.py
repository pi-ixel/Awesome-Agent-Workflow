from __future__ import annotations

import pytest
from pydantic import ValidationError

from aaw_telemetry.config import (
    DatabaseConfig,
    ProjectEntry,
    ProjectRegistry,
    ProjectsDocument,
    Settings,
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


def test_project_config_rejects_removed_metadata_fields():
    with pytest.raises(ValidationError):
        ProjectEntry(
            canonical_url="git@git.example.com:team/repo.git",
            display_name="Removed metadata",
        )


def test_project_config_rejects_duplicate_canonical_urls():
    canonical_url = "git@git.example.com:team/shared.git"
    with pytest.raises(ValidationError, match="Duplicate canonical_url"):
        ProjectsDocument(
            projects={
                "team/one": ProjectEntry(canonical_url=canonical_url),
                "team/two": ProjectEntry(canonical_url=canonical_url),
            }
        )


def test_project_registry_looks_up_reported_repository_as_exact_key(
    projects: ProjectRegistry,
):
    result = projects.get("team/example-service")
    assert result is not None
    assert result.target_branch == "main"
    assert projects._alias_to_project == {"team/example-service": result}
    assert projects._canonical_url_to_project == {
        "git@git.company.com:team/example-service.git": result
    }
    assert projects.get("example-service") is None
    assert projects.get("TEAM/EXAMPLE-SERVICE") is None


def test_project_entry_only_keeps_repository_configuration():
    document = ProjectsDocument(
        projects={
            "team/minimal": ProjectEntry(
                canonical_url="git@git.example.com:team/minimal.git"
            )
        }
    )

    entry = document.projects["team/minimal"]
    assert entry.model_dump() == {
        "canonical_url": "git@git.example.com:team/minimal.git",
        "target_branch": "master",
        "enabled": True,
    }


def test_request_limit_has_a_safe_minimum():
    with pytest.raises(ValidationError):
        Settings(max_request_bytes=100)
