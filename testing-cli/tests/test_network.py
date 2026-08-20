from __future__ import annotations

import os
import ssl
from unittest.mock import MagicMock, patch
from urllib.request import HTTPSHandler, ProxyHandler

from testwf.network import configure_direct_transport


def test_configure_direct_transport_bypasses_all_proxies() -> None:
    opener = MagicMock()
    with (
        patch.dict(
            os.environ,
            {
                "HTTP_PROXY": "http://proxy.example.test:8080",
                "https_proxy": "http://proxy.example.test:8080",
                "CUSTOM_PROXY": "socks5://proxy.example.test:1080",
            },
        ),
        patch("testwf.network.build_opener", return_value=opener) as build,
        patch("testwf.network.install_opener") as install,
    ):
        configure_direct_transport()

        assert "HTTP_PROXY" not in os.environ
        assert "https_proxy" not in os.environ
        assert "CUSTOM_PROXY" not in os.environ
        assert os.environ["NO_PROXY"] == "*"
        assert os.environ["no_proxy"] == "*"

    proxy_handler = next(
        handler for handler in build.call_args.args if isinstance(handler, ProxyHandler)
    )
    https_handler = next(
        handler for handler in build.call_args.args if isinstance(handler, HTTPSHandler)
    )
    assert proxy_handler.proxies == {}
    assert https_handler._context.check_hostname is False
    assert https_handler._context.verify_mode == ssl.CERT_NONE
    install.assert_called_once_with(opener)
