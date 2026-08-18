from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from conftest import MESSAGE_ID, WORKFLOW_ID, message, sync, upload_diff
from sqlalchemy import select
from sqlalchemy.orm import Session

from aaw_telemetry.models import CodeAttribution, ObjectUpload


def _get_upload(client) -> ObjectUpload:
    with Session(client.app.state.engine) as session:
        return session.scalar(
            select(ObjectUpload).where(ObjectUpload.owner_id == MESSAGE_ID)
        )


def _expire_upload(client, *, attribution_status: str) -> None:
    with Session(client.app.state.engine) as session:
        upload = session.scalar(
            select(ObjectUpload).where(ObjectUpload.owner_id == MESSAGE_ID)
        )
        upload.expires_at = datetime(2025, 1, 15, tzinfo=UTC)
        attribution = session.get(CodeAttribution, MESSAGE_ID)
        attribution.attribution_status = attribution_status
        session.commit()


def test_expired_terminal_diff_is_archived(client):
    payload = message()
    assert sync(client, payload).status_code == 200
    assert upload_diff(client, payload)["status"] == "confirmed"
    _expire_upload(client, attribution_status="finalized_match")

    assert client.app.state.diff_archiver.archive_once() == 1

    root = Path(client.app.state.settings.object_storage_dir)
    assert not (root / f"step-diffs/{MESSAGE_ID}.diff").exists()
    assert (root / "archive" / "step-diffs" / "2025-01" / f"{MESSAGE_ID}.diff").is_file()

    upload = _get_upload(client)
    assert upload.status == "archived"
    assert upload.archived_at is not None
    assert upload.archive_key == f"archive/step-diffs/2025-01/{MESSAGE_ID}.diff"
    detail = client.get(f"/api/v1/workflows/{WORKFLOW_ID}").json()
    assert detail["steps"][0]["file_status"] == "confirmed"


def test_repeated_upload_repairs_an_archived_diff(client):
    payload = message()
    assert sync(client, payload).status_code == 200
    assert upload_diff(client, payload)["status"] == "confirmed"
    _expire_upload(client, attribution_status="finalized_match")
    assert client.app.state.diff_archiver.archive_once() == 1

    upload = _get_upload(client)
    archived_path = Path(client.app.state.settings.object_storage_dir) / upload.archive_key
    archived_path.write_bytes(b"corrupt")

    assert upload_diff(client, payload)["status"] == "confirmed"
    assert archived_path.read_bytes() != b"corrupt"
    assert _get_upload(client).status == "archived"


def test_expired_but_pending_attribution_is_not_archived(client):
    payload = message()
    assert sync(client, payload).status_code == 200
    assert upload_diff(client, payload)["status"] == "confirmed"
    _expire_upload(client, attribution_status="pending")

    assert client.app.state.diff_archiver.archive_once() == 0

    root = Path(client.app.state.settings.object_storage_dir)
    assert (root / f"step-diffs/{MESSAGE_ID}.diff").is_file()
    assert _get_upload(client).status == "confirmed"


def test_unexpired_diff_is_not_archived(client):
    payload = message()
    assert sync(client, payload).status_code == 200
    assert upload_diff(client, payload)["status"] == "confirmed"

    with Session(client.app.state.engine) as session:
        attribution = session.get(CodeAttribution, MESSAGE_ID)
        attribution.attribution_status = "finalized_match"
        session.commit()

    assert client.app.state.diff_archiver.archive_once() == 0
    assert _get_upload(client).status == "confirmed"


def test_missing_diff_is_not_marked_as_archived(client):
    payload = message()
    assert sync(client, payload).status_code == 200
    assert upload_diff(client, payload)["status"] == "confirmed"
    _expire_upload(client, attribution_status="finalized_match")

    root = Path(client.app.state.settings.object_storage_dir)
    (root / f"step-diffs/{MESSAGE_ID}.diff").unlink()

    assert client.app.state.diff_archiver.archive_once() == 0

    upload = _get_upload(client)
    assert upload.status == "confirmed"
    assert upload.archived_at is None
    assert upload.archive_key is None


def test_conflicting_archive_does_not_replace_the_active_diff(client):
    payload = message()
    assert sync(client, payload).status_code == 200
    assert upload_diff(client, payload)["status"] == "confirmed"
    _expire_upload(client, attribution_status="finalized_match")

    root = Path(client.app.state.settings.object_storage_dir)
    active_path = root / f"step-diffs/{MESSAGE_ID}.diff"
    archive_path = root / "archive" / "step-diffs" / "2025-01" / f"{MESSAGE_ID}.diff"
    archive_path.parent.mkdir(parents=True)
    archive_path.write_bytes(b"corrupt")

    assert client.app.state.diff_archiver.archive_once() == 0
    assert active_path.is_file()
    assert archive_path.read_bytes() == b"corrupt"
    assert _get_upload(client).status == "confirmed"
