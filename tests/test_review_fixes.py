"""Offline regression contracts: fake downloads/subprocesses, private temporary fixtures only."""
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch
from zipfile import ZipFile

from tools import prepare_android_adb, prepare_node_spike, prepare_rea_android, local_web

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'local-only/repair-review-20261018/qa/contracts/fixtures'


class RepairToolContracts(unittest.TestCase):
    def setUp(self):
        OUTPUT.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix='offline-', dir=OUTPUT)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()

    def test_T1_existing_extracted_node_bytes_are_verified_against_trusted_zip(self):
        top = prepare_node_spike.FILENAME.removesuffix('.zip')
        archive = self.root / prepare_node_spike.FILENAME
        with ZipFile(archive, 'w') as zipped:
            zipped.writestr(top + '/node.exe', b'SYNTHETIC NEVER EXECUTE')
            zipped.writestr(top + '/node_modules/npm/bin/npm-cli.js', b'// pinned synthetic')
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        with patch.object(prepare_node_spike, 'EXPECTED', digest), patch.object(prepare_node_spike, 'urlopen', side_effect=AssertionError('no network')), patch.object(subprocess, 'run', side_effect=AssertionError('no executable run')):
            prepared = prepare_node_spike.main(self.root)
            self.assertFalse(prepared['account_used'])
            (self.root / top / 'node.exe').write_bytes(b'TAMPERED NEVER EXECUTE')
            with self.assertRaises((ValueError, SystemExit), msg='existing runtime tamper must fail closed'):
                prepare_node_spike.main(self.root)

    def test_T2_adb_preplanted_partial_is_never_overwritten(self):
        folder = self.root / 'adb'; folder.mkdir()
        partial = folder / ('platform-tools-' + prepare_android_adb.VERSION + '-windows.partial')
        partial.write_bytes(b'KEEP EXISTING PARTIAL')
        with patch.object(prepare_android_adb, 'FOLDER', folder), patch.object(prepare_android_adb, 'urlopen', return_value=io.BytesIO(b'fake downloaded bytes')), patch.object(subprocess, 'run', side_effect=AssertionError('no executable run')):
            try:
                prepare_android_adb.main()
            except (ValueError, SystemExit, FileExistsError):
                pass
        self.assertEqual(partial.read_bytes(), b'KEEP EXISTING PARTIAL')

    def test_T2_rea_preplanted_partial_is_never_overwritten(self):
        folder = self.root / 'rea'; folder.mkdir()
        partial = folder / 'jdk.zip.partial'; partial.write_bytes(b'KEEP EXISTING PARTIAL')
        with patch.object(prepare_rea_android, 'DEST', folder), patch.object(prepare_rea_android, 'ASSETS', [('jdk.zip', 'https://synthetic.invalid/no-network', '0' * 64)]), patch.object(prepare_rea_android, 'urlopen', return_value=io.BytesIO(b'fake downloaded bytes')):
            try:
                prepare_rea_android.main()
            except (ValueError, SystemExit, FileExistsError):
                pass
        self.assertEqual(partial.read_bytes(), b'KEEP EXISTING PARTIAL')

    def test_T2_reparse_ancestor_is_rejected_before_mock_network_or_file_IO(self):
        # Simulated Windows reparse metadata, scoped only to this harmless fixture.
        folder = self.root / 'linked'; folder.mkdir()
        real_lstat = Path.lstat
        def lstat(path):
            result = real_lstat(path)
            if path == folder:
                result = MagicMock(wraps=result)
                result.st_file_attributes = 0x400
                result.st_mode = 0o40755
            return result
        with patch.object(Path, 'lstat', lstat), patch.object(prepare_android_adb, 'FOLDER', folder), patch.object(prepare_android_adb, 'urlopen', return_value=io.BytesIO(b'fake')) as network:
            try:
                prepare_android_adb.main()
            except (ValueError, SystemExit, FileExistsError):
                pass
        self.assertEqual(network.call_count, 0, 'reparse ancestor must be rejected before opening network')
        self.assertEqual(list(folder.iterdir()), [], 'no file IO inside rejected ancestor')

    def test_T3_legacy_tracked_lock_matches_required_manifest(self):
        lock_path = ROOT / 'tools/locks/legacy-package-lock.json'
        self.assertTrue(lock_path.is_file(), 'required legacy lock is a tracked preparation input')
        lock = json.loads(lock_path.read_text('utf-8'))
        self.assertEqual(lock['packages']['']['dependencies'], {'tsx': '^4', 'bson': '^4.4.1'})
        self.assertGreaterEqual(lock['lockfileVersion'], 3)
        for key, value in lock['packages'].items():
            if key:
                self.assertIn('integrity', value)
                self.assertTrue(value['resolved'].startswith('https://registry.npmjs.org/'))

    def test_T3_both_locks_preflight_before_install_or_fixture_mutation(self):
        (self.root / 'tools/locks').mkdir(parents=True)
        shutil.copyfile(ROOT / 'tools/prepare_spikes.py', self.root / 'tools/prepare_spikes.py')
        shutil.copyfile(ROOT / 'tools/locks/modern-package-lock.json', self.root / 'tools/locks/modern-package-lock.json')
        # Helper imports, if introduced, remain the real project implementation.
        (self.root / 'experiments').mkdir()
        evidence = self.root / 'evidence/alternatives'; evidence.mkdir(parents=True)
        for candidate, filename in [('modern', 'modern-api-spike.ts'), ('legacy', 'legacy-codec-spike.ts')]:
            (self.root / 'local-only/src' / candidate / 'src').mkdir(parents=True)
            (self.root / 'experiments' / filename).write_text('// synthetic', encoding='utf-8')
            (evidence / (candidate + '-source.json')).write_text(json.dumps({'directory': 'local-only/src/' + candidate}), encoding='utf-8')
        (evidence / 'node-runtime.json').write_text(json.dumps({'directory': 'local-only/runtime/node'}), encoding='utf-8')
        with patch.object(subprocess, 'run') as run, patch.object(sys, 'argv', ['prepare_spikes', '--install-dependencies']), patch('builtins.print'):
            with self.assertRaises(SystemExit):
                runpy.run_path(str(self.root / 'tools/prepare_spikes.py'), run_name='__main__')
        self.assertEqual(run.call_count, 0, 'missing legacy lock must stop before modern npm ci')
        self.assertFalse((self.root / 'local-only/spikes').exists(), 'preflight before preparation side effects')


class PortAvailabilityContracts(unittest.TestCase):
    def helper(self):
        value = getattr(local_web, 'assert_port_available', None)
        self.assertTrue(callable(value), 'launcher exposes shared assert_port_available(port) preflight')
        return value

    def test_timeout_exclusive_bind_available(self):
        helper = self.helper(); bound = MagicMock(); bound.__enter__.return_value = bound
        with patch.object(socket, 'create_connection', side_effect=TimeoutError()), patch.object(socket, 'socket', return_value=bound):
            helper(18787)
        bound.setsockopt.assert_called_once_with(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        bound.bind.assert_called_once_with(('127.0.0.1', 18787))

    def test_timeout_exclusive_bind_occupied_refuses(self):
        helper = self.helper(); bound = MagicMock(); bound.__enter__.return_value = bound; bound.bind.side_effect=OSError('synthetic occupied')
        with patch.object(socket, 'create_connection', side_effect=TimeoutError()), patch.object(socket, 'socket', return_value=bound), self.assertRaises((OSError, local_web.UntrustedServer)):
            helper(18787)

    def test_connect_success_refuses_without_bind(self):
        helper = self.helper()
        with patch.object(socket, 'create_connection', return_value=MagicMock()), patch.object(socket, 'socket') as bind_socket, self.assertRaises((OSError, local_web.UntrustedServer)):
            helper(18787)
        bind_socket.assert_not_called()

    def test_connection_refused_keeps_normal_path(self):
        helper = self.helper()
        with patch.object(socket, 'create_connection', side_effect=ConnectionRefusedError()), patch.object(socket, 'socket') as bind_socket:
            helper(18787)
        bind_socket.assert_not_called()


if __name__ == '__main__':
    unittest.main()
