"""Platform junction checks must also accept ordinary POSIX stat results."""
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from tools import private_storage as storage


class JunctionPortabilityTests(unittest.TestCase):
    def test_posix_metadata_without_windows_stat_constants_is_not_a_junction(self):
        with patch.object(storage, 'stat', SimpleNamespace()), \
             patch.object(Path, 'lstat', return_value=SimpleNamespace()):
            self.assertFalse(storage.is_junction(Path.cwd()))

    def test_windows_mount_point_is_still_detected(self):
        with patch.object(storage, 'stat', SimpleNamespace(IO_REPARSE_TAG_MOUNT_POINT=0xA0000003)), \
             patch.object(Path, 'lstat', return_value=SimpleNamespace(st_reparse_tag=0xA0000003)):
            self.assertTrue(storage.is_junction(Path.cwd()))

    def test_other_windows_reparse_tags_are_not_mount_points(self):
        for tag in (0, 0xA000000C, 0x8000001B):
            with self.subTest(tag=tag), \
                 patch.object(storage, 'stat', SimpleNamespace(IO_REPARSE_TAG_MOUNT_POINT=0xA0000003)), \
                 patch.object(Path, 'lstat', return_value=SimpleNamespace(st_reparse_tag=tag)):
                self.assertFalse(storage.is_junction(Path.cwd()))

    def test_missing_path_is_not_a_junction(self):
        with patch.object(storage, 'stat', SimpleNamespace()), \
             patch.object(Path, 'lstat', side_effect=FileNotFoundError):
            self.assertFalse(storage.is_junction(Path.cwd()))

    def test_denied_metadata_is_not_treated_as_a_safe_path(self):
        with patch.object(Path, 'lstat', side_effect=PermissionError):
            with self.assertRaises(PermissionError):
                storage.is_junction(Path.cwd())


if __name__ == '__main__':
    unittest.main()
