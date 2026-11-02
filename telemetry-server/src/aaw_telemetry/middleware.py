from __future__ import annotations

import logging
import time
import uuid

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .logging import request_id_var

logger = logging.getLogger("aaw_telemetry.http")
access_logger = logging.getLogger("aaw_telemetry.http.access")


class RequestBodyLimitMiddleware:
    def __init__(
        self,
        app: ASGIApp,
        max_bytes: int,
        max_object_bytes: int,
        max_issue_image_bytes: int,
        max_desktop_update_bytes: int = 512 * 1024 * 1024,
    ):
        self.max_desktop_update_bytes = max_desktop_update_bytes
        self.app = app
        self.max_bytes = max_bytes
        self.max_object_bytes = max_object_bytes
        self.max_issue_image_bytes = max_issue_image_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        method = scope.get("method")
        path = scope.get("path", "")
        if method == "PUT" and path.startswith("/api/v1/desktop/uploads/"):
            limit = self.max_desktop_update_bytes
        elif method == "PUT" and path.startswith("/api/v1/objects/step-diffs/"):
            limit = self.max_object_bytes
        elif method == "POST" and path == "/api/v1/issues/images":
            # multipart framing and headers need a small allowance beyond the file limit.
            limit = self.max_issue_image_bytes + 64 * 1024
        else:
            limit = self.max_bytes
        content_length = dict(scope.get("headers", [])).get(b"content-length")
        if content_length and int(content_length) > limit:
            await self._reject(send, scope, limit)
            return
        received = 0

        async def limited_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise _PayloadTooLarge
            return message

        try:
            await self.app(scope, limited_receive, send)
        except _PayloadTooLarge:
            await self._reject(send, scope, limit)

    @staticmethod
    async def _reject(send: Send, scope: Scope, limit: int) -> None:
        import json

        request_id = request_id_var.get()
        body = json.dumps(
            {
                "request_id": request_id,
                "code": "PAYLOAD_TOO_LARGE",
                "message": f"request body exceeds {limit} bytes",
                "retryable": False,
            },
            separators=(",", ":"),
        ).encode()
        await send(
            {
                "type": "http.response.start",
                "status": 413,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})
        logger.warning(
            "请求体超过服务端限制，已拒绝处理",
            extra={
                "event": "http.request_rejected",
                "method": scope.get("method"),
                "path": scope.get("path"),
                "error_code": "PAYLOAD_TOO_LARGE",
            },
        )


class _PayloadTooLarge(Exception):
    pass


class RequestContextMiddleware:
    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request_id = f"req-{uuid.uuid4().hex}"
        token = request_id_var.set(request_id)
        started = time.perf_counter()
        status_code = 500

        async def tracked_send(message: Message) -> None:
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = message["status"]
                headers = MutableHeaders(scope=message)
                headers.append("X-Request-ID", request_id)
            await send(message)

        try:
            await self.app(scope, receive, tracked_send)
        finally:
            duration_ms = round((time.perf_counter() - started) * 1000, 2)
            level = (
                logging.ERROR
                if status_code >= 500
                else logging.WARNING
                if status_code >= 400
                else logging.INFO
            )
            method = scope.get("method")
            path = scope.get("path")
            access_logger.log(
                level,
                f"{method} {path} 返回 {status_code}，耗时 {duration_ms} ms",
                extra={
                    "event": "http.request_completed",
                    "method": method,
                    "path": path,
                    "status_code": status_code,
                    "duration_ms": duration_ms,
                    "client_ip": scope.get("client", ("-", 0))[0],
                },
            )
            request_id_var.reset(token)
