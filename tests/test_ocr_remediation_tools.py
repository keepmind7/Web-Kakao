"""Offline installer paths and legacy-probe guards; no real CLI or accounts."""
import contextlib
import hashlib
import importlib.util
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

from tools import open_code_review as ocr


ROOT = Path(__file__).resolve().parent.parent


def load_probe(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'experiments' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ToolRemediationTests(unittest.TestCase):
    def setUp(self):
        parent = ROOT / 'local-only' / 'qa-ocr-tools-20261102'
        parent.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix='isolated-', dir=parent)
        self.root = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)
        self.payload = b'synthetic OCR bytes, never executed'
        self.digest = hashlib.sha256(self.payload).hexdigest()
        self.asset = 'opencodereview-windows-amd64.exe'
        self.sums = (self.digest + '  ' + self.asset + '\n').encode()
        self.install = self.root / 'ocr' / 'version'
        self.git = self.root / 'mingit' / 'version'
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(ocr, 'INSTALL_DIR', self.install))
        self.stack.enter_context(patch.object(ocr, 'MINGIT_DIR', self.git))
        self.stack.enter_context(patch.object(ocr, 'WINDOWS_AMD64_SHA256', self.digest))
        self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))

    def directory_link(self, link, target):
        try:
            link.symlink_to(target, target_is_directory=True)
        except OSError:
            if os.name != 'nt':
                raise
            subprocess.run([os.environ.get('COMSPEC', 'cmd.exe'), '/c', 'mklink', '/J', str(link), str(target)],
                           capture_output=True, check=True)
        self.addCleanup(lambda: link.unlink() if link.is_symlink() else os.rmdir(link))

    def ocr_download(self):
        return patch.object(ocr, 'download', side_effect=[self.sums, self.payload])

    def git_archive(self, entries=None):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as archive:
            for name, content in entries or [('cmd/git.exe', b'synthetic git, never executed')]:
                archive.writestr(name, content)
        content = stream.getvalue()
        self.stack.enter_context(patch.object(ocr, 'MINGIT_SHA256', hashlib.sha256(content).hexdigest()))
        return patch.object(ocr.urllib.request, 'urlopen', return_value=io.BytesIO(content))

    def no_staging_left(self, destination):
        self.assertEqual(list(destination.parent.glob('download-*')), [])

    def test_ocr_install_uses_verified_owned_stage(self):
        with self.ocr_download() as download:
            ocr.install(self.asset, self.install / 'ocr.exe')
        self.assertEqual(download.call_count, 2)
        self.assertEqual((self.install / 'ocr.exe').read_bytes(), self.payload)
        self.assertEqual((self.install / 'sha256sum.txt').read_bytes(), self.sums)
        self.no_staging_left(self.install)

    def test_ocr_predictable_temporary_link_and_sentinel_are_preserved(self):
        self.install.mkdir(parents=True)
        sentinel = self.root / 'sentinel'
        sentinel.write_bytes(b'preserve original')
        link = self.install / 'ocr.download'
        try:
            link.symlink_to(sentinel)
        except OSError:
            os.link(sentinel, link)
        with patch.object(ocr, 'download') as download, self.assertRaises((ValueError, FileExistsError)):
            ocr.install(self.asset, self.install / 'ocr.exe')
        download.assert_not_called()
        self.assertEqual(sentinel.read_bytes(), b'preserve original')
        self.assertTrue(link.exists())

    def test_ocr_linked_ancestor_is_rejected_before_download(self):
        external = self.root / 'external'
        external.mkdir()
        self.directory_link(self.install.parent, external)
        with patch.object(ocr, 'download') as download, self.assertRaises(ValueError):
            ocr.install(self.asset, self.install / 'ocr.exe')
        download.assert_not_called()
        self.assertEqual(list(external.iterdir()), [])

    def test_ocr_late_publish_collision_is_preserved(self):
        publish = ocr._publish_directory

        def collide(source, destination):
            destination.mkdir()
            (destination / 'sentinel').write_bytes(b'late collision')
            publish(source, destination)

        with self.ocr_download(), patch.object(ocr, '_publish_directory', side_effect=collide), self.assertRaises(FileExistsError):
            ocr.install(self.asset, self.install / 'ocr.exe')
        self.assertEqual((self.install / 'sentinel').read_bytes(), b'late collision')
        self.assertFalse((self.install / 'ocr.exe').exists())
        self.no_staging_left(self.install)

    def test_ocr_bad_checksum_never_publishes(self):
        with patch.object(ocr, 'download', side_effect=[self.sums, b'bad payload']), self.assertRaises(ValueError):
            ocr.install(self.asset, self.install / 'ocr.exe')
        self.assertFalse(self.install.exists())
        self.no_staging_left(self.install)

    def test_mingit_install_uses_owned_stage(self):
        with self.git_archive() as download:
            ocr.install_git()
        download.assert_called_once()
        self.assertEqual((self.git / 'cmd/git.exe').read_bytes(), b'synthetic git, never executed')
        self.no_staging_left(self.git)

    def test_existing_mingit_is_preserved_without_download(self):
        self.git.mkdir(parents=True)
        (self.git / 'sentinel').write_bytes(b'preserve original')
        with patch.object(ocr.urllib.request, 'urlopen') as download, self.assertRaises(FileExistsError):
            ocr.install_git()
        download.assert_not_called()
        self.assertEqual((self.git / 'sentinel').read_bytes(), b'preserve original')

    def test_mingit_linked_ancestor_is_rejected_before_download(self):
        external = self.root / 'external'
        external.mkdir()
        self.directory_link(self.git.parent, external)
        with patch.object(ocr.urllib.request, 'urlopen') as download, self.assertRaises(ValueError):
            ocr.install_git()
        download.assert_not_called()
        self.assertEqual(list(external.iterdir()), [])

    def test_mingit_late_publish_collision_is_preserved(self):
        publish = ocr._publish_directory

        def collide(source, destination):
            destination.mkdir()
            (destination / 'sentinel').write_bytes(b'late collision')
            publish(source, destination)

        with self.git_archive(), patch.object(ocr, '_publish_directory', side_effect=collide), self.assertRaises(FileExistsError):
            ocr.install_git()
        self.assertEqual((self.git / 'sentinel').read_bytes(), b'late collision')
        self.no_staging_left(self.git)

    def test_mingit_unsafe_members_never_publish_or_escape(self):
        link = zipfile.ZipInfo('cmd/link')
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        for entries in ([('../escape', b'bad')], [('..\\escape', b'bad')],
                        [('/escape', b'bad')], [('cmd/git.exe', b'one'), ('cmd/git.exe', b'two')],
                        [(link, b'../escape')], [('cmd/other', b'missing git')]):
            with self.subTest(entries=entries), self.git_archive(entries), self.assertRaises((ValueError, FileExistsError)):
                ocr.install_git()
            self.assertFalse(self.git.exists())
            self.assertFalse((self.root / 'escape').exists())
            self.no_staging_left(self.git)

    def test_linked_installed_ocr_is_not_executed(self):
        external = self.root / 'external'
        external.mkdir()
        (external / 'ocr.exe').write_bytes(b'never execute')
        self.install.parent.mkdir()
        self.directory_link(self.install, external)
        with patch.object(ocr, 'target', return_value=(self.asset, 'ocr.exe')), patch.object(ocr.sys, 'argv', ['ocr', 'delegate', 'preview']), patch.object(ocr.subprocess, 'run') as run, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(ocr.main(), 1)
        run.assert_not_called()

    def test_photo_png_preparation_still_never_connects(self):
        probe = load_probe('photo_upload_probe')
        with patch.object(probe, 'FOLDER', self.root / 'png'), patch.object(probe, 'connect') as connect, patch.object(probe.sys, 'argv', ['probe']):
            probe.main()
        connect.assert_not_called()
        for name in ('small', 'large'):
            self.assertTrue((self.root / 'png' / (name + '.png')).read_bytes().startswith(b'\x89PNG\r\n\x1a\n'))

    def test_photo_build8_is_explicitly_rejected_before_general_api(self):
        probe = load_probe('photo_upload_probe')

        class Client:
            def open(self, *_args, **_kwargs):
                raise AssertionError('build8 probe must not use a general API')

        state = {'build': 8, 'credentialInMemory': True, 'messaging': True, 'reader': {'phase': 'connected'}}
        with patch.object(probe, 'FOLDER', self.root / 'png'), patch.object(probe, 'connect', return_value=('http://127.0.0.1:1', Client(), state)), patch.object(probe.sys, 'argv', ['probe', '--send-case', 'small', '--confirmed-self-test']):
            with self.assertRaisesRegex(SystemExit, 'does not support build8'):
                probe.main()
        self.assertEqual(list((self.root / 'png').glob('*-attempted.json')), [])

    def test_phone_build8_is_explicitly_rejected_before_general_api(self):
        probe = load_probe('phone_off_observe')

        class Client:
            def open(self, *_args, **_kwargs):
                raise AssertionError('build8 probe must not use a general API')

        with patch.object(probe, 'ROOT', self.root), patch.object(probe, 'connect', return_value=('http://127.0.0.1:1', Client(), {'build': 8})), patch.object(probe.sys, 'argv', ['probe', '--confirm-phone-off', '--seconds', '30']), patch.object(probe.time, 'sleep') as sleep:
            self.assertEqual(probe.main(), 1)
        sleep.assert_not_called()
        result = json.loads((self.root / 'evidence/phase2/phone-off-observation.json').read_text())
        self.assertEqual(result['failure'], 'legacy_probe_unsupported_on_build8')
        self.assertFalse(result['passed'])
        self.assertEqual(result['queries'], [])
        self.assertEqual(result['samples'], [])


if __name__ == '__main__':
    unittest.main()
