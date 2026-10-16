"""Exercise the export boundary with synthetic ADB responses, never a device."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import unittest
import uuid
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parent.parent
MOCK = r'''
import json, pathlib, shutil, sys
root = pathlib.Path(__file__).resolve().parent
args = sys.argv[1:]
with (root / 'calls.jsonl').open('a', encoding='utf-8') as stream:
    stream.write(json.dumps(args) + '\n')
mode = (root / 'mode.txt').read_text(encoding='ascii')
if args == ['version']:
    print('Android Debug Bridge version 1.0.41')
elif args == ['devices']:
    print('List of devices attached')
    print('emulator-5554\t' + ('unauthorized' if mode == 'unauthorized' else 'device'))
    if mode == 'multiple':
        print('emulator-5556\tdevice')
elif args[:2] == ['-s', 'emulator-5554']:
    op = args[2:]
    if op == ['shell', 'pm', 'path', 'com.kakao.talk']:
        if mode != 'missing':
            prefix = '/data/user/0/com.kakao.talk' if mode == 'private' else '/data/app/~~synthetic/com.kakao.talk-test'
            if mode == 'traversal':
                prefix = '/data/app/../../data/user/0/com.kakao.talk'
            print('package:' + prefix + '/base.apk')
            print('package:' + prefix + '/split_config.arm64_v8a.apk')
    elif len(op) == 3 and op[0] == 'pull':
        shutil.copyfile(root / pathlib.PurePosixPath(op[1]).name, op[2])
        print('1 file pulled')
    elif op == ['shell', 'dumpsys', 'package', 'com.kakao.talk']:
        print('  versionName=26.1.2\n  versionCode=261200')
        print('  Synthetic private metadata must never be written to a receipt')
    else:
        sys.exit(91)
else:
    sys.exit(92)
'''


@unittest.skipUnless(sys.platform == 'win32', 'Windows PowerShell export kit')
class ApkExportTests(unittest.TestCase):
    def setUp(self):
        # Keep small synthetic artifacts within the ignored workspace; no recursive deletion.
        self.root = ROOT / 'local-only/apk-export-tests' / uuid.uuid4().hex
        self.root.mkdir(parents=True)
        shutil.copyfile(ROOT / 'tools/apk_export/Export-KakaoApk.ps1', self.root / 'Export-KakaoApk.ps1')
        (self.root / 'mock_adb.py').write_text(MOCK, encoding='utf-8')
        (self.root / 'fake-adb.cmd').write_text(
            '@echo off\r\n"' + sys.executable + '" "' + str(self.root / 'mock_adb.py') + '" %*\r\n',
            encoding='ascii', newline='')
        for name in ['base.apk', 'split_config.arm64_v8a.apk']:
            with ZipFile(self.root / name, 'w') as apk:
                apk.writestr('AndroidManifest.xml', 'SYNTHETIC, NOT AN ANDROID APP: ' + name)

    def run_export(self, mode='ready', *extra):
        (self.root / 'mode.txt').write_text(mode, encoding='ascii')
        return subprocess.run(
            ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
             str(self.root / 'Export-KakaoApk.ps1'), '-AdbPath', str(self.root / 'fake-adb.cmd'), *extra],
            capture_output=True, timeout=45, creationflags=subprocess.CREATE_NO_WINDOW)

    def calls(self):
        path = self.root / 'calls.jsonl'
        return [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines()] if path.exists() else []

    def test_complete_split_set_and_minimal_manifest(self):
        result = self.run_export()
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))
        archives = list((self.root / 'output').glob('*.zip'))
        self.assertEqual(len(archives), 1)
        with ZipFile(archives[0]) as archive:
            self.assertEqual(set(archive.namelist()), {'base.apk', 'split_config.arm64_v8a.apk', 'apk-manifest.json'})
            record = json.loads(archive.read('apk-manifest.json'))
            self.assertEqual(record['versionName'], '26.1.2')
            self.assertEqual(record['package'], 'com.kakao.talk')
            self.assertTrue(record['completePmPathSetCopied'])
            for entry in record['files']:
                contents = archive.read(entry['name'])
                self.assertEqual(entry['bytes'], len(contents))
                self.assertEqual(entry['sha256'], hashlib.sha256(contents).hexdigest())
            serialized = json.dumps(record)
            self.assertNotIn('emulator-5554', serialized)
            self.assertNotIn('/data/', serialized)
            self.assertNotIn('Synthetic private', serialized)
            for flag in ['signatureVerified', 'accountLoginPerformed', 'appLaunched', 'privateAppDataRead']:
                self.assertFalse(record[flag])
        calls = self.calls()
        self.assertEqual(len(calls), 6)
        self.assertEqual(sum(call[2:3] == ['pull'] for call in calls), 2)

    def test_prepare_only_does_not_discover_or_connect_devices(self):
        result = self.run_export('ready', '-PrepareOnly')
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))
        self.assertEqual(self.calls(), [['version']])
        self.assertFalse((self.root / 'output').exists())

    def test_ambiguous_or_unauthorized_device_stops_before_read(self):
        for mode in ['multiple', 'unauthorized']:
            with self.subTest(mode=mode):
                log = self.root / 'calls.jsonl'
                if log.exists():
                    log.unlink()
                result = self.run_export(mode)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.calls(), [['version'], ['devices']])
                self.assertFalse((self.root / 'output').exists())

    def test_missing_private_or_traversing_paths_are_not_pulled(self):
        for mode in ['missing', 'private', 'traversal']:
            with self.subTest(mode=mode):
                log = self.root / 'calls.jsonl'
                if log.exists():
                    log.unlink()
                result = self.run_export(mode)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(len(self.calls()), 3)
                self.assertFalse((self.root / 'output').exists())

    def test_nonlocal_endpoint_is_rejected_before_any_adb(self):
        result = self.run_export('ready', '-AdbEndpoint', '192.0.2.1:5555')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.calls(), [])


if __name__ == '__main__':
    unittest.main()
