"""Synthetic runtime/CLI contracts. No downloads, installs or executable runs."""
import argparse
import contextlib
import errno
import hashlib
import io
import os
from pathlib import Path
import stat
import tarfile
import tempfile
import unittest
from unittest.mock import MagicMock, patch
import zipfile

from tools import cli_support, prepare_node_spike, prepare_spikes, runtime_distribution

ROOT = Path(__file__).absolute().parents[1]


class RuntimeDistributionTests(unittest.TestCase):
    def test_windows_directory_and_legacy_digest_are_preserved(self):
        value = runtime_distribution.runtime_spec('Windows', 'AMD64')
        self.assertEqual(value['archive'], prepare_node_spike.FILENAME)
        self.assertEqual(value['sha256'], prepare_node_spike.EXPECTED)
        self.assertEqual(value['executable'], 'node.exe')
        self.assertEqual(value['npm_cli'], 'node_modules/npm/bin/npm-cli.js')
        self.assertEqual(runtime_distribution.runtime_path(ROOT, 'Windows', 'x86_64'),
                         ROOT / 'local-only/runtime/node-v24.21.0-win-x64/node.exe')

    def test_linux_official_sha_and_relative_entrypoints(self):
        value = runtime_distribution.runtime_spec('Linux', 'x86_64')
        self.assertEqual(value['sha256'], 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6')
        self.assertEqual(value['archive'], 'node-v24.21.0-linux-x64.tar.xz')
        self.assertEqual(value['executable'], 'bin/node')
        self.assertEqual(value['npm_cli'], 'lib/node_modules/npm/bin/npm-cli.js')
        self.assertIsInstance(runtime_distribution.runtime_path(ROOT, 'Linux', 'AMD64'), Path)

    def test_unsupported_os_and_cpu_fail_closed(self):
        for system, machine in [('Darwin', 'arm64'), ('Darwin', 'x86_64'), ('Linux', 'arm64'),
                                ('Windows', 'ARM64'), ('linux', 'x86_64'), ('Linux', '')]:
            with self.subTest(system=system, machine=machine), self.assertRaises(ValueError):
                runtime_distribution.runtime_spec(system, machine)

    def test_defaults_are_host_derived_and_specs_are_detached(self):
        with patch.object(runtime_distribution.platform, 'system', return_value='Linux'), \
                patch.object(runtime_distribution.platform, 'machine', return_value='x86_64'):
            first = runtime_distribution.runtime_spec()
            first['executable'] = 'changed'
            self.assertEqual(runtime_distribution.runtime_spec()['executable'], 'bin/node')

    def test_shared_cli_default_remains_windows_only(self):
        with patch.object(cli_support.sys, 'platform', 'linux'), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as raised:
                cli_support.parse_arguments(argparse.ArgumentParser(), [])
            self.assertNotEqual(raised.exception.code, 0)

    def test_linux_opt_in_does_not_enable_darwin(self):
        with patch.object(cli_support.sys, 'platform', 'linux'):
            self.assertIsNotNone(cli_support.parse_arguments(argparse.ArgumentParser(), [], supported_platforms=('win32', 'linux')))
        with patch.object(cli_support.sys, 'platform', 'darwin'), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            cli_support.parse_arguments(argparse.ArgumentParser(), [], supported_platforms=('win32', 'linux'))

    def test_help_and_import_do_not_select_or_prepare_runtime(self):
        with patch.object(prepare_node_spike, 'main', side_effect=AssertionError('no preparation')), \
                patch.object(prepare_node_spike, 'runtime_spec', side_effect=AssertionError('no platform IO')), \
                contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit) as raised:
            prepare_node_spike.cli(['--help'])
        self.assertEqual(raised.exception.code, 0)


class RuntimeArchiveTests(unittest.TestCase):
    def setUp(self):
        fixture = ROOT / 'local-only/linux-port-20261023/runtime-tests'
        fixture.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(dir=fixture)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.top = 'node-v24.21.0-linux-x64'
        self.required = ['bin/node', 'lib/node_modules/npm/bin/npm-cli.js']

    def make_tar(self, extra=(), *, base=True):
        path = self.root / 'runtime.tar.xz'
        with tarfile.open(path, 'w:xz') as archive:
            values = ([('bin/node', b'SYNTHETIC NEVER EXECUTE', 0o755, 'file', ''),
                       ('lib/node_modules/npm/bin/npm-cli.js', b'// synthetic', 0o755, 'file', '')] if base else [])
            for name, content, mode, kind, link in [*values, *extra]:
                member = tarfile.TarInfo(name if name.startswith(('/', '../')) else self.top + '/' + name)
                member.mode = mode
                if kind == 'sym':
                    member.type, member.linkname = tarfile.SYMTYPE, link
                elif kind == 'hard':
                    member.type, member.linkname = tarfile.LNKTYPE, link
                elif kind == 'fifo':
                    member.type = tarfile.FIFOTYPE
                elif kind == 'dir':
                    member.type = tarfile.DIRTYPE
                else:
                    member.size = len(content)
                archive.addfile(member, io.BytesIO(content) if kind == 'file' else None)
        return path

    def install(self, extra=(), *, base=True):
        path = self.make_tar(extra, base=base)
        return prepare_node_spike.install_tar_archive(path, self.root / 'target', self.top, self.required)

    def test_safe_internal_link_is_materialized_without_filesystem_link(self):
        home = self.install([('bin/npm', b'', 0o777, 'sym', '../lib/node_modules/npm/bin/npm-cli.js')])
        self.assertFalse((home / 'bin/npm').is_symlink())
        self.assertEqual((home / 'bin/npm').read_bytes(), b'// synthetic')
        self.assertEqual((home / 'bin/node').read_bytes(), b'SYNTHETIC NEVER EXECUTE')
        if os.name != 'nt':
            self.assertEqual(stat.S_IMODE((home / 'bin/node').stat().st_mode), 0o755)
            self.assertEqual(stat.S_IMODE((home / 'bin/npm').stat().st_mode), 0o755)

    def test_existing_runtime_and_extra_bytes_are_verified(self):
        archive = self.make_tar()
        home = prepare_node_spike.install_tar_archive(archive, self.root / 'target', self.top, self.required)
        self.assertEqual(prepare_node_spike.install_tar_archive(archive, self.root / 'target', self.top, self.required), home)
        (home / 'bin/node').write_bytes(b'tampered')
        with self.assertRaises(ValueError):
            prepare_node_spike.install_tar_archive(archive, self.root / 'target', self.top, self.required)

    def test_existing_extra_file_or_directory_is_not_removed_or_reused(self):
        archive = self.make_tar()
        home = prepare_node_spike.install_tar_archive(archive, self.root / 'target', self.top, self.required)
        for name, directory in [('extra.js', False), ('extra-dir', True)]:
            extra = home / name
            extra.mkdir() if directory else extra.write_bytes(b'keep')
            with self.assertRaises(ValueError):
                prepare_node_spike.install_tar_archive(archive, self.root / 'target', self.top, self.required)
            self.assertTrue(extra.exists())
            extra.rmdir() if directory else extra.unlink()

    def test_member_traversal_absolute_ads_reserved_and_duplicate_are_rejected_before_writes(self):
        for name in ['../escape', '/absolute', 'lib/../escape', 'a:b', 'NUL', 'trailing.', 'bin/Node', 'bin//empty']:
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    self.install([(name, b'x', 0o644, 'file', '')])
                self.assertFalse((self.root / 'target').exists())

    def test_external_absolute_missing_and_cyclic_links_are_rejected(self):
        scenarios = [[('bin/link', b'', 0o777, 'sym', '../../../escape')],
                     [('bin/link', b'', 0o777, 'sym', '/etc/passwd')],
                     [('bin/link', b'', 0o777, 'sym', 'missing')],
                     [('bin/a', b'', 0o777, 'sym', 'b'), ('bin/b', b'', 0o777, 'sym', 'a')],
                     [('bin/a', b'', 0o777, 'sym', '../lib')]]
        for entries in scenarios:
            with self.subTest(entries=entries), self.assertRaises(ValueError):
                self.install(entries)
            self.assertFalse((self.root / 'target').exists())

    def test_hardlinks_fifo_privileged_modes_and_file_directory_collisions_are_rejected(self):
        for entry in [('bin/link', b'', 0o644, 'hard', self.top + '/bin/node'),
                      ('pipe', b'', 0o644, 'fifo', ''), ('privileged', b'x', 0o4755, 'file', ''),
                      ('bin', b'x', 0o644, 'file', '')]:
            with self.subTest(entry=entry), self.assertRaises(ValueError):
                self.install([entry])
            self.assertFalse((self.root / 'target').exists())

    def test_missing_required_runtime_is_rejected_before_writes(self):
        with self.assertRaises(ValueError):
            self.install([], base=False)
        self.assertFalse((self.root / 'target').exists())

    def test_executable_mode_is_required_before_writes(self):
        with self.assertRaises(ValueError):
            self.install([('bin/node', b'never execute', 0o644, 'file', ''),
                          ('lib/node_modules/npm/bin/npm-cli.js', b'// synthetic', 0o644, 'file', '')], base=False)
        self.assertFalse((self.root / 'target').exists())

    def test_linux_publish_uses_atomic_no_replace_and_reports_collision(self):
        library = MagicMock()
        library.renameat2.return_value = -1
        source, destination = self.root / 'staged', self.root / 'target'
        with patch.object(prepare_node_spike.os, 'name', 'posix'), \
                patch.object(prepare_node_spike.ctypes, 'CDLL', return_value=library), \
                patch.object(prepare_node_spike.ctypes, 'get_errno', return_value=errno.EEXIST), self.assertRaises(FileExistsError):
            prepare_node_spike._publish_directory(source, destination)
        self.assertEqual(library.renameat2.call_args.args[-1], 1)

    def test_linux_publish_without_atomic_primitive_fails_closed(self):
        source, destination = self.root / 'staged', self.root / 'target'
        with patch.object(prepare_node_spike.os, 'name', 'posix'), \
                patch.object(prepare_node_spike.ctypes, 'CDLL', return_value=object()), self.assertRaises(ValueError):
            prepare_node_spike._publish_directory(source, destination)

    def test_linux_existing_mode_checks_reject_missing_execution_without_chmod_repair(self):
        archive = self.make_tar()
        home = prepare_node_spike.install_tar_archive(archive, self.root / 'target', self.top, self.required)
        # The archive verifier on POSIX must reject, never chmod, an existing
        # runtime. Use a local mode helper seam without changing the host Path OS.
        with patch.object(prepare_node_spike, '_posix_mode_matches', side_effect=lambda path, mode: False if path == home / 'bin/node' else True), \
                patch.object(Path, 'chmod', side_effect=AssertionError('no permission repair')), self.assertRaises(ValueError):
            prepare_node_spike.install_tar_archive(archive, self.root / 'target', self.top, self.required)

    def test_windows_legacy_main_expected_seam_remains_patchable(self):
        top = prepare_node_spike.FILENAME.removesuffix('.zip')
        archive = self.root / prepare_node_spike.FILENAME
        with zipfile.ZipFile(archive, 'w') as target:
            target.writestr(top + '/node.exe', b'SYNTHETIC NEVER EXECUTE')
            target.writestr(top + '/node_modules/npm/bin/npm-cli.js', b'// synthetic')
        expected = hashlib.sha256(archive.read_bytes()).hexdigest()
        with patch.object(prepare_node_spike, 'EXPECTED', expected), \
                patch.object(prepare_node_spike, 'urlopen', side_effect=AssertionError('no network')):
            result = prepare_node_spike.main(self.root, system='Windows', machine='AMD64')
        self.assertEqual(result['sha256'], expected)
        self.assertFalse(result['account_used'])

    def test_linux_main_uses_pinned_archive_and_never_executes(self):
        archive = self.make_tar()
        value = runtime_distribution.runtime_spec('Linux', 'x86_64')
        value['sha256'] = hashlib.sha256(archive.read_bytes()).hexdigest()
        archive.rename(self.root / value['archive'])
        with patch.object(prepare_node_spike, 'runtime_spec', return_value=value), \
                patch.object(prepare_node_spike, 'urlopen', side_effect=AssertionError('no network')):
            result = prepare_node_spike.main(self.root)
        self.assertEqual(result['executable'], 'bin/node')
        self.assertFalse(result['global_install'])

    def test_linux_npm_command_uses_distribution_relative_paths(self):
        source = self.root / 'source'
        (source / 'src').mkdir(parents=True)
        (self.root / 'experiments').mkdir()
        runtime = self.root / 'runtime'
        with patch.object(prepare_spikes, 'ROOT', self.root), \
                patch.object(prepare_spikes, 'runtime_spec', return_value=runtime_distribution.runtime_spec('Linux', 'x86_64')), \
                patch.object(prepare_spikes.subprocess, 'run') as run, contextlib.redirect_stdout(io.StringIO()):
            prepare_spikes.prepare('synthetic', {'private': True}, {}, source, self.root / 'target', b'{}', runtime)
        command = run.call_args.args[0]
        self.assertEqual(command[:2], [str(runtime / 'bin/node'), str(runtime / 'lib/node_modules/npm/bin/npm-cli.js')])
        self.assertIn('--ignore-scripts', command)
        self.assertIn('ci', command)


if __name__ == '__main__':
    unittest.main()
