"""Run bounded local static REA PC queries; console output is a private-data-free receipt."""
import argparse
from contextlib import ExitStack
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import time

if __package__:
    from .prepare_rea_windows import checked_path, digest, GHIDRA_FILES, JDK_FILES, VERSIONS
else:
    from prepare_rea_windows import checked_path, digest, GHIDRA_FILES, JDK_FILES, VERSIONS

ROOT = Path(__file__).resolve().parent.parent
NATIVE_ACTIONS = {'analyze', 'search', 'function', 'xrefs'}
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)


def validate_target(target, root):
    root = Path(root)
    target = checked_path(Path(target), root)
    if not target.is_relative_to(root / 'local-only/pc-analysis'):
        raise ValueError('target_outside_analysis_copies')
    if target.suffix.lower() not in {'.exe', '.dll'} or not stat.S_ISREG(target.stat().st_mode):
        raise ValueError('target_requires_regular_exe_or_dll')
    manifest_path = checked_path(target.parent / 'manifest.json', root)
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    if manifest.get('analysis_copy') != target.relative_to(root).as_posix():
        raise ValueError('manifest_analysis_copy_mismatch')
    expected = manifest.get('sha256', '')
    if not isinstance(expected, str) or not re.fullmatch('[0-9a-f]{64}', expected):
        raise ValueError('invalid_manifest_sha256')
    if digest(target) != expected:
        raise ValueError('target_sha256_mismatch')
    return target, expected


def load_runtime(root):
    path = checked_path(root / 'local-only/rea-windows/runtime.json', root)
    config = json.loads(path.read_text(encoding='utf-8'))
    if config['versions'] != VERSIONS:
        raise ValueError('runtime_versions_mismatch')
    expected_cli = root / 'local-only/rea/node_modules/rea-agents/scripts/rea.mjs'
    if Path(config['rea_cli']) != expected_cli:
        raise ValueError('runtime_rea_cli_mismatch')
    checked_path(expected_cli, root)
    package = checked_path(expected_cli.parent.parent / 'package.json', root)
    if json.loads(package.read_text(encoding='utf-8'))['version'] != VERSIONS['rea']:
        raise ValueError('installed_rea_version_mismatch')
    node = Path(config['node'])
    if not node.is_absolute() or node.name.lower() != 'node.exe':
        raise ValueError('runtime_requires_node_exe')
    checked_path(node, Path(node.anchor))
    if not node.is_file() or not expected_cli.is_file():
        raise ValueError('runtime_executable_missing')
    for key, required in (('java_home', JDK_FILES), ('ghidra_install_dir', GHIDRA_FILES)):
        home = checked_path(Path(config[key]), root)
        if not home.is_relative_to(root / 'local-only/rea-windows'):
            raise ValueError('runtime_engine_outside_installation')
        for member in required:
            if not checked_path(home / member, root).is_file():
                raise ValueError('runtime_engine_file_missing')
    temp = checked_path(Path(config['temp_root']), root)
    if temp != root / 'local-only/rea-temp' or '.' in str(temp):
        raise ValueError('runtime_requires_dot_free_project_temp')
    return config, digest(path)


def child_environment(config, timeout):
    env = {key: value for key, value in os.environ.items()
           if not key.upper().startswith(('KAKAO_', 'REA_'))
           and key.upper() not in {'NODE_OPTIONS', 'NODE_DEBUG', 'JAVA_HOME',
                                   'GHIDRA_INSTALL_DIR', 'TEMP', 'TMP'}}
    env.update({'JAVA_HOME': config['java_home'],
                'GHIDRA_INSTALL_DIR': config['ghidra_install_dir'],
                'REA_ANALYSIS_PROVIDER': 'ghidra',
                'REA_GHIDRA_STARTUP_TIMEOUT_MS': str(min(timeout, 180) * 1000),
                'TEMP': config['temp_root'], 'TMP': config['temp_root']})
    env['PATH'] = str(Path(config['node']).parent) + os.pathsep + env.get('PATH', '')
    return env


def cleanup_timeout(process, env, root):
    # Never send taskkill to a PID after this Popen reports its child exited.
    if process.poll() is not None:
        # The Node parent's exit does not prove that its descendants exited.
        # This status cannot establish that the native-engine lease is free.
        return False, 'parent_exited_tree_unverified', process.returncode
    status = 'succeeded'
    try:
        taskkill = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32/taskkill.exe'
        result = subprocess.run([str(taskkill), '/PID', str(process.pid), '/T', '/F'],
                                cwd=root, env=env, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, timeout=15,
                                creationflags=NO_WINDOW)
        if result.returncode != 0:
            status = 'failed'
    except (OSError, subprocess.SubprocessError):
        status = 'failed'
    try:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=10)
    except (OSError, subprocess.SubprocessError):
        status = 'failed'
    return True, status, process.returncode


def structured_error(value):
    if not isinstance(value, (dict, list)):
        return True
    if isinstance(value, list):
        return any(structured_error(item) for item in value if isinstance(item, dict))
    remediation = value.get('remediation')
    # REA 6.5 may return its canonical error projection directly, without
    # an error/ok/success envelope. Do not expose its private message in receipts.
    canonical_error = (all(isinstance(value.get(key), str) and value[key]
                           for key in ('code', 'category', 'message'))
                       and isinstance(value.get('retryable'), bool)
                       and isinstance(remediation, dict)
                       and isinstance(remediation.get('action'), str)
                       and bool(remediation['action']))
    return (value.get('healthy') is False or canonical_error
            or value.get('success') is False or value.get('ok') is False
            or bool(value.get('error')) or bool(value.get('errors'))
            or value.get('status') in ('error', 'failed', 'failure'))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['doctor', 'mcp-doctor', 'capabilities',
                                          'analyze', 'search', 'function', 'xrefs'])
    parser.add_argument('--target', type=Path)
    parser.add_argument('--query')
    parser.add_argument('--address')
    parser.add_argument('--kind', choices=['strings', 'procedures'], default='strings')
    parser.add_argument('--label', required=True)
    parser.add_argument('--timeout', type=int, default=900)
    args = parser.parse_args(argv)
    if not re.fullmatch('[A-Za-z0-9_-]{1,100}', args.label):
        parser.error('label requires 1..100 ASCII letters, digits, - or _')
    if not 1 <= args.timeout <= 1800:
        parser.error('timeout must be an integer from 1 to 1800 seconds')
    if args.action == 'search' and not args.query:
        parser.error('search requires --query')
    if args.action in {'function', 'xrefs'} and not args.address:
        parser.error('function and xrefs require --address')
    if args.action not in NATIVE_ACTIONS and args.target:
        parser.error('target is allowed only for native queries')
    try:
        config, runtime_sha = load_runtime(ROOT)
        target, source_sha = None, None
        if args.action in NATIVE_ACTIONS:
            if not args.target:
                raise ValueError('native_query_requires_target')
            target, source_sha = validate_target(args.target, ROOT)
        output = checked_path(ROOT / 'local-only/rea-evidence/pc', ROOT)
        paths = [checked_path(output / (args.label + suffix), ROOT)
                 for suffix in ('.json', '.stderr.txt', '-receipt.json')]
        if any(path.exists() for path in paths):
            raise ValueError('label_artifact_already_exists')
        temp = checked_path(Path(config['temp_root']), ROOT)
        temp.mkdir(parents=True, exist_ok=True)
        output.mkdir(parents=True, exist_ok=True)
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.error(type(error).__name__ + ': runtime, target or output validation failed')
    commands = {'doctor': ['doctor', '--provider', 'ghidra'],
                'mcp-doctor': ['mcp', 'doctor'], 'capabilities': ['capabilities']}
    command = commands.get(args.action, [args.action]).copy()
    if target:
        command += [str(target)]
    if args.action == 'search':
        command += ['--pattern=' + args.query, '--kind', args.kind]
    elif args.action == 'function':
        command += ['--procedure=' + args.address]
    elif args.action == 'xrefs':
        command += ['--address=' + args.address]
    if args.action in NATIVE_ACTIONS:
        command += ['--provider', 'ghidra']
    command += ['--format', 'json']
    command = [config['node'], config['rea_cli'], *command]
    env = child_environment(config, args.timeout)
    receipt = {'action': args.action, 'provider': 'ghidra', 'exit_code': None,
               'timed_out': False, 'timeout_seconds': args.timeout,
               'cleanup_attempted': False, 'cleanup_status': 'not_needed',
               'account_used': False, 'target_executed': False,
               'global_registration_changed': False, 'success': False,
               'runtime_sha256': runtime_sha, 'rea_cli_sha256': digest(config['rea_cli']),
               'source_sha256': source_sha,
               'output': paths[0].relative_to(ROOT).as_posix(),
               'stderr': paths[1].relative_to(ROOT).as_posix(),
               'started_at': datetime.now(timezone.utc).isoformat()}
    start = time.monotonic()
    # Exclusive creation also prevents collisions introduced after validation.
    created = []
    with ExitStack() as stack:
        try:
            streams = []
            for path in paths:
                streams.append(stack.enter_context(path.open('xb')))
                created.append(path)
        except OSError:
            stack.close()
            for path in created:
                path.unlink()
            parser.error('output reservation failed; existing artifacts preserved')
        stdout, stderr, receipt_stream = streams
        try:
            process = subprocess.Popen(command, cwd=ROOT, env=env, stdout=stdout,
                                       stderr=stderr, creationflags=NO_WINDOW)
            try:
                process.communicate(timeout=args.timeout)
                receipt['exit_code'] = process.returncode
            except subprocess.TimeoutExpired:
                receipt['timed_out'] = True
                attempted, status, exit_code = cleanup_timeout(process, env, ROOT)
                receipt.update(cleanup_attempted=attempted, cleanup_status=status,
                               post_cleanup_exit_code=exit_code)
        except OSError:
            receipt['failure'] = 'process_start_failed'
        stdout.close()
        stderr.close()
        receipt['duration_seconds'] = round(time.monotonic() - start, 3)
        receipt['output_sha256'] = digest(paths[0])
        receipt['stderr_sha256'] = digest(paths[1])
        bad_json = False
        try:
            bad_json = structured_error(json.loads(paths[0].read_text(encoding='utf-8-sig')))
        except (ValueError, UnicodeError):
            bad_json = True
        receipt['structured_error'] = bad_json
        receipt['success'] = (receipt['exit_code'] == 0 and not receipt['timed_out']
                              and not bad_json and receipt['cleanup_status'] != 'failed')
        code = 124 if receipt['timed_out'] else receipt['exit_code']
        if not receipt['success'] and not code:
            code = 1
        receipt['runner_exit_code'] = code
        receipt_stream.write((json.dumps(receipt, indent=2) + '\n').encode('utf-8'))
    print(json.dumps(receipt))
    return code


if __name__ == '__main__':
    raise SystemExit(main())
