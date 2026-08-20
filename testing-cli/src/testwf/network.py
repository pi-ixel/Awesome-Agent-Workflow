"""Process-wide network policy for the test workflow CLI."""

from __future__ import annotations

import os
import ssl
from urllib.request import HTTPSHandler, ProxyHandler, build_opener, install_opener


def configure_direct_transport() -> None:
    """Force testwf HTTP requests to bypass proxies and TLS verification."""
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
