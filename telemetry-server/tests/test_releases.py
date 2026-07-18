from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool

from aaw_telemetry.config import ProjectRegistry, Settings
from aaw_telemetry.database import Base
from aaw_telemetry.main import create_app

QUERY_URL = "/api/v1/client/release"


@contextmanager
def release_client(
    projects: ProjectRegistry, tmp_path: Path, release_dir: Path | None
) -> Iterator[TestClient]:
    engine = create_engine(
        "sqlite+pysqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    settings = Settings(
        database_url="sqlite+pysqlite://",
        object_storage_dir=tmp_path / "objects",
        release_dir=release_dir,
        log_directory=tmp_path / "logs",
        log_level="INFO",
        max_request_bytes=1024 * 1024,
        max_patch_bytes=2 * 1024 * 1024,
        upload_session_seconds=3600,
    )
    app = create_app(settings, engine=engine, projects=projects)
    with TestClient(app, raise_server_exceptions=False) as test_client:
        yield test_client
    Base.metadata.drop_all(engine)
    engine.dispose()


def make_zip(release_dir: Path, version: str, content: bytes | None = None) -> Path:
    path = release_dir / f"aaw-skills-{version}.zip"
    path.write_bytes(content if content is not None else f"zip-content-{version}".encode())
    return path


def download_url(version: str, file_name: str) -> str:
    return f"/api/v1/client/releases/{version}/download/{file_name}"


def test_latest_release_picks_highest_numeric_version(projects, tmp_path):
    release_dir = tmp_path / "releases"
    release_dir.mkdir()
    make_zip(release_dir, "1.2.0")
    make_zip(release_dir, "1.9.0")
    latest = make_zip(release_dir, "1.10.0")

    with release_client(projects, tmp_path, release_dir) as client:
        response = client.get(QUERY_URL)

    assert response.status_code == 200
    body = response.json()
    assert body["latest_version"] == "1.10.0"
    assert body["file_name"] == "aaw-skills-1.10.0.zip"
    assert body["size_bytes"] == latest.stat().st_size
    expected_mtime = datetime.fromtimestamp(latest.stat().st_mtime, UTC).replace(microsecond=0)
    assert body["released_at"] == expected_mtime.isoformat().replace("+00:00", "Z")


def test_latest_release_ignores_non_conforming_files(projects, tmp_path):
    release_dir = tmp_path / "releases"
    release_dir.mkdir()
    for name in [
        "aaw-skills-01.2.0.zip",  # 前导零
        "aaw-skills-1.2.zip",  # 两段
        "aaw-skills-1.2.3.4.zip",  # 四段
        "aaw-skills-1.2.0.tar.gz",  # 非 zip
        "other-skills-9.9.9.zip",  # 前缀不符
        "aaw-skills-9.9.9.zip.bak",  # 后缀不符
    ]:
        (release_dir / name).write_bytes(b"ignored")
    (release_dir / "nested").mkdir()  # 目录同样忽略
    make_zip(release_dir, "1.1.0")

    with release_client(projects, tmp_path, release_dir) as client:
        response = client.get(QUERY_URL)

    assert response.status_code == 200
    assert response.json()["latest_version"] == "1.1.0"


def test_latest_release_returns_null_when_no_valid_package(projects, tmp_path):
    release_dir = tmp_path / "releases"
    release_dir.mkdir()
    (release_dir / "aaw-skills-1.2.zip").write_bytes(b"ignored")

    with release_client(projects, tmp_path, release_dir) as client:
        response = client.get(QUERY_URL)

    assert response.status_code == 200
    assert response.json() == {
        "latest_version": None,
        "file_name": None,
        "size_bytes": None,
        "released_at": None,
    }


def test_latest_release_returns_null_for_empty_directory(projects, tmp_path):
    release_dir = tmp_path / "releases"
    release_dir.mkdir()

    with release_client(projects, tmp_path, release_dir) as client:
        response = client.get(QUERY_URL)

    assert response.status_code == 200
    assert response.json()["latest_version"] is None


def test_latest_release_returns_null_when_not_configured(projects, tmp_path):
    with release_client(projects, tmp_path, None) as client:
        response = client.get(QUERY_URL)

    assert response.status_code == 200
    assert response.json()["latest_version"] is None


def test_latest_release_returns_null_for_missing_directory(projects, tmp_path):
    with release_client(projects, tmp_path, tmp_path / "missing") as client:
        response = client.get(QUERY_URL)

    assert response.status_code == 200
    assert response.json()["latest_version"] is None


def test_download_serves_zip_bytes_with_attachment_header(projects, tmp_path):
    release_dir = tmp_path / "releases"
    release_dir.mkdir()
    content = b"PK\x03\x04 fake zip payload"
    make_zip(release_dir, "1.2.0", content)

    with release_client(projects, tmp_path, release_dir) as client:
        response = client.get(download_url("1.2.0", "aaw-skills-1.2.0.zip"))

    assert response.status_code == 200
    assert response.content == content
    disposition = response.headers["content-disposition"]
    assert disposition.startswith("attachment")
    assert "aaw-skills-1.2.0.zip" in disposition


def test_download_rejects_mismatched_file_name(projects, tmp_path):
    release_dir = tmp_path / "releases"
    release_dir.mkdir()
    make_zip(release_dir, "1.2.0")
    make_zip(release_dir, "1.3.0")

    with release_client(projects, tmp_path, release_dir) as client:
        crossed = client.get(download_url("1.2.0", "aaw-skills-1.3.0.zip"))
        arbitrary = client.get(download_url("1.2.0", "anything.zip"))

    for response in (crossed, arbitrary):
        assert response.status_code == 404
        assert response.json()["code"] == "RELEASE_NOT_FOUND"


def test_download_rejects_invalid_version(projects, tmp_path):
    release_dir = tmp_path / "releases"
    release_dir.mkdir()

    with release_client(projects, tmp_path, release_dir) as client:
        two_segment = client.get(download_url("1.2", "aaw-skills-1.2.zip"))
        leading_zero = client.get(download_url("01.2.0", "aaw-skills-01.2.0.zip"))
        four_segment = client.get(download_url("1.2.3.4", "aaw-skills-1.2.3.4.zip"))

    for response in (two_segment, leading_zero, four_segment):
        assert response.status_code == 404
        assert response.json()["code"] == "RELEASE_NOT_FOUND"


def test_download_returns_404_when_file_is_missing(projects, tmp_path):
    release_dir = tmp_path / "releases"
    release_dir.mkdir()
    make_zip(release_dir, "1.2.0")

    with release_client(projects, tmp_path, release_dir) as client:
        response = client.get(download_url("9.9.9", "aaw-skills-9.9.9.zip"))

    assert response.status_code == 404
    assert response.json()["code"] == "RELEASE_NOT_FOUND"


def test_download_returns_404_when_not_configured(projects, tmp_path):
    with release_client(projects, tmp_path, None) as client:
        response = client.get(download_url("1.2.0", "aaw-skills-1.2.0.zip"))

    assert response.status_code == 404
    assert response.json()["code"] == "RELEASE_NOT_FOUND"


def test_download_rejects_path_traversal(projects, tmp_path):
    release_dir = tmp_path / "releases"
    release_dir.mkdir()
    make_zip(release_dir, "1.2.0")

    with release_client(projects, tmp_path, release_dir) as client:
        dot_dot = client.get(download_url("1.2.0", "%2e%2e"))
        encoded_dot = client.get(download_url("1.2.0", "aaw-skills-1.2.0.zip%2e%2e"))
        encoded_slash = client.get(download_url("1.2.0", "..%2faaw-skills-1.2.0.zip"))

    assert dot_dot.status_code == 404
    assert dot_dot.json()["code"] == "RELEASE_NOT_FOUND"
    assert encoded_dot.status_code == 404
    assert encoded_dot.json()["code"] == "RELEASE_NOT_FOUND"
    assert encoded_slash.status_code == 404
