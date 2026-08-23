"""Request-scoped network transport for test workflow telemetry."""

from __future__ import annotations

import ssl
from urllib.request import HTTPSHandler, OpenerDirector, ProxyHandler, build_opener


def build_direct_opener(*, insecure_tls: bool = False) -> OpenerDirector:
    """Build an opener that bypasses proxies only for its own requests."""
    ssl_context = ssl.create_default_context()
    if insecure_tls:
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE
    return build_opener(
        ProxyHandler({}),
        HTTPSHandler(context=ssl_context),
    )
