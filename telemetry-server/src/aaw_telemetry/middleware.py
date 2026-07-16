from __future__ import annotations

import logging
import time
import uuid

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .logging import request_id_var

logger = logging.getLogger(__name__)


class RequestBodyLimitMiddleware:
    def __init__(self, app: ASGIApp, max_bytes: int, max_object_bytes: int):
        self.app = app
        self.max_bytes = max_bytes
        self.max_object_bytes = max_object_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        limit = (
            self.max_object_bytes
            if scope.get("method") == "PUT"
            and scope.get("path", "").startswith("/api/v1/objects/step-diffs/")
            else self.max_bytes
        )
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
            "http.request_rejected",
            extra={
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
            logger.log(
                level,
                "http.request_completed",
                extra={
                    "method": scope.get("method"),
                    "path": scope.get("path"),
                    "status_code": status_code,
                    "duration_ms": duration_ms,
                },
            )
            request_id_var.reset(token)
