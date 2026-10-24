"""Account-free source ZIP tests in a separate synthetic Git worktree."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from tools import package_local_web

ROOT = Path(__file__).absolute().parents[1]


class SourcePackageTests(unittest.TestCase):
    def setUp(self):
        fixtures = ROOT / 'local-only/linux-port-20261023/package-tests'
        fixtures.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(dir=fixtures)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.git('init', '--quiet')
        self.write('.gitignore', 'local-only/\ndocs/\n.env\n*.key\n/.harness/*\n!/.harness/OPERATING.md\n!/.harness/FOLLOWUP.md\n/.codex/*\n!/.codex/config.toml\n!/.codex/agents/\n/.codex/agents/*\n!/.codex/agents/*.toml\n')
        self.write('README.md', '# synthetic source\n')
        self.write('tools/local_web.py', '# synthetic never execute\n')
        self.git('add', '.gitignore', 'README.md', 'tools/local_web.py')

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.root), *args], check=True, capture_output=True)

    def write(self, name, content):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding='utf-8')
        return path

    def read_public_source(self, name):
        # ROOT can be an extracted source ZIP without .git. Never query its Git
        # or follow a link/reparse/hardlink while copying the public fixture.
        source = package_local_web._source_file(ROOT, name)
        self.assertIsNotNone(source, 'required public source is missing or unsafe: ' + name)
        flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0)
        with os.fdopen(os.open(source, flags), 'rb') as stream:
            opened, current = os.fstat(stream.fileno()), source.lstat()
            self.assertTrue(stat.S_ISREG(opened.st_mode) and opened.st_nlink == 1)
            self.assertEqual((opened.st_dev, opened.st_ino), (current.st_dev, current.st_ino))
            content = stream.read(16 * 1024 * 1024 + 1)
        self.assertLessEqual(len(content), 16 * 1024 * 1024)
        self.assertEqual(package_local_web._source_file(ROOT, name), source)
        return content

    def test_explicit_shared_sources_are_present_with_matching_manifest(self):
        expected = ['.harness/OPERATING.md', '.harness/FOLLOWUP.md', '.codex/config.toml',
                    '.codex/agents/harness_worker.toml', '.agents/skills/example/SKILL.md',
                    'experiments/local-web/platform/common.mjs', 'tools/platforms/common.py',
                    'tools/locks/modern-package-lock.json', 'tests/check.test.mjs']
        for name in expected:
            self.write(name, 'synthetic public source\n')
        result = package_local_web.package_sources(self.root)
        self.assertEqual(result['kind'], 'source-only')
        self.assertFalse(result['includes_runtime'])
        with zipfile.ZipFile(self.root / result['path']) as package:
            manifest = json.loads(package.read('source-package-manifest.json'))
            included = {entry['path']: entry['sha256'] for entry in manifest['files']}
            self.assertTrue(set(expected).issubset(included))
            for name, digest in included.items():
                self.assertEqual(hashlib.sha256(package.read(name)).hexdigest(), digest)
            self.assertIn('독립 실행파일이 아닙니다', package.read('SOURCE-PACKAGE.ko.md').decode('utf-8'))

    def test_private_and_unknown_files_are_excluded_even_if_force_tracked(self):
        rejected = ['.env', '.env.example', 'local-only/runtime/node.exe', 'docs/private.md',
                    '.harness/runs/private.json', '.codex/settings.json', 'tools/identity.key',
                    'tools/credentials.json', 'tools/access-token.json', 'tools/reader-diagnostic.json',
                    'tools/binary.exe', 'tools/original.apk', 'tools/secret.pem', 'tools/node_modules/pkg/index.js',
                    'random/private.md', 'experiments/preferences/settings.json', 'tools/sample.png']
        for name in rejected:
            self.write(name, 'SYNTHETIC_PRIVATE_NEVER_PACKAGE')
        self.git('add', '-f', *rejected)
        result = package_local_web.package_sources(self.root)
        with zipfile.ZipFile(self.root / result['path']) as package:
            self.assertTrue(set(rejected).isdisjoint(package.namelist()))
            for name in package.namelist():
                self.assertNotIn(b'SYNTHETIC_PRIVATE_NEVER_PACKAGE', package.read(name))

    def test_current_public_reader_diagnostics_module_is_packaged_once_with_source_hash(self):
        name = 'experiments/local-web/reader-diagnostics.mjs'
        # Copy the actual public product module, not a placeholder or skipped fixture.
        content = self.read_public_source(name)
        candidate = self.root / name
        candidate.parent.mkdir(parents=True, exist_ok=True)
        candidate.write_bytes(content)
        self.assertTrue(package_local_web.allowed_source_path(name))
        result = package_local_web.package_sources(self.root)
        with zipfile.ZipFile(self.root / result['path']) as package:
            self.assertEqual(package.namelist().count(name), 1)
            self.assertEqual(package.read(name), content)
            manifest = json.loads(package.read('source-package-manifest.json'))
            entries = [item for item in manifest['files'] if item['path'] == name]
            self.assertEqual(entries, [{'path': name, 'sha256': hashlib.sha256(content).hexdigest()}])

    def test_all_current_public_node_entrypoints_are_packaged_without_root_git(self):
        tests_folder = package_local_web.checked_path(ROOT / 'tests')
        entries = sorted(tests_folder.glob('*.test.mjs'))
        self.assertTrue(entries, 'public Node entrypoints are missing')
        contents = {}
        for source in entries:
            name = source.relative_to(ROOT).as_posix()
            contents[name] = self.read_public_source(name)
            candidate = self.root / name
            candidate.parent.mkdir(parents=True, exist_ok=True)
            candidate.write_bytes(contents[name])
        self.assertIn('tests/reader-diagnostics.test.mjs', contents)
        original_run = subprocess.run
        def synthetic_git_only(command, **options):
            if command and command[0] == 'git':
                self.assertEqual(command[1:3], ['-C', str(self.root)], 'ROOT Git must not be queried')
            return original_run(command, **options)
        with patch.object(package_local_web.subprocess, 'run', side_effect=synthetic_git_only):
            result = package_local_web.package_sources(self.root)
        with zipfile.ZipFile(self.root / result['path']) as package:
            included = {name for name in package.namelist() if name.startswith('tests/') and name.endswith('.test.mjs')}
            self.assertEqual(included, set(contents))
            manifest = json.loads(package.read('source-package-manifest.json'))
            for name, content in contents.items():
                with self.subTest(name=name):
                    self.assertEqual(package.namelist().count(name), 1)
                    self.assertEqual(package.read(name), content)
                    items = [item for item in manifest['files'] if item['path'] == name]
                    self.assertEqual(items, [{'path': name, 'sha256': hashlib.sha256(content).hexdigest()}])

    def test_public_fixture_copy_rejects_unsafe_source_without_opening_it(self):
        with patch.object(package_local_web, '_source_file', return_value=None), \
             patch.object(os, 'open', side_effect=AssertionError('unsafe source must not be opened')) as opened:
            with self.assertRaisesRegex(AssertionError, 'missing or unsafe'):
                self.read_public_source('tests/reader-diagnostics.test.mjs')
        opened.assert_not_called()

    def test_reader_diagnostic_exception_does_not_include_neighbor_or_private_paths(self):
        rejected = [
            'tools/reader-diagnostics.mjs', 'tests/reader-diagnostics.mjs',
            'experiments/other/reader-diagnostics.mjs',
            'experiments/local-web/private/reader-diagnostics.mjs',
            'experiments/local-web/Reader-diagnostics.mjs',
            'experiments/local-web/reader-diagnostic.mjs',
            'experiments/local-web/reader-diagnostics-private.mjs',
            'experiments/local-web/reader-diagnostics.mjs.json',
            'experiments/local-web/reader-diagnostics.json',
            'experiments/local-web/reader-diagnostics.log',
            'experiments/local-web/reader-diagnostics.pem',
            'local-only/experiments/local-web/reader-diagnostics.mjs',
            'docs/experiments/local-web/reader-diagnostics.mjs',
            '.harness/runs/reader-diagnostics.mjs',
            'tools/reader-diagnostics.test.mjs',
            'experiments/local-web/reader-diagnostics.test.mjs',
            'tests/Reader-diagnostics.test.mjs',
            'tests/reader-diagnostics-private.test.mjs',
            'tests/reader-diagnostics.test.mjs.json',
            'tests/reader-diagnostics.test.log',
            'tests/reader-diagnostics.test.pem',
            'local-only/tests/reader-diagnostics.test.mjs',
        ]
        for name in rejected:
            with self.subTest(name=name):
                self.assertFalse(package_local_web.allowed_source_path(name))
                self.write(name, 'SYNTHETIC_PRIVATE_NEVER_PACKAGE')
        self.git('add', '-f', *rejected)
        result = package_local_web.package_sources(self.root)
        with zipfile.ZipFile(self.root / result['path']) as package:
            self.assertTrue(set(rejected).isdisjoint(package.namelist()))
            for name in package.namelist():
                self.assertNotIn(b'SYNTHETIC_PRIVATE_NEVER_PACKAGE', package.read(name))

    def test_exact_public_diagnostic_exception_cannot_override_git_ignore(self):
        names = ['experiments/local-web/reader-diagnostics.mjs', 'tests/reader-diagnostics.test.mjs']
        for name in names:
            self.write(name, 'SYNTHETIC_PRIVATE_NEVER_PACKAGE')
        ignore = self.root / '.gitignore'
        ignore.write_text(ignore.read_text(encoding='utf-8') + ''.join('/' + name + '\n' for name in names), encoding='utf-8')
        self.git('add', '-f', *names)
        for name in names:
            self.assertTrue(package_local_web.allowed_source_path(name))
        result = package_local_web.package_sources(self.root)
        with zipfile.ZipFile(self.root / result['path']) as package:
            self.assertTrue(set(names).isdisjoint(package.namelist()))
            manifest = json.loads(package.read('source-package-manifest.json'))
            self.assertTrue(set(names).isdisjoint({entry['path'] for entry in manifest['files']}))

    def test_symlink_or_reparse_candidates_are_not_read(self):
        name = 'tools/linked.py'
        self.write(name, 'SYNTHETIC_PRIVATE_NEVER_PACKAGE')
        original = package_local_web.checked_path
        def reject_link(path):
            if Path(path) == self.root / name:
                raise ValueError('synthetic_reparse')
            return original(path)
        with patch.object(package_local_web, 'checked_path', side_effect=reject_link):
            result = package_local_web.package_sources(self.root)
        with zipfile.ZipFile(self.root / result['path']) as package:
            self.assertNotIn(name, package.namelist())

    def test_hardlinked_source_is_excluded(self):
        origin = self.write('tools/origin.py', 'SYNTHETIC_PRIVATE_NEVER_PACKAGE')
        os.link(origin, self.root / 'tools/alias.py')
        result = package_local_web.package_sources(self.root)
        with zipfile.ZipFile(self.root / result['path']) as package:
            self.assertNotIn('tools/origin.py', package.namelist())
            self.assertNotIn('tools/alias.py', package.namelist())

    def test_preexisting_output_is_preserved(self):
        output = self.write('local-only/dist/windows-58a73a7-source.zip', 'preserve baseline')
        with self.assertRaises(FileExistsError):
            package_local_web.package_sources(self.root, output)
        self.assertEqual(output.read_text(), 'preserve baseline')

    def test_output_outside_fixed_dist_boundary_is_rejected_without_writes(self):
        for name in ['source.zip', 'local-only/other/source.zip', 'local-only/dist/nested/source.zip',
                     'local-only/dist/source.tar', 'local-only/dist/../source.zip']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                package_local_web.package_sources(self.root, self.root / name)
        self.assertFalse((self.root / 'local-only').exists())

    def test_help_is_parse_only_and_never_runs_git(self):
        with patch.object(package_local_web, 'package_sources', side_effect=AssertionError('no packaging')), \
                patch.object(subprocess, 'run', side_effect=AssertionError('no git')), \
                contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit) as raised:
            package_local_web.main(['--help'])
        self.assertEqual(raised.exception.code, 0)

    def test_path_allowlist_rejects_unsafe_names(self):
        for name in ['../README.md', '/README.md', 'tools/../secret.py', 'tools\\bad.py',
                     'C:/tools/bad.py', 'tools//bad.py', 'tools/./bad.py', 'tools/name\x00.py']:
            with self.subTest(name=name):
                self.assertFalse(package_local_web.allowed_source_path(name))

    def test_git_ignore_error_fails_closed(self):
        original = subprocess.run
        def run(command, **options):
            if 'check-ignore' in command:
                return subprocess.CompletedProcess(command, 128, b'', b'fake')
            return original(command, **options)
        with patch.object(subprocess, 'run', side_effect=run), self.assertRaises(ValueError):
            package_local_web.package_sources(self.root)
        self.assertFalse((self.root / 'local-only').exists())


if __name__ == '__main__':
    unittest.main()
