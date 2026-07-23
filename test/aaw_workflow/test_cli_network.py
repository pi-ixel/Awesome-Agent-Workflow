"""Tests for the process-wide CLI urllib transport policy."""

from __future__ import annotations

import os
import ssl
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch
from urllib.request import HTTPSHandler, ProxyHandler


SCRIPTS = Path(__file__).resolve().parents[2] / "skills" / "aaw-workflow" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from cli.network import configure_cli_transport  # noqa: E402


class CliNetworkTests(unittest.TestCase):
    def test_configure_cli_transport_bypasses_proxies_and_ssl_verification(self) -> None:
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
            patch("cli.network.build_opener", return_value=opener) as build,
            patch("cli.network.install_opener") as install,
        ):
            configure_cli_transport()

            self.assertNotIn("HTTP_PROXY", os.environ)
            self.assertNotIn("https_proxy", os.environ)
            self.assertNotIn("CUSTOM_PROXY", os.environ)
            self.assertEqual("*", os.environ["NO_PROXY"])
            self.assertEqual("*", os.environ["no_proxy"])

        handlers = build.call_args.args
        proxy_handler = next(handler for handler in handlers if isinstance(handler, ProxyHandler))
        https_handler = next(handler for handler in handlers if isinstance(handler, HTTPSHandler))
        self.assertEqual({}, proxy_handler.proxies)
        self.assertFalse(https_handler._context.check_hostname)
        self.assertEqual(ssl.CERT_NONE, https_handler._context.verify_mode)
        install.assert_called_once_with(opener)


if __name__ == "__main__":
    unittest.main()
