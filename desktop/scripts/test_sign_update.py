"""Verify release metadata is bound to the installer signature."""
import base64
import importlib.util
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

spec = importlib.util.spec_from_file_location("sign_update", Path(__file__).with_name("sign-update.py"))
sign_update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sign_update)

class ReleaseNotesTests(unittest.TestCase):
    def test_notes_and_date_are_signed(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            notes = root / "0.2.0.md"
            notes.write_text("# AAW Desktop 0.2.0\n\n发布日期：2026-11-03\n\n## 修复\n\n- 更新连接\n", encoding="utf-8")
            body, published = sign_update.read_release_notes(notes, "0.2.0")
            artifact = root / "AAW-Desktop-0.2.0-windows-x64-setup.exe"
            artifact.write_bytes(b"installer")
            seed = bytes(range(32))
            key = Ed25519PrivateKey.from_private_bytes(seed)
            public = key.public_key()
            with patch.dict(os.environ, {
                "AAW_DESKTOP_SIGNING_KEY": base64.b64encode(seed).decode(),
                "AAW_DESKTOP_UPDATE_PUBLIC_KEY": base64.b64encode(public.public_bytes(Encoding.Raw, PublicFormat.Raw)).decode(),
            }):
                envelope = sign_update.sign(artifact, "0.2.0", body, published)
            payload = base64.b64decode(envelope["payload"])
            public.verify(base64.b64decode(envelope["signature"]), payload)
            data = json.loads(payload)
            self.assertEqual(data["notes"], "## 修复\n\n- 更新连接")
            self.assertEqual(data["published_at"], "2026-11-03")

    def test_rejects_wrong_version_bad_date_or_empty_body(self):
        with TemporaryDirectory() as folder:
            path = Path(folder) / "notes.md"
            for text in [
                "# AAW Desktop 0.1.0\n\n发布日期：2026-11-03\n\n## 修复",
                "# AAW Desktop 0.2.0\n\n发布日期：2026-02-30\n\n## 修复",
                "# AAW Desktop 0.2.0\n\n发布日期：2026-11-03\n\n ",
                "AAW Desktop 0.2.0",
            ]:
                with self.subTest(text=text):
                    path.write_text(text, encoding="utf-8")
                    with self.assertRaises(ValueError):
                        sign_update.read_release_notes(path, "0.2.0")

if __name__ == "__main__":
    unittest.main()
