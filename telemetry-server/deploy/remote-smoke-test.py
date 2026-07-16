"""End-to-end smoke test for the deployed single-Step telemetry contract."""

from __future__ import annotations

import hashlib
import json
import os
import uuid
from datetime import UTC, datetime
from urllib.error import HTTPError
from urllib.request import Request, urlopen

BASE_URL = os.getenv("AAW_SMOKE_BASE_URL", "http://127.0.0.1:18080").rstrip("/")


def request(method: str, path: str, body=None, *, content_type="application/json"):
    data = None
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
    outgoing = Request(
        BASE_URL + path,
        data=data,
        method=method,
        headers={"Content-Type": content_type} if data is not None else {},
    )
    try:
        with urlopen(outgoing, timeout=15) as response:
            payload = response.read()
            return response.status, json.loads(payload) if payload else None
    except HTTPError as exc:
        payload = exc.read()
        return exc.code, json.loads(payload) if payload else None


def main() -> None:
    now = int(datetime.now(UTC).timestamp() * 1000)
    workflow_id = str(uuid.uuid4())
    message_id = str(uuid.uuid4())
    diff = (
        b"diff --git a/smoke.txt b/smoke.txt\n"
        b"--- a/smoke.txt\n+++ b/smoke.txt\n@@ -0,0 +1 @@\n+smoke\n"
    )
    digest = hashlib.sha256(diff).hexdigest()
    message = {
        "message_id": message_id,
        "workflow_id": workflow_id,
        "aaw_version": "remote-smoke",
        "user_email": "smoke@example.com",
        "user_name": "Z30049429",
        "repository": "team/example-service",
        "sr": "SR-REMOTE-SMOKE",
        "started_at": now - 120_000,
        "completed_at": now,
        "updated_at": now,
        "data": {
            "ar": "AR-REMOTE-SMOKE",
            "step_type": "task-dev",
            "status": "done",
            "started_at": now - 60_000,
            "completed_at": now,
            "file": {"file_name": "remote-smoke.diff", "sha256": digest},
        },
    }

    status, accepted = request("POST", "/api/v1/telemetry/sync", message)
    assert status == 200 and accepted["status"] == "accepted", (status, accepted)
    status, duplicate = request("POST", "/api/v1/telemetry/sync", message)
    assert status == 200 and duplicate["status"] == "duplicate", (status, duplicate)

    status, confirmed = request(
        "PUT",
        f"/api/v1/objects/step-diffs/{message_id}",
        diff,
        content_type="application/octet-stream",
    )
    assert status == 200 and confirmed["status"] == "confirmed", (status, confirmed)

    status, detail = request("GET", f"/api/v1/workflows/{workflow_id}")
    assert status == 200, (status, detail)
    step = detail["steps"][0]
    assert step["file_status"] == "confirmed", step
    assert step["attribution"]["algorithm_version"] == "mock-v1", step

    status, attributions = request(
        "GET", "/api/v1/statistics/code-attribution?user_email=smoke@example.com"
    )
    assert status == 200 and attributions["total"] >= 1, (status, attributions)
    print(json.dumps({"status": "passed", "workflow_id": workflow_id}))


if __name__ == "__main__":
    main()
