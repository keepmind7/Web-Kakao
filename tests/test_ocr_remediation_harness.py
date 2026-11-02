"""Account-free regressions for both installed and preserved harness scripts."""

from contextlib import contextmanager
import importlib
import json
import ntpath
import os
from pathlib import Path
import posixpath
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


PROJECT = Path(__file__).resolve().parents[1]
BUNDLES = (
    PROJECT / '.agents/skills/harness/scripts',
    PROJECT / 'tools/vendor/codex_harness/skills/harness/scripts',
)
MODULES = ('common', 'run_support', 'run_state', 'validate', 'run_checks', 'communication')


@contextmanager
def bundle(path):
    saved = {name: sys.modules.pop(name) for name in MODULES if name in sys.modules}
    sys.path.insert(0, str(path))
    try:
        yield SimpleNamespace(**{name: importlib.import_module(name)
                                 for name in ('common', 'run_state', 'validate')})
    finally:
        sys.path.remove(str(path))
        for name in MODULES:
            sys.modules.pop(name, None)
        sys.modules.update(saved)


def task(identifier, ownership, status='running'):
    return dict(id=identifier, ownership=[ownership], dependencies=[],
                acceptance=['synthetic paths only'], status=status, attempts=0,
                required=True)


class HarnessPathTests(unittest.TestCase):
    def setUp(self):
        parent = PROJECT / 'local-only/qa-ocr-remediation-paths'
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='paths-', dir=parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    def test_plain_missing_destination_still_writes(self):
        for index, source in enumerate(BUNDLES):
            with self.subTest(bundle=source), bundle(source) as scripts:
                target = self.root / str(index) / 'new/file.txt'
                self.assertEqual(scripts.common.apply_files({target: b'synthetic'}), [target])
                self.assertEqual(target.read_bytes(), b'synthetic')

    def test_junction_or_symlink_parent_rejected_before_write(self):
        outside = self.root / 'outside'
        outside.mkdir()
        link = self.root / 'linked'
        if os.name == 'nt':
            # Both absolute targets are checked inside this test's private tree.
            self.assertTrue(link.is_relative_to(self.root))
            self.assertTrue(outside.is_relative_to(self.root))
            result = subprocess.run(['cmd.exe', '/d', '/c', 'mklink', '/J',
                                     str(link), str(outside)], capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, 'synthetic junction creation failed')
            self.addCleanup(link.rmdir)
        else:
            link.symlink_to(outside, target_is_directory=True)
        for source in BUNDLES:
            with self.subTest(bundle=source), bundle(source) as scripts:
                with self.assertRaises(ValueError):
                    scripts.common.safe_path(link / 'nested/new.toml')
                with self.assertRaises(ValueError):
                    scripts.common.apply_files({link / 'new.toml': b'synthetic'})
                with self.assertRaises(ValueError):
                    scripts.common.apply_files({link / '..' / 'traversal.toml': b'synthetic'})
                self.assertFalse((outside / 'new.toml').exists())
                self.assertFalse((outside / 'nested').exists())
                self.assertFalse((outside.parent / 'traversal.toml').exists())

    def test_non_symlink_reparse_attribute_rejected(self):
        ancestor = self.root / 'reparse'
        original = Path.lstat

        def metadata(path, *args, **kwargs):
            if path == ancestor:
                return SimpleNamespace(st_mode=stat.S_IFDIR,
                                       st_file_attributes=0x400,
                                       st_reparse_tag=0xA000001D)
            return original(path, *args, **kwargs)

        for source in BUNDLES:
            with self.subTest(bundle=source), bundle(source) as scripts:
                with patch.object(Path, 'lstat', metadata):
                    with self.assertRaises(ValueError):
                        scripts.common.safe_path(ancestor / 'new.txt')

    def test_metadata_permission_error_is_not_treated_as_missing(self):
        for source in BUNDLES:
            with self.subTest(bundle=source), bundle(source) as scripts:
                with patch.object(Path, 'lstat', side_effect=PermissionError('synthetic')):
                    with self.assertRaises(PermissionError):
                        scripts.common.safe_path(self.root / 'new.txt')

    def test_file_parent_is_rejected(self):
        parent = self.root / 'file'
        parent.write_bytes(b'synthetic')
        for source in BUNDLES:
            with self.subTest(bundle=source), bundle(source) as scripts:
                with self.assertRaises(ValueError):
                    scripts.common.safe_path(parent / 'child.txt')

    def test_missing_windows_case_equivalent_ownership_overlaps(self):
        for source in BUNDLES:
            with self.subTest(bundle=source), bundle(source) as scripts:
                with patch.object(scripts.common.os.path, 'normcase', ntpath.normcase):
                    for left, right in [('src/New.py', 'src/new.py'),
                                        ('SRC/New', 'src/new/child.py'),
                                        ('src/NEW/*.py', 'src/new/child.py')]:
                        self.assertTrue(scripts.run_state._project_overlap(self.root, left, right))
                    self.assertFalse(scripts.run_state._project_overlap(
                        self.root, 'src/New', 'src/newer/child.py'))

    def test_posix_ownership_keeps_case_distinct(self):
        for source in BUNDLES:
            with self.subTest(bundle=source), bundle(source) as scripts:
                with patch.object(scripts.common.os.path, 'normcase', posixpath.normcase):
                    self.assertFalse(scripts.run_state._overlap('src/New.py', 'src/new.py'))
                    self.assertTrue(scripts.run_state._overlap('src/New', 'src/New/child.py'))
                    self.assertTrue(scripts.run_state._overlap('.', 'src/new.py'))

    def test_running_plan_validator_uses_same_platform_rule(self):
        plan = self.root / 'plan.json'
        plan.write_text(json.dumps(dict(run_id='synthetic', objective='paths', tasks=[
            task('one', 'src/New.py'), task('two', 'src/new.py')])), encoding='utf-8')
        for source in BUNDLES:
            with self.subTest(bundle=source), bundle(source) as scripts:
                with patch.object(scripts.common.os.path, 'normcase', ntpath.normcase):
                    with self.assertRaisesRegex(ValueError, 'overlapping write ownership'):
                        scripts.validate.validate_plan(plan)
                with patch.object(scripts.common.os.path, 'normcase', posixpath.normcase):
                    self.assertEqual(scripts.validate.validate_plan(plan), [])

    def test_readiness_blocks_case_equivalent_active_owner(self):
        active = task('active', 'src/New.py')
        candidate = task('next', 'src/new.py', 'pending')
        plan = dict(tasks=[active, candidate])
        registry = dict(agents={'synthetic-agent': dict(task_id='active', state='running')})
        for source in BUNDLES:
            with self.subTest(bundle=source), bundle(source) as scripts:
                with patch.object(scripts.common.os.path, 'normcase', ntpath.normcase), \
                     patch.object(scripts.run_state, '_context_issues', return_value=[]):
                    reasons = scripts.run_state._reasons(self.root, self.root, plan, registry, candidate)
                self.assertTrue(any('overlapping write ownership' in reason for reason in reasons))


if __name__ == '__main__':
    unittest.main()
