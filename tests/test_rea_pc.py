"""Synthetic REA PC boundaries; never run REA, Java, targets or downloads."""
import contextlib
import hashlib
import importlib
import io
import json
import ntpath
import os
from pathlib import Path
import stat
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile


ROOT = Path(__file__).resolve().parent.parent


class ToolCase(unittest.TestCase):
    def setUp(self):
        for filename in ('prepare_rea_windows.py', 'rea_pc.py'):
            self.assertTrue((ROOT / 'tools' / filename).is_file(),
                            'missing PC helper: ' + filename)
        self.prepare = importlib.import_module('tools.prepare_rea_windows')
        self.runner = importlib.import_module('tools.rea_pc')
        # The production Ghidra temp restriction covers the entire absolute
        # path. A dotted Windows username is an invalid *analysis fixture*, so
        # choose an existing dot-free temporary parent without relaxing it.
        candidates = [Path(tempfile.gettempdir())]
        if os.name == 'nt':
            candidates.append(Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'Temp')
        parent = next((path.resolve() for path in candidates
                       if '.' not in str(path.resolve()) and path.is_dir()), None)
        self.assertIsNotNone(parent, 'REA fixture requires a writable dot-free temporary parent')
        self.temporary = tempfile.TemporaryDirectory(prefix='webkakao-rea-test-', dir=parent)
        created = Path(self.temporary.name)
        self.assertEqual(created.parent.resolve(), parent)
        self.assertNotIn('.', str(created.resolve()))
        self.root = created

        def cleanup_owned_tree():
            # Validate the exclusive random test tree before recursive cleanup.
            self.prepare.checked_path(created, parent)
            if created.parent != parent or not created.name.startswith('webkakao-rea-test-'):
                raise ValueError('unsafe_test_cleanup')
            self.temporary.cleanup()

        self.addCleanup(cleanup_owned_tree)

    def archive(self, entries):
        archive = self.root / 'asset.zip'
        with zipfile.ZipFile(archive, 'w') as output:
            for name, content in entries:
                if isinstance(name, str):
                    # ZipInfo normalizes backslashes on Windows at construction;
                    # assign the raw name afterwards to build a hostile ZIP.
                    member = zipfile.ZipInfo()
                    member.filename = member.orig_filename = name
                    name = member
                output.writestr(name, content)
        return archive

    def fixture(self):
        runtime = self.root / 'local-only/rea-windows/runtime.json'
        runtime.parent.mkdir(parents=True)
        config = {
            'node': str(self.root / 'local-only/node/node.exe'),
            'rea_cli': str(self.root / 'local-only/rea/node_modules/rea-agents/scripts/rea.mjs'),
            'java_home': str(self.root / 'local-only/rea-windows/jdk'),
            'ghidra_install_dir': str(self.root / 'local-only/rea-windows/ghidra'),
            'temp_root': str(self.root / 'local-only/rea-temp'),
            'versions': {'rea': '6.5.0', 'ghidra': '12.1.4', 'jdk': '21.0.12.1+1'},
            'assets': [],
        }
        for key in ('node', 'rea_cli'):
            path = Path(config[key])
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'synthetic runtime')
        (Path(config['rea_cli']).parent.parent / 'package.json').write_text(
            '{"version":"6.5.0"}', encoding='utf-8')
        for key, name in (('java_home', 'bin/java.exe'),
                          ('java_home', 'bin/javac.exe'),
                          ('ghidra_install_dir', 'support/analyzeHeadless.bat'),
                          ('ghidra_install_dir', 'Ghidra/Features/Decompiler/os/win_x86_64/decompile.exe')):
            path = Path(config[key]) / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'synthetic runtime')
        runtime.write_text(json.dumps(config), encoding='utf-8')
        target = self.root / 'local-only/pc-analysis/sample/Example.exe'
        target.parent.mkdir(parents=True)
        target.write_bytes(b'MZ synthetic data, never executed')
        manifest = {'analysis_copy': target.relative_to(self.root).as_posix(),
                    'sha256': hashlib.sha256(target.read_bytes()).hexdigest()}
        (target.parent / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
        return config, target, manifest

    def invoke(self, argv, stdout=b'{"ok":true}', returncode=0, failure=None,
               cleanup_code=0):
        calls = []

        class Child:
            pid = 4242

            def __init__(self, command, **kwargs):
                calls.append((command, kwargs))
                if isinstance(failure, OSError):
                    raise failure
                self.kwargs, self.returncode = kwargs, None

            def communicate(self, timeout):
                self.kwargs['stdout'].write(stdout)
                self.kwargs['stderr'].write(b'synthetic private stderr')
                if failure:
                    raise failure
                self.returncode = returncode

            def poll(self):
                return self.returncode

            def kill(self):
                self.returncode = -9

            def wait(self, timeout):
                self.returncode = -9 if self.returncode is None else self.returncode
                return self.returncode

        def cleanup(command, **kwargs):
            calls.append((command, kwargs))
            return subprocess.CompletedProcess(command, cleanup_code)

        console = io.StringIO()
        with patch.object(self.runner, 'ROOT', self.root), \
                patch.object(self.runner.subprocess, 'Popen', side_effect=Child), \
                patch.object(self.runner.subprocess, 'run', side_effect=cleanup), \
                contextlib.redirect_stdout(console):
            code = self.runner.main(argv)
        receipt = json.loads(console.getvalue())
        return code, receipt, calls, console.getvalue()


class ArchiveTests(ToolCase):
    def test_install_publication_inherits_destination_permissions(self):
        archive = self.archive([('home/good', b'public pinned bytes')])
        destination = self.root / 'install-publication'
        modes, stages = [], []
        original = os.mkdir

        def mkdir(path, mode=0o777, **kwargs):
            if Path(path).parent == destination:
                stages.append(Path(path))
                modes.append(mode)
            return original(path, mode, **kwargs)

        with patch.object(os, 'mkdir', side_effect=mkdir):
            home = self.prepare.install_archive(archive, destination, ['good'])
        self.assertEqual((home / 'good').read_bytes(), b'public pinned bytes')
        self.assertEqual(modes, [0o777], 'published install must inherit its destination DACL')
        self.assertTrue(all(not stage.exists() for stage in stages))
        self.assertEqual(list(destination.iterdir()), [home])

    def test_download_publication_inherits_permissions_and_cleans_hash_failure(self):
        payload = b'synthetic public archive bytes; no network'
        original = os.mkdir
        for valid in (True, False):
            destination = self.root / ('download-' + str(valid))
            asset = {'name': 'asset.zip', 'url': 'https://example.invalid/asset.zip',
                     'sha256': hashlib.sha256(payload).hexdigest() if valid else '0' * 64}
            modes, stages = [], []

            def mkdir(path, mode=0o777, **kwargs):
                if Path(path).parent == destination:
                    stages.append(Path(path))
                    modes.append(mode)
                return original(path, mode, **kwargs)

            with self.subTest(valid_digest=valid), \
                    patch.object(os, 'mkdir', side_effect=mkdir), \
                    patch.object(self.prepare, 'urlopen', return_value=io.BytesIO(payload)):
                if valid:
                    archive = self.prepare.ensure_archive(destination, asset)
                    self.assertEqual(archive.read_bytes(), payload)
                else:
                    with self.assertRaises(ValueError):
                        self.prepare.ensure_archive(destination, asset)
                    self.assertFalse((destination / 'asset.zip').exists())
                self.assertEqual(modes, [0o777], 'published archive must inherit its destination DACL')
                self.assertTrue(all(not stage.exists() for stage in stages))

    def test_install_stage_collision_preserves_other_directory_and_contents(self):
        archive = self.archive([('home/good', b'public bytes')])
        destination = self.root / 'collision-publication'
        collided, stages = [], []
        original = os.mkdir

        def mkdir(path, mode=0o777, **kwargs):
            path = Path(path)
            if path.parent == destination:
                stages.append(path)
                if not collided:
                    original(path, mode, **kwargs)
                    (path / 'preserve').write_bytes(b'other task')
                    collided.append(path)
                    raise FileExistsError('synthetic exclusive-creation collision')
            return original(path, mode, **kwargs)

        with patch.object(os, 'mkdir', side_effect=mkdir):
            home = self.prepare.install_archive(archive, destination, ['good'])
        self.assertEqual((home / 'good').read_bytes(), b'public bytes')
        self.assertEqual((collided[0] / 'preserve').read_bytes(), b'other task')
        self.assertEqual(len(stages), 2)
        self.assertNotEqual(stages[0], stages[1])
        self.assertFalse(stages[1].exists())

    def test_archive_and_path_policy_without_python313_isreserved(self):
        archive = self.archive([('home/good', b'ok')])
        with patch.dict(ntpath.__dict__):
            ntpath.__dict__.pop('isreserved', None)
            try:
                destination = self.root / 'portable'
                home = self.prepare.install_archive(archive, destination, ['good'])
                self.assertEqual((home / 'good').read_bytes(), b'ok')
                for name in ('CON.txt', 'prn', 'AUX', 'NUL.log', 'CONIN$', 'CONOUT$',
                             'COM1.ext', 'com\u00b9.txt', 'LPT\u00b2', 'LPT9', 'file:ads',
                             'wild*', 'wild?', 'pipe|', 'quote"', 'less<', 'more>',
                             'control\x1f', 'trailing.', 'trailing '):
                    with self.subTest(name=name):
                        with self.assertRaises(ValueError):
                            self.prepare.checked_path(self.root / name, self.root)
                        archive = self.archive([('home/good', b'ok'), ('home/' + name, b'bad')])
                        with self.assertRaises(ValueError):
                            self.prepare.install_archive(archive, self.root / 'bad', ['good'])
                        self.assertFalse((self.root / 'bad/home').exists())
                for name in ('ordinary.exe', 'CONSOLE.txt', 'COM0.txt', 'COM10.txt', 'LPT0.txt'):
                    with self.subTest(valid_name=name):
                        self.assertEqual(self.prepare.checked_path(self.root / name, self.root),
                                         self.root / name)
            except AttributeError as error:
                self.fail('Python 3.13-only reserved-path dependency: ' + str(error))

    def test_reject_all_unsafe_zip_entries_before_writing_any_member(self):
        for index, name in enumerate(('../escape', '/absolute', 'C:/drive', 'C:drive',
                     'home/../escape', r'home\escape', 'home/file:ads',
                     '//server/share', 'home/trailing. ', 'home/CON')):
            with self.subTest(name=name):
                archive = self.archive([('home/good', b'ok'), (name, b'bad')])
                destination = self.root / ('extract-' + str(index))
                with self.assertRaises(ValueError):
                    self.prepare.install_archive(archive, destination, ['good'])
                self.assertFalse((destination / 'home/good').exists())
                self.assertFalse((self.root / 'escape').exists())

    def test_reject_zip_symlink_and_case_collisions(self):
        link = zipfile.ZipInfo('home/link')
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        for entries in ([('home/good', b'ok'), (link, b'outside')],
                        [('home/FILE', b'a'), ('home/file', b'b')]):
            archive = self.archive(entries)
            with self.assertRaises(ValueError):
                self.prepare.install_archive(archive, self.root / 'extract', ['good'])
            self.assertFalse((self.root / 'extract/home').exists())

    def test_hash_mismatch_and_offline_missing_archive_do_not_download(self):
        archive = self.archive([('home/good', b'ok')])
        asset = {'name': 'asset.zip', 'url': 'https://example.invalid/asset.zip',
                 'sha256': '0' * 64}
        with patch.object(self.prepare, 'urlopen', side_effect=AssertionError('network forbidden')):
            with self.assertRaises(ValueError):
                self.prepare.ensure_archive(self.root, asset, offline=True)
            archive.unlink()
            with self.assertRaises(FileNotFoundError):
                self.prepare.ensure_archive(self.root, asset, offline=True)

    def test_reuse_verified_archive_and_installation_preserve_mismatch(self):
        archive = self.archive([('home/bin/java.exe', b'java'),
                                ('home/bin/javac.exe', b'javac')])
        asset = {'name': 'asset.zip', 'url': 'https://example.invalid/asset.zip',
                 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()}
        with patch.object(self.prepare, 'urlopen', side_effect=AssertionError('network forbidden')):
            self.assertEqual(self.prepare.ensure_archive(self.root, asset, offline=True), archive)
        destination = self.root / 'extract'
        required = ['bin/java.exe', 'bin/javac.exe']
        home = self.prepare.install_archive(archive, destination, required)
        self.assertEqual((home / 'bin/java.exe').read_bytes(), b'java')
        self.assertEqual(self.prepare.install_archive(archive, destination, required), home)
        (home / 'bin/java.exe').write_bytes(b'existing modification')
        with self.assertRaises(ValueError):
            self.prepare.install_archive(archive, destination, required)
        self.assertEqual((home / 'bin/java.exe').read_bytes(), b'existing modification')

    def test_missing_required_engine_file_never_installs(self):
        archive = self.archive([('home/bin/java.exe', b'java')])
        with self.assertRaises(ValueError):
            self.prepare.install_archive(archive, self.root / 'extract',
                                         ['bin/java.exe', 'bin/javac.exe'])
        self.assertFalse((self.root / 'extract/home').exists())

    def test_reparse_component_rejected_before_resolution_and_extraction(self):
        destination = self.root / 'extract'
        destination.mkdir()
        original = Path.lstat

        def lstat(path, *args, **kwargs):
            actual = original(path, *args, **kwargs)
            if path == destination:
                return SimpleNamespace(st_mode=actual.st_mode, st_file_attributes=0x400)
            return actual

        archive = self.archive([('home/good', b'ok')])
        with patch.object(Path, 'lstat', lstat):
            with self.assertRaises(ValueError):
                self.prepare.install_archive(archive, destination, ['good'])
        self.assertFalse((destination / 'home').exists())

    def test_prepare_writes_runtime_for_pinned_synthetic_assets_only(self):
        destination = self.root / 'local-only/rea-windows'
        destination.mkdir(parents=True)
        assets = []
        for name, entries in (
            ('ghidra.zip', [('ghidra/support/analyzeHeadless.bat', b'headless'),
                            ('ghidra/Ghidra/Features/Decompiler/os/win_x86_64/decompile.exe', b'decompiler')]),
            ('jdk.zip', [('jdk/bin/java.exe', b'java'), ('jdk/bin/javac.exe', b'javac')]),
        ):
            archive = destination / name
            with zipfile.ZipFile(archive, 'w') as output:
                for member, content in entries:
                    output.writestr(member, content)
            assets.append({'name': name, 'url': 'https://example.invalid/' + name,
                           'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()})
        package = self.root / 'local-only/rea/node_modules/rea-agents'
        (package / 'scripts').mkdir(parents=True)
        (package / 'scripts/rea.mjs').write_bytes(b'synthetic CLI')
        (package / 'package.json').write_text('{"version":"6.5.0"}', encoding='utf-8')
        node = self.root / 'node.exe'
        node.write_bytes(b'synthetic node')
        with patch.object(self.prepare, 'ASSETS', assets), \
                patch.object(self.prepare.shutil, 'which', return_value=str(node)), \
                patch.object(self.prepare, 'urlopen', side_effect=AssertionError('network forbidden')):
            result = self.prepare.prepare(self.root, offline=True)
        stored = json.loads((destination / 'runtime.json').read_text(encoding='utf-8'))
        self.assertEqual(stored, result)
        self.assertEqual(stored['node'], str(node))
        self.assertEqual(stored['versions']['rea'], '6.5.0')
        self.assertEqual(stored['temp_root'], str(self.root / 'local-only/rea-temp'))


class RunnerTests(ToolCase):
    def test_dotted_project_temp_is_rejected_before_any_engine_or_output(self):
        self.root = self.root / 'synthetic.user'
        self.root.mkdir()
        self.fixture()
        with self.assertRaisesRegex(ValueError, 'runtime_requires_dot_free_project_temp'):
            self.runner.load_runtime(self.root)
        with patch.object(self.runner, 'ROOT', self.root), \
                patch.object(self.runner.subprocess, 'Popen', side_effect=AssertionError('must not spawn')) as spawn, \
                contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as failure:
            self.runner.main(['doctor', '--label', 'dotted'])
        self.assertEqual(failure.exception.code, 2)
        spawn.assert_not_called()
        self.assertFalse((self.root / 'local-only/rea-evidence').exists())
        self.assertFalse((self.root / 'local-only/rea-temp').exists())

    def test_unhealthy_zero_exit_is_a_failed_receipt(self):
        self.fixture()
        code, receipt, _, _ = self.invoke(['doctor', '--label', 'unhealthy'],
                                          stdout=b'{"healthy":false}')
        self.assertEqual(code, 1)
        self.assertEqual(receipt['exit_code'], 0)
        self.assertFalse(receipt['success'])
        self.assertTrue(receipt['structured_error'])

    def test_canonical_rea_errors_zero_exit_are_failed_receipts(self):
        self.fixture()
        canonical = {'code': 'provider_unavailable', 'category': 'unavailable',
                     'message': 'synthetic private provider error', 'retryable': False,
                     'remediation': {'action': 'synthetic private remediation'}}
        cases = [canonical, {'error': 'operation_failed', **canonical}, {'error': canonical}]
        for index, value in enumerate(cases):
            with self.subTest(envelope=index):
                raw = json.dumps(value).encode('utf-8')
                code, receipt, _, console = self.invoke(
                    ['doctor', '--label', 'canonical-' + str(index)], stdout=raw)
                self.assertEqual(code, 1)
                self.assertEqual(receipt['exit_code'], 0)
                self.assertFalse(receipt['success'])
                self.assertTrue(receipt['structured_error'])
                self.assertNotIn('synthetic private', console)
                self.assertEqual((self.root / receipt['output']).read_bytes(), raw)

    def test_healthy_and_nonerror_metadata_remain_successful(self):
        self.fixture()
        for index, value in enumerate(({'healthy': True},
                                       {'code': 'metadata', 'message': 'synthetic result'})):
            with self.subTest(value=value):
                code, receipt, _, _ = self.invoke(
                    ['capabilities', '--label', 'healthy-' + str(index)],
                    stdout=json.dumps(value).encode('utf-8'))
                self.assertEqual(code, 0)
                self.assertTrue(receipt['success'])

    def test_installed_cli_version_must_match_pinned_runtime(self):
        config, _, _ = self.fixture()
        package = Path(config['rea_cli']).parent.parent / 'package.json'
        package.write_text('{"version":"99.0.0"}', encoding='utf-8')
        with patch.object(self.runner, 'ROOT', self.root), \
                patch.object(self.runner.subprocess, 'Popen', side_effect=AssertionError('must not spawn')), \
                contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as failure:
            self.runner.main(['capabilities', '--label', 'version'])
        self.assertEqual(failure.exception.code, 2)

    def test_exact_bounded_command_arguments(self):
        config, target, manifest = self.fixture()
        cases = [
            ('doctor', [], ['doctor', '--provider', 'ghidra', '--format', 'json']),
            ('mcp-doctor', [], ['mcp', 'doctor', '--format', 'json']),
            ('capabilities', [], ['capabilities', '--format', 'json']),
            ('analyze', [], ['analyze', str(target), '--provider', 'ghidra', '--format', 'json']),
            ('search', ['--query=--danger', '--kind', 'strings'],
             ['search', str(target), '--pattern=--danger', '--kind', 'strings', '--provider', 'ghidra', '--format', 'json']),
            ('function', ['--address=--danger'],
             ['function', str(target), '--procedure=--danger', '--provider', 'ghidra', '--format', 'json']),
            ('xrefs', ['--address=--danger'],
             ['xrefs', str(target), '--address=--danger', '--provider', 'ghidra', '--format', 'json']),
        ]
        for index, (action, options, expected) in enumerate(cases):
            with self.subTest(action=action):
                argv = [action, '--label', 'case-' + str(index), *options]
                if action in {'analyze', 'search', 'function', 'xrefs'}:
                    argv += ['--target', str(target)]
                code, receipt, calls, console = self.invoke(argv)
                self.assertEqual(code, 0)
                self.assertTrue(receipt['success'])
                self.assertEqual(calls[0][0], [config['node'], config['rea_cli'], *expected])
                self.assertEqual(calls[0][1]['creationflags'], getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                self.assertFalse(receipt['account_used'])
                self.assertFalse(receipt['target_executed'])
                if '--target' in argv:
                    self.assertEqual(receipt['source_sha256'], manifest['sha256'])
                self.assertNotIn('synthetic private', console)

    def test_child_environment_strips_overrides_and_does_not_mutate_parent(self):
        config, target, _ = self.fixture()
        injected = {'KAKAO_TOKEN': 'private-value', 'kakao_password': 'private-value',
                    'NODE_OPTIONS': '--require unwanted', 'NODE_DEBUG': '*',
                    'REA_ANALYSIS_PROVIDER': 'other', 'REA_OTHER': 'unwanted',
                    'rea_lower_override': 'unwanted', 'HOME': 'keep-home',
                    'CODEX_HOME': 'keep-codex-home'}
        with patch.dict(os.environ, injected):
            before = dict(os.environ)
            _, _, calls, _ = self.invoke(['analyze', '--target', str(target), '--label', 'env'])
            self.assertEqual(dict(os.environ), before)
        child = calls[0][1]['env']
        for key in ('KAKAO_TOKEN', 'kakao_password', 'NODE_OPTIONS', 'NODE_DEBUG',
                    'REA_OTHER', 'rea_lower_override'):
            self.assertNotIn(key, child)
        self.assertEqual(child['REA_ANALYSIS_PROVIDER'], 'ghidra')
        self.assertEqual(child['JAVA_HOME'], config['java_home'])
        self.assertEqual(child['GHIDRA_INSTALL_DIR'], config['ghidra_install_dir'])
        self.assertEqual(child['TEMP'], config['temp_root'])
        self.assertEqual(child['TMP'], config['temp_root'])
        self.assertGreater(int(child['REA_GHIDRA_STARTUP_TIMEOUT_MS']), 0)
        self.assertEqual(child['HOME'], 'keep-home')
        self.assertEqual(child['CODEX_HOME'], 'keep-codex-home')

    def test_target_lexical_traversal_outside_hash_and_manifest_mismatch_rejected(self):
        _, target, _ = self.fixture()
        outside = self.root / 'installed/Example.exe'
        outside.parent.mkdir()
        outside.write_bytes(target.read_bytes())
        bad_targets = [str(outside), str(target.parent / '..' / 'sample' / target.name)]
        with patch.object(self.runner, 'ROOT', self.root), \
                patch.object(self.runner.subprocess, 'Popen', side_effect=AssertionError('must not spawn')):
            for bad_target in bad_targets:
                with self.subTest(target=bad_target), contextlib.redirect_stderr(io.StringIO()):
                    with self.assertRaises(SystemExit) as failure:
                        self.runner.main(['analyze', '--label', 'unsafe', '--target', bad_target])
                    self.assertEqual(failure.exception.code, 2)
            target.write_bytes(b'tampered')
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                self.runner.main(['analyze', '--label', 'hash', '--target', str(target)])

    def test_manifest_different_copy_and_reparse_component_rejected(self):
        _, target, manifest = self.fixture()
        manifest_path = target.parent / 'manifest.json'
        manifest['analysis_copy'] = 'local-only/pc-analysis/other/Example.exe'
        manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
        with self.assertRaises(ValueError):
            self.runner.validate_target(target, self.root)
        manifest['analysis_copy'] = target.relative_to(self.root).as_posix()
        manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
        original = Path.lstat

        def lstat(path, *args, **kwargs):
            actual = original(path, *args, **kwargs)
            if path == target.parent:
                return SimpleNamespace(st_mode=actual.st_mode, st_file_attributes=0x400)
            return actual

        with patch.object(Path, 'lstat', lstat), self.assertRaises(ValueError):
            self.runner.validate_target(target, self.root)

    def test_label_collisions_preserve_every_existing_artifact(self):
        self.fixture()
        output = self.root / 'local-only/rea-evidence/pc'
        output.mkdir(parents=True)
        for index, suffix in enumerate(('.json', '.stderr.txt', '-receipt.json')):
            label = 'collision-' + str(index)
            existing = output / (label + suffix)
            existing.write_bytes(b'preserve')
            with patch.object(self.runner, 'ROOT', self.root), \
                    patch.object(self.runner.subprocess, 'Popen', side_effect=AssertionError('must not spawn')), \
                    contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                self.runner.main(['doctor', '--label', label])
            self.assertEqual(existing.read_bytes(), b'preserve')
            self.assertEqual(len(list(output.glob(label + '*'))), 1)

    def test_unbounded_actions_labels_and_timeout_rejected(self):
        self.fixture()
        for argv in (['run', '--label', 'x'], ['doctor', '--label', '../x'],
                     ['doctor'], ['doctor', '--label', 'x', '--timeout', 'nan'],
                     ['doctor', '--label', 'x', '--timeout', '0'],
                     ['doctor', '--label', 'x', '--timeout', '1801']):
            with self.subTest(argv=argv), patch.object(self.runner, 'ROOT', self.root), \
                    patch.object(self.runner.subprocess, 'Popen', side_effect=AssertionError('must not spawn')), \
                    contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                self.runner.main(argv)

    def test_failure_structured_error_and_timeout_are_not_success(self):
        self.fixture()
        cases = [('nonzero', b'{"ok":true}', 7, None, 7),
                 ('error', b'{"error":{"message":"private error"}}', 0, None, 1),
                 ('failed', b'{"success":false}', 0, None, 1),
                 ('invalid', b'not json', 0, None, 1),
                 ('timeout', b'{"partial":true}', 0, subprocess.TimeoutExpired('synthetic', 1), 124),
                 ('spawn', b'', 0, OSError('private exception'), 1)]
        for label, stdout, child_code, failure, expected in cases:
            with self.subTest(label=label):
                code, receipt, _, console = self.invoke(
                    ['doctor', '--label', label, '--timeout', '1'],
                    stdout, child_code, failure)
                self.assertEqual(code, expected)
                self.assertFalse(receipt['success'])
                self.assertEqual(receipt['timed_out'], label == 'timeout')
                if failure is None:
                    self.assertEqual(receipt['exit_code'], child_code)
                else:
                    self.assertIsNone(receipt['exit_code'])
                raw = self.root / receipt['output']
                self.assertEqual(raw.read_bytes(), stdout)
                self.assertEqual(receipt['output_sha256'], hashlib.sha256(stdout).hexdigest())
                self.assertNotIn('private', console)
                stored = self.root / 'local-only/rea-evidence/pc' / (label + '-receipt.json')
                self.assertEqual(json.loads(stored.read_text(encoding='utf-8')), receipt)

    def test_timeout_tree_cleanup_failure_remains_visible(self):
        self.fixture()
        code, receipt, calls, _ = self.invoke(
            ['doctor', '--label', 'cleanup', '--timeout', '1'],
            failure=subprocess.TimeoutExpired('synthetic', 1), cleanup_code=5)
        self.assertEqual(code, 124)
        self.assertFalse(receipt['success'])
        self.assertEqual(receipt['cleanup_status'], 'failed')
        self.assertTrue(receipt['cleanup_attempted'])
        self.assertEqual(calls[1][0][1:], ['/PID', '4242', '/T', '/F'])
        self.assertTrue(calls[1][0][0].lower().endswith('system32\\taskkill.exe'))

    def test_timeout_already_exited_child_does_not_kill_reused_pid(self):
        calls = []

        class Exited:
            pid = 4242
            returncode = 0

            def __init__(self, *args, **kwargs):
                pass

            def communicate(self, timeout):
                raise subprocess.TimeoutExpired('synthetic', 1)

            def poll(self):
                return 0

        self.fixture()
        with patch.object(self.runner, 'ROOT', self.root), \
                patch.object(self.runner.subprocess, 'Popen', Exited), \
                patch.object(self.runner.subprocess, 'run', side_effect=lambda *a, **k: calls.append(a)), \
                contextlib.redirect_stdout(io.StringIO()) as console:
            self.assertEqual(self.runner.main(['doctor', '--label', 'already-exited']), 124)
        receipt = json.loads(console.getvalue())
        self.assertFalse(receipt['cleanup_attempted'])
        self.assertEqual(receipt['cleanup_status'], 'parent_exited_tree_unverified')
        self.assertTrue(receipt['timed_out'])
        self.assertFalse(receipt['success'])
        self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main()
