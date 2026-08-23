from __future__ import annotations

import json
import os
import ssl
import urllib.request
from unittest.mock import MagicMock, patch
from urllib.request import HTTPSHandler, ProxyHandler

import pytest

from testwf.network import build_direct_opener
from testwf.telemetry import TelemetryClient, _insecure_tls_enabled


def _handlers(build: MagicMock) -> tuple[ProxyHandler, HTTPSHandler]:
    proxy = next(handler for handler in build.call_args.args if isinstance(handler, ProxyHandler))
    https = next(handler for handler in build.call_args.args if isinstance(handler, HTTPSHandler))
    return proxy, https


def test_direct_opener_bypasses_proxies_without_changing_process_state() -> None:
    opener = MagicMock()
    proxy_environment = {
        "HTTP_PROXY": "http://proxy.example.test:8080",
        "https_proxy": "http://proxy.example.test:8080",
        "CUSTOM_PROXY": "socks5://proxy.example.test:1080",
    }
    with (
        patch.dict(os.environ, proxy_environment, clear=True),
        patch("testwf.network.build_opener", return_value=opener) as build,
    ):
        environment_before = dict(os.environ)
        assert build_direct_opener() is opener
        assert dict(os.environ) == environment_before

    proxy, https = _handlers(build)
    assert proxy.proxies == {}
    assert https._context.check_hostname is True
    assert https._context.verify_mode == ssl.CERT_REQUIRED


def test_insecure_tls_requires_an_explicit_opt_in() -> None:
    with patch("testwf.network.build_opener", return_value=MagicMock()) as build:
        build_direct_opener(insecure_tls=True)

    _, https = _handlers(build)
    assert https._context.check_hostname is False
    assert https._context.verify_mode == ssl.CERT_NONE


@pytest.mark.parametrize("value", ["1", "true", "YES", "on"])
def test_insecure_tls_environment_accepts_explicit_true_values(value: str) -> None:
    with patch.dict(os.environ, {"TESTWF_TELEMETRY_INSECURE": value}, clear=True):
        assert _insecure_tls_enabled() is True


def test_insecure_tls_environment_rejects_invalid_values() -> None:
    with (
        patch.dict(os.environ, {"TESTWF_TELEMETRY_INSECURE": "sometimes"}, clear=True),
        pytest.raises(ValueError, match="must be a boolean"),
    ):
        _insecure_tls_enabled()


def test_telemetry_client_uses_its_private_opener() -> None:
    response = MagicMock()
    response.read.return_value = json.dumps({"status": "accepted"}).encode()
    response.__enter__.return_value = response
    opener = MagicMock()
    opener.open.return_value = response

    with patch.object(urllib.request, "urlopen") as global_urlopen:
        result = TelemetryClient(
            "https://telemetry.example.test",
            opener=opener,
        ).send_event({"event": "test"})

    assert result == {"status": "accepted"}
    opener.open.assert_called_once()
    global_urlopen.assert_not_called()
