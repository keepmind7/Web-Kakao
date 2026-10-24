"""macOS adapter contracts; mocked lsof, no server, browser or account access."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from tools import prepare_node_spike, runtime_distribution
from tools.platforms import macos


class MacosContracts(unittest.TestCase):
    def test_darwin_runtime_is_pinned_gzip_for_both_architectures(self):
        for machine, digest in [("x86_64", "1462cb3b"), ("arm64", "bed7eea5")]:
            with self.subTest(machine=machine):
                spec = runtime_distribution.runtime_spec("Darwin", machine)
                self.assertTrue(spec["archive"].endswith(".tar.gz"))
                self.assertTrue(spec["sha256"].startswith(digest))
                self.assertEqual(spec["executable"], "bin/node")

    def lsof(self, stdout, code=0):
        result = subprocess.CompletedProcess([], code, stdout=stdout, stderr=b"")
        return patch.object(macos.subprocess, "run", return_value=result)

    def test_listener_owners_parses_pids_and_refuses_foreign_uid(self):
        uid = os.getuid()
        with self.lsof(f"p123\nu{uid}\nf5\n".encode()):
            self.assertEqual(macos.listener_owners(8787), {123})
        with self.lsof(f"p123\nu{uid + 1}\n".encode()), self.assertRaises(OSError):
            macos.listener_owners(8787)
        with self.lsof(b"", code=1):
            self.assertEqual(macos.listener_owners(8787), set())
        with self.lsof(b"", code=2), self.assertRaises(OSError):
            macos.listener_owners(8787)
        with self.assertRaises(OSError):
            macos.listener_owners(0)

    def test_browser_outside_fixed_app_folders_is_not_used(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"HOME": tmp}):
            app = Path(tmp) / "Applications" / macos.BROWSER_APPS["edge"]
            app.parent.mkdir(parents=True)
            app.write_bytes(b"synthetic")
            app.chmod(0o777)  # world-writable launcher is refused
            with patch.object(macos, "Path", side_effect=lambda value: Path(tmp) / "none" if value == "/Applications" else Path(value)):
                self.assertIsNone(macos.find_browser("edge"))

    @unittest.skipUnless(sys.platform == "darwin", "native renamex_np")
    def test_darwin_publish_is_atomic_no_replace(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, destination = Path(tmp) / "staged", Path(tmp) / "target"
            source.mkdir()
            prepare_node_spike._publish_directory(source, destination)
            self.assertTrue(destination.is_dir())
            source.mkdir()
            with self.assertRaises(FileExistsError):
                prepare_node_spike._publish_directory(source, destination)


if __name__ == "__main__":
    unittest.main()
