from __future__ import annotations

import re
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import FileResponse

from ..config import Settings
from ..errors import ApiError
from ..schemas import ClientReleaseResponse

VERSION_PATTERN = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
RELEASE_FILE_PATTERN = re.compile(
    r"^aaw-skills-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\.zip$"
)


def _find_latest_release(release_dir: Path | None) -> tuple[str, Path] | None:
    if release_dir is None or not release_dir.is_dir():
        return None
    latest: tuple[tuple[int, int, int], str, Path] | None = None
    for path in release_dir.iterdir():
        if not path.is_file():
            continue
        match = RELEASE_FILE_PATTERN.fullmatch(path.name)
        if match is None:
            continue
        version = match.group(1)
        key = tuple(int(part) for part in version.split("."))
        if latest is None or key > latest[0]:
            latest = (key, version, path)
    if latest is None:
        return None
    return latest[1], latest[2]


def build_releases_router(settings: Settings) -> APIRouter:
    router = APIRouter(prefix="/api/v1/client", tags=["client"])

    @router.get(
        "/release",
        response_model=ClientReleaseResponse,
        summary="查询最新客户端发布版本",
        description=(
            "扫描配置的发布目录，返回版本号最大的 `aaw-skills-<version>.zip`。"
            "目录未配置、不存在或没有合法发布包时 `latest_version` 为 null。"
        ),
    )
    def latest_release() -> ClientReleaseResponse:
        latest = _find_latest_release(settings.release_dir)
        if latest is None:
            return ClientReleaseResponse(latest_version=None)
        version, path = latest
        stat = path.stat()
        released_at = datetime.fromtimestamp(stat.st_mtime, UTC).replace(microsecond=0)
        return ClientReleaseResponse(
            latest_version=version,
            file_name=path.name,
            size_bytes=stat.st_size,
            released_at=released_at.isoformat().replace("+00:00", "Z"),
        )

    @router.get(
        "/releases/{version}/download/{file_name}",
        summary="下载指定版本的客户端发布包",
        description=(
            "`version` 必须是严格三段版本，且 `file_name` 必须精确等于 "
            "`aaw-skills-{version}.zip`；不匹配或文件不存在时返回 404。"
        ),
    )
    def download_release(version: str, file_name: str) -> FileResponse:
        expected = f"aaw-skills-{version}.zip"
        if VERSION_PATTERN.fullmatch(version) is None or file_name != expected:
            raise ApiError(404, "RELEASE_NOT_FOUND", "release does not exist")
        release_dir = settings.release_dir
        path = release_dir / expected if release_dir is not None else None
        if path is None or not path.is_file():
            raise ApiError(404, "RELEASE_NOT_FOUND", "release does not exist")
        return FileResponse(path, filename=expected)

    return router
