from __future__ import annotations

import pytest
from pydantic import ValidationError

from aaw_telemetry.config import (
    UNASSIGNED_COMPONENT_ID,
    ComponentEntry,
    ComponentsDocument,
    DatabaseConfig,
    ProjectEntry,
    ProjectRegistry,
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
        ComponentsDocument(
            components={
                "one": ComponentEntry(
                    name="组件一",
                    repos={"team/one": ProjectEntry(canonical_url=canonical_url)},
                ),
                "two": ComponentEntry(
                    name="组件二",
                    repos={"team/two": ProjectEntry(canonical_url=canonical_url)},
                ),
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
    assert projects.component_of("team/example-service") == "example-component"
    assert projects.component_of("unknown") is None


def test_project_entry_only_keeps_repository_configuration():
    document = ComponentsDocument(
        components={
            "minimal": ComponentEntry(
                name="最小组件",
                repos={
                    "team/minimal": ProjectEntry(
                        canonical_url="git@git.example.com:team/minimal.git"
                    )
                },
            )
        }
    )

    entry = document.components["minimal"].repos["team/minimal"]
    assert entry.model_dump() == {
        "canonical_url": "git@git.example.com:team/minimal.git",
        "target_branch": "master",
        "enabled": True,
    }


def test_component_document_rejects_repo_key_in_two_components():
    with pytest.raises(ValidationError, match="Duplicate repo_key"):
        ComponentsDocument(
            components={
                "alpha": ComponentEntry(
                    name="Alpha",
                    repos={
                        "team/shared": ProjectEntry(
                            canonical_url="git@git.example.com:team/shared.git"
                        )
                    },
                ),
                "beta": ComponentEntry(
                    name="Beta",
                    repos={
                        "team/shared": ProjectEntry(
                            canonical_url="git@git.example.com:team/shared-2.git"
                        )
                    },
                ),
            }
        )


def test_component_document_rejects_reserved_unassigned_id():
    with pytest.raises(ValidationError, match="is reserved"):
        ComponentsDocument(
            components={
                UNASSIGNED_COMPONENT_ID: ComponentEntry(name="不该出现"),
            }
        )


def test_component_entry_rejects_unknown_fields():
    with pytest.raises(ValidationError):
        ComponentEntry(name="示例组件", se="张三", owner="王五")


def test_registry_indexes_components_and_reverse_lookup():
    registry = ProjectRegistry(
        ComponentsDocument(
            components={
                "alpha": ComponentEntry(
                    name="Alpha",
                    se="李四",
                    repos={
                        "team/a": ProjectEntry(
                            canonical_url="git@git.example.com:team/a.git"
                        ),
                        "team/b": ProjectEntry(
                            canonical_url="git@git.example.com:team/b.git"
                        ),
                    },
                ),
                "beta": ComponentEntry(name="Beta"),
            }
        )
    )

    assert [view.component_id for view in registry.components()] == ["alpha", "beta"]
    assert registry.components()[0].repo_keys == ("team/a", "team/b")
    assert registry.components()[0].se == "李四"
    assert registry.component_of("team/a") == "alpha"
    assert registry.component_of("team/b") == "alpha"
    assert registry.component_of("missing") is None


def test_component_se_is_optional():
    document = ComponentsDocument(
        components={
            "alpha": ComponentEntry(
                name="Alpha",
                repos={
                    "team/a": ProjectEntry(
                        canonical_url="git@git.example.com:team/a.git"
                    )
                },
            )
        }
    )

    assert document.components["alpha"].se is None
    assert ProjectRegistry(document).components()[0].se is None


def test_load_rejects_legacy_projects_document(tmp_path):
    path = tmp_path / "projects.yaml"
    path.write_text(
        "\n".join(
            [
                "projects:",
                "  telemetry-smoke:",
                "    canonical_url: https://example.invalid/aaw/telemetry-smoke.git",
                "    target_branch: main",
                "    enabled: true",
            ]
        ),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="已升级为 components 结构"):
        ProjectRegistry.load(path)


def test_request_limit_has_a_safe_minimum():
    with pytest.raises(ValidationError):
        Settings(max_request_bytes=100)


def test_attribution_scan_interval_has_a_safe_minimum():
    with pytest.raises(ValidationError, match="must be between 10 and 3600"):
        Settings(attribution_scan_interval_seconds=9.9)
