"""CLI-wide urllib transport policy."""

from __future__ import annotations

import os
import ssl
from urllib.request import HTTPSHandler, ProxyHandler, build_opener, install_opener


def configure_cli_transport() -> None:
    """Force all urllib requests made by this CLI to connect directly.

    The CLI intentionally bypasses proxies and HTTPS certificate validation for
    the current deployment.  This is process-wide so telemetry and self-update
    traffic follow the same transport policy.
    """
    for name in list(os.environ):
        if name.lower().endswith("_proxy") and name.lower() != "no_proxy":
            os.environ.pop(name, None)
    os.environ["NO_PROXY"] = "*"
    os.environ["no_proxy"] = "*"

    ssl_context = ssl.create_default_context()
    ssl_context.check_hostname = False
    ssl_context.verify_mode = ssl.CERT_NONE
    install_opener(
        build_opener(
            ProxyHandler({}),
            HTTPSHandler(context=ssl_context),
        )
    )
