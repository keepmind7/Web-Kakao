"""WSL 진입점의 무계정·격리 계약. 실제 Linux 프로세스를 시작하지 않는다."""
import contextlib
import io
import json
import os
from pathlib import Path
import posixpath
import subprocess
import unittest
from unittest.mock import patch

from tools import runtime_distribution, safe_download, verify_linux


class LinuxVerifierContracts(unittest.TestCase):
    def test_help_and_bad_arguments_do_not_execute(self):
        for arguments, expected in [(['--help'], 0), (['--suite', 'invalid'], 2)]:
            with self.subTest(arguments=arguments), patch.object(verify_linux, 'run_checks') as run, contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as raised:
                    verify_linux.main(arguments)
                self.assertEqual(raised.exception.code, expected)
                run.assert_not_called()

    def test_windows_is_rejected_before_checks(self):
        with patch.object(verify_linux.sys, 'platform', 'win32'), patch.object(verify_linux, 'run_checks') as run, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                verify_linux.main(['--suite', 'mock'])
            run.assert_not_called()

    def test_environment_drops_live_secrets_and_has_own_data_root(self):
        folder = Path.cwd() / 'local-only' / 'synthetic-verifier-root'
        with patch.object(Path, 'mkdir') as created:
            env = verify_linux.isolated_environment(folder, {'PATH': '/usr/bin', 'HOME': '/real/home',
                        'XDG_DATA_HOME': '/real/data', 'NODE_OPTIONS': 'SYNTHETIC',
                        'NODE_TLS_REJECT_UNAUTHORIZED': '0', 'KAKAO_TOKEN': 'SYNTHETIC',
                        'WEB_KAKAO_PYTHON': '/untrusted', 'HTTP_PROXY': 'SYNTHETIC'})
            self.assertEqual(env['HOME'], str(folder / 'home'))
            self.assertEqual(env['XDG_DATA_HOME'], str(folder / 'data'))
            for name in ('NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'KAKAO_TOKEN', 'WEB_KAKAO_PYTHON', 'HTTP_PROXY'):
                self.assertNotIn(name, env)
            self.assertEqual(created.call_count, 7)
            self.assertTrue(all(call.kwargs == {'mode': 0o700} for call in created.call_args_list))

    def test_umask_is_restored_after_failure(self):
        with patch.object(verify_linux.sys, 'platform', 'linux'), patch.object(verify_linux, 'run_checks', side_effect=RuntimeError('synthetic failure')), patch.object(verify_linux.os, 'umask', side_effect=[0o022, 0o077]) as masks, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(verify_linux.main(['--suite', 'mock']), 1)
            self.assertEqual(masks.call_args_list[0].args, (0o077,))
            self.assertEqual(masks.call_args_list[-1].args, (0o022,))

    def traceback(self, exception='AttributeError', source='tools/private_storage.py', line='56'):
        return ('Traceback (most recent call last):\n'
                f'  File "{verify_linux.ROOT / source}", line {line}, in synthetic\n'
                '    SYNTHETIC_SECRET_SOURCE_LINE\n'
                f'{exception}: SYNTHETIC_SECRET_MESSAGE https://secret.invalid/?token=PRIVATE\n')

    def run_mock(self, outcomes, *, browser=False, suite='mock', environment=None, browser_allocation=None):
        """Every process, directory, port and permission change is synthetic."""
        stdout, stderr = io.StringIO(), io.StringIO()
        folder = verify_linux.ROOT / 'local-only' / 'qa-linux' / 'isolated-synthetic'
        environment = {'HOME': str(folder / 'home')} if environment is None else environment
        def allocate(*, prefix, dir):
            if prefix == 'isolated-':
                return str(folder)
            self.assertEqual((prefix, dir), ('wk-', '/tmp'))
            if isinstance(browser_allocation, Exception):
                raise browser_allocation
            return '/tmp/wk-abcdefgh' if browser_allocation is None else browser_allocation
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(verify_linux.sys, 'platform', 'linux'))
            stack.enter_context(patch.object(verify_linux.os, 'umask', return_value=0o022))
            stack.enter_context(patch.object(verify_linux, 'linux_checkout', return_value=True))
            stack.enter_context(patch.object(runtime_distribution, 'runtime_path', return_value=folder / 'node'))
            stack.enter_context(patch.object(safe_download, 'checked_path', return_value=folder.parent))
            stack.enter_context(patch.object(Path, 'is_file', return_value=True))
            stack.enter_context(patch.object(Path, 'mkdir'))
            allocated = stack.enter_context(patch.object(verify_linux.tempfile, 'mkdtemp', side_effect=allocate))
            stack.enter_context(patch.object(verify_linux, 'isolated_environment', return_value=environment))
            stack.enter_context(patch.object(verify_linux, 'free_port', return_value=43210))
            run = stack.enter_context(patch.object(verify_linux.subprocess, 'run', side_effect=outcomes))
            stack.enter_context(contextlib.redirect_stdout(stdout))
            stack.enter_context(contextlib.redirect_stderr(stderr))
            code = verify_linux.main(['--suite', suite, *(['--browser'] if browser else [])])
        self.last_temp_calls = allocated.call_args_list
        return code, stdout.getvalue(), stderr.getvalue(), run.call_args_list

    def assert_no_child_secrets(self, output):
        for text in ('SYNTHETIC_SECRET', 'PRIVATE', 'secret.invalid', str(verify_linux.ROOT)):
            self.assertNotIn(text, output)

    def test_known_exception_has_only_safe_relative_location(self):
        diagnostic = verify_linux.safe_python_diagnostic(self.traceback(), verify_linux.ROOT)
        self.assertEqual(diagnostic, ' 진단: AttributeError · tools/private_storage.py:56')
        self.assert_no_child_secrets(diagnostic)

    def test_unknown_exception_has_no_diagnostic(self):
        self.assertEqual(verify_linux.safe_python_diagnostic(self.traceback(exception='SecretAccountError'), verify_linux.ROOT), '')

    def test_untrusted_frame_paths_have_no_diagnostic(self):
        for source in ('private-secrets.py', 'tools/unknown-secret.py', 'tools/../tools/private_storage.py'):
            with self.subTest(source=source):
                self.assertEqual(verify_linux.safe_python_diagnostic(self.traceback(source=source), verify_linux.ROOT), '')

    def test_malformed_frame_and_nontraceback_have_no_diagnostic(self):
        for error in (None, b'SYNTHETIC_SECRET', 'AttributeError: SYNTHETIC_SECRET',
                      self.traceback(line='0'), self.traceback(line='1000000'),
                      self.traceback() + 'SYNTHETIC_SECRET_NOTE\n', 'x' * 65537):
            with self.subTest(kind=type(error).__name__):
                self.assertEqual(verify_linux.safe_python_diagnostic(error, verify_linux.ROOT), '')

    def test_chained_traceback_only_uses_last_exception(self):
        child = self.traceback() + '\nDuring handling of the above exception, another exception occurred:\n\n'
        child += self.traceback(exception='PermissionError', source='tools/platforms/linux.py', line='151')
        diagnostic = verify_linux.safe_python_diagnostic(child, verify_linux.ROOT)
        self.assertEqual(diagnostic, ' 진단: PermissionError · tools/platforms/linux.py:151')
        self.assertNotIn('AttributeError', diagnostic)
        self.assert_no_child_secrets(diagnostic)

    def test_start_failure_and_cleanup_return_failure_both_remain_visible(self):
        outcomes = [subprocess.CompletedProcess([], 1, stdout='SYNTHETIC_SECRET_STDOUT', stderr=self.traceback()),
                    subprocess.CompletedProcess([], 1, stdout='SYNTHETIC_SECRET_STOP', stderr=self.traceback(exception='PermissionError'))]
        code, stdout, stderr, calls = self.run_mock(outcomes)
        self.assertEqual(code, 1)
        self.assertEqual(stdout, '')
        self.assertIn('mock-start 검사 실패. 종료 코드 1', stderr)
        self.assertIn('AttributeError · tools/private_storage.py:56', stderr)
        self.assertIn('격리 mock 종료를 확인하지 못했습니다.', stderr)
        self.assertIn('PermissionError · tools/private_storage.py:56', stderr)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0].args[0][-4:], ['start', '--mock', '--port', '43210'])
        self.assertEqual(calls[1].args[0][-1], 'stop')
        self.assert_no_child_secrets(stdout + stderr)

    def test_cleanup_timeout_preserves_start_failure(self):
        code, stdout, stderr, calls = self.run_mock([
            subprocess.CompletedProcess([], 7, stdout='SYNTHETIC_SECRET', stderr=self.traceback()),
            subprocess.TimeoutExpired('SYNTHETIC_SECRET_CMD', 20, output='SYNTHETIC_SECRET', stderr='SYNTHETIC_SECRET'),
        ])
        self.assertEqual(code, 1)
        self.assertIn('mock-start 검사 실패. 종료 코드 7', stderr)
        self.assertIn('종료 확인 제한 시간을 초과했습니다.', stderr)
        self.assertEqual(len(calls), 2)
        self.assert_no_child_secrets(stdout + stderr)

    def test_cleanup_oserror_preserves_start_failure(self):
        code, stdout, stderr, calls = self.run_mock([
            subprocess.CompletedProcess([], 3, stdout='SYNTHETIC_SECRET', stderr=self.traceback()),
            OSError('SYNTHETIC_SECRET absolute-path'),
        ])
        self.assertEqual(code, 1)
        self.assertIn('mock-start 검사 실패. 종료 코드 3', stderr)
        self.assertIn('종료 확인 명령을 실행하지 못했습니다.', stderr)
        self.assertEqual(len(calls), 2)
        self.assert_no_child_secrets(stdout + stderr)

    def test_start_timeout_has_fixed_message_and_authenticated_cleanup(self):
        code, stdout, stderr, calls = self.run_mock([
            subprocess.TimeoutExpired('SYNTHETIC_SECRET_CMD', 40, output='SYNTHETIC_SECRET', stderr='SYNTHETIC_SECRET'),
            subprocess.CompletedProcess([], 0, stdout='SYNTHETIC_SECRET', stderr='SYNTHETIC_SECRET'),
        ])
        self.assertEqual(code, 1)
        self.assertIn('mock-start 검사 제한 시간을 초과했습니다.', stderr)
        self.assertEqual(calls[1].args[0][-1], 'stop')
        self.assert_no_child_secrets(stdout + stderr)

    def test_start_oserror_has_fixed_message(self):
        code, stdout, stderr, _ = self.run_mock([
            OSError('SYNTHETIC_SECRET_PATH'),
            subprocess.CompletedProcess([], 0, stdout='SYNTHETIC_SECRET', stderr='SYNTHETIC_SECRET'),
        ])
        self.assertEqual(code, 1)
        self.assertIn('mock-start 검사 명령을 실행하지 못했습니다.', stderr)
        self.assert_no_child_secrets(stdout + stderr)

    def test_unknown_child_stderr_stays_generic(self):
        code, stdout, stderr, _ = self.run_mock([
            subprocess.CompletedProcess([], 1, stdout='SYNTHETIC_SECRET', stderr=self.traceback(exception='SecretAccountError')),
            subprocess.CompletedProcess([], 0),
        ])
        self.assertEqual(code, 1)
        self.assertNotIn('진단:', stderr)
        self.assertIn('mock-start 검사 실패. 종료 코드 1', stderr)
        self.assert_no_child_secrets(stdout + stderr)

    def test_unexpected_local_exception_message_is_not_printed(self):
        stderr = io.StringIO()
        with patch.object(verify_linux.sys, 'platform', 'linux'), patch.object(verify_linux, 'run_checks', side_effect=ValueError('SYNTHETIC_SECRET')), patch.object(verify_linux.os, 'umask', return_value=0o022), contextlib.redirect_stderr(stderr):
            self.assertEqual(verify_linux.main(['--suite', 'mock']), 1)
        self.assertEqual(stderr.getvalue(), '격리 Linux 검사를 완료하지 못했습니다.\n')
        self.assert_no_child_secrets(stderr.getvalue())

    def test_mock_success_omits_child_text_and_never_repeats_stop(self):
        status = {'mode': 'mock', 'credentialInMemory': False, 'chatConnectionActive': False,
                  'ignoredSecret': 'SYNTHETIC_SECRET'}
        code, stdout, stderr, calls = self.run_mock([
            subprocess.CompletedProcess([], 0, stdout='SYNTHETIC_SECRET', stderr='SYNTHETIC_SECRET'),
            subprocess.CompletedProcess([], 0, stdout=json.dumps(status), stderr='SYNTHETIC_SECRET'),
            subprocess.CompletedProcess([], 0, stdout='SYNTHETIC_SECRET', stderr='SYNTHETIC_SECRET'),
        ])
        self.assertEqual(code, 0)
        self.assertEqual(stderr, '')
        self.assertEqual(json.loads(stdout)['checks'], [
            {'check': 'mock-start', 'exitCode': 0}, {'check': 'mock-status', 'exitCode': 0},
            {'check': 'mock-stop', 'exitCode': 0},
        ])
        self.assertTrue(json.loads(stdout)['mockStopped'])
        self.assertEqual(len(calls), 3)
        self.assertEqual(len(self.last_temp_calls), 1)
        self.assertEqual(self.last_temp_calls[0].kwargs['prefix'], 'isolated-')
        self.assert_no_child_secrets(stdout + stderr)

    def successful_status(self):
        return subprocess.CompletedProcess([], 0, stdout=json.dumps({
            'mode': 'mock', 'credentialInMemory': False, 'chatConnectionActive': False,
        }))

    def test_browser_uses_short_private_tmp_without_changing_other_env(self):
        long_root = '/home/synthetic/' + 'long-project-root-' * 16
        environment = {name: long_root + '/' + suffix for name, suffix in (
            ('HOME', 'home'), ('XDG_DATA_HOME', 'data'), ('XDG_CONFIG_HOME', 'config'),
            ('XDG_STATE_HOME', 'state'), ('XDG_CACHE_HOME', 'cache'), ('TMPDIR', 'tmp'),
            ('WEB_KAKAO_QA_OUTPUT_ROOT', 'browser'),
        )}
        environment.update({'PATH': '/usr/bin', 'DISPLAY': ':0', 'PYTHONIOENCODING': 'utf-8'})
        original = environment.copy()
        outcomes = [subprocess.CompletedProcess([], 0), self.successful_status(),
                    *[subprocess.CompletedProcess([], 0) for _ in range(6)]]
        code, stdout, stderr, calls = self.run_mock(outcomes, browser=True, suite='platform', environment=environment)
        self.assertEqual(code, 0)
        self.assertEqual(stderr, '')
        self.assertEqual(len(calls), 8)
        browser_env = calls[-2].kwargs['env']
        self.assertEqual(browser_env['TMPDIR'], '/tmp/wk-abcdefgh')
        self.assertIsNot(browser_env, environment)
        self.assertEqual(environment, original)
        self.assertEqual({key: value for key, value in browser_env.items() if key != 'TMPDIR'},
                         {key: value for key, value in original.items() if key != 'TMPDIR'})
        for call in calls[:-2] + calls[-1:]:
            self.assertIs(call.kwargs['env'], environment)
        self.assertTrue(calls[-2].args[0][-1].endswith('reader-browser-smoke.mjs'))
        suffix = 'com.google.Chrome.' + 'x' * 32 + '/SingletonSocket'
        self.assertGreater(len(posixpath.join(original['TMPDIR'], suffix).encode('utf-8')), 107)
        self.assertLessEqual(len(posixpath.join(browser_env['TMPDIR'], suffix).encode('utf-8')), 107)
        self.assertEqual(len(self.last_temp_calls), 2)
        self.assertEqual(self.last_temp_calls[1].kwargs, {'prefix': 'wk-', 'dir': '/tmp'})
        self.assertTrue(json.loads(stdout)['browserExecuted'])
        self.assertTrue(json.loads(stdout)['mockStopped'])

    def test_browser_allocation_failure_keeps_fixed_error_and_authenticated_stop(self):
        environment = {'HOME': '/synthetic/home', 'TMPDIR': '/synthetic/long/tmp'}
        code, stdout, stderr, calls = self.run_mock([
            subprocess.CompletedProcess([], 0), self.successful_status(),
            subprocess.CompletedProcess([], 0),
        ], browser=True, environment=environment, browser_allocation=OSError('SYNTHETIC_SECRET_PATH'))
        self.assertEqual(code, 1)
        self.assertEqual(stdout, '')
        self.assertIn('격리 브라우저 임시 디렉터리를 준비하지 못했습니다.', stderr)
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[-1].args[0][-1], 'stop')
        self.assertTrue(all(call.kwargs['env'] is environment for call in calls))
        self.assertEqual(environment['TMPDIR'], '/synthetic/long/tmp')
        self.assertEqual(len(self.last_temp_calls), 2)
        self.assert_no_child_secrets(stdout + stderr)

    def test_browser_failure_stops_mock_with_original_environment(self):
        environment = {'HOME': '/synthetic/home', 'TMPDIR': '/synthetic/original/tmp',
                       'WEB_KAKAO_QA_OUTPUT_ROOT': '/synthetic/browser-output'}
        code, stdout, stderr, calls = self.run_mock([
            subprocess.CompletedProcess([], 0), self.successful_status(),
            subprocess.CompletedProcess([], 7, stdout='SYNTHETIC_SECRET', stderr='SYNTHETIC_SECRET'),
            subprocess.CompletedProcess([], 0),
        ], browser=True, environment=environment)
        self.assertEqual(code, 1)
        self.assertIn('isolated-browser 검사 실패. 종료 코드 7', stderr)
        self.assertEqual(len(calls), 4)
        self.assertEqual(calls[-2].kwargs['env']['TMPDIR'], '/tmp/wk-abcdefgh')
        self.assertEqual(calls[-1].args[0][-1], 'stop')
        self.assertIs(calls[-1].kwargs['env'], environment)
        self.assert_no_child_secrets(stdout + stderr)

    def test_browser_timeout_and_stop_failure_preserve_both_errors(self):
        code, stdout, stderr, calls = self.run_mock([
            subprocess.CompletedProcess([], 0), self.successful_status(),
            subprocess.TimeoutExpired('SYNTHETIC_SECRET_CMD', 300, output='SYNTHETIC_SECRET'),
            OSError('SYNTHETIC_SECRET_STOP'),
        ], browser=True)
        self.assertEqual(code, 1)
        self.assertIn('isolated-browser 검사 제한 시간을 초과했습니다.', stderr)
        self.assertIn('종료 확인 명령을 실행하지 못했습니다.', stderr)
        self.assertEqual(calls[-1].args[0][-1], 'stop')
        self.assert_no_child_secrets(stdout + stderr)

    def test_failed_mock_start_does_not_allocate_browser_tmp(self):
        code, stdout, stderr, calls = self.run_mock([
            subprocess.CompletedProcess([], 2), subprocess.CompletedProcess([], 0),
        ], browser=True)
        self.assertEqual(code, 1)
        self.assertIn('mock-start 검사 실패. 종료 코드 2', stderr)
        self.assertEqual(len(self.last_temp_calls), 1)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[-1].args[0][-1], 'stop')

    def test_fixed_launcher_denial_is_only_reported_as_allowlisted_code(self):
        denial = '로컬 포트 소유자를 확인할 수 없습니다. 같은 OS 사용자와 권한으로 실행하세요.'
        code, stdout, stderr, _ = self.run_mock([
            subprocess.CompletedProcess([], 2, stdout=denial + ' 추가 시작을 중단했습니다.\n', stderr='SYNTHETIC_SECRET'),
            subprocess.CompletedProcess([], 2, stdout=denial + ' 브라우저를 열거나 종료를 보고하지 않았습니다.\n', stderr='SYNTHETIC_SECRET'),
        ])
        self.assertEqual(code, 1)
        self.assertIn('mock-start 검사 실패. 종료 코드 2', stderr)
        self.assertEqual(stderr.count('진단 코드: launcher_listener_unverified'), 2)
        self.assertNotIn(denial, stderr)
        self.assert_no_child_secrets(stdout + stderr)

    def test_launcher_diagnostic_rejects_secret_suffix_prefix_and_unknown_text(self):
        denial = '로컬 포트 소유자를 확인할 수 없습니다. 같은 OS 사용자와 권한으로 실행하세요.'
        for text in (None, b'SYNTHETIC_SECRET', 'SYNTHETIC_SECRET', denial + ' SYNTHETIC_SECRET',
                     'SYNTHETIC_SECRET ' + denial, 'x' * 65537):
            with self.subTest(kind=type(text).__name__):
                self.assertEqual(verify_linux.safe_launcher_diagnostic(text), '')

    def test_launcher_known_line_beside_arbitrary_secret_only_reports_fixed_code(self):
        child = ('SYNTHETIC_SECRET_PATH https://secret.invalid/?token=PRIVATE\n'
                 '경고: 포트의 서버가 실행 권한을 증명하지 못했습니다. 사칭 가능성이 있어 권한 정보를 보내지 않았습니다.\n'
                 'SYNTHETIC_SECRET_FINAL\n')
        result = verify_linux.safe_launcher_diagnostic(child)
        self.assertEqual(result, ' 진단 코드: launcher_hmac_unverified')
        self.assert_no_child_secrets(result)
