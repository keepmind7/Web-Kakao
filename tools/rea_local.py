"""전역 등록 없이 프로젝트 내부 REA를 읽기 전용 정적 분석에 사용한다."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / 'local-only/rea-evidence'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['doctor', 'mcp-doctor', 'analyze-js', 'trace-feature', 'trace-semantics', 'inspect-apk', 'search-class', 'inspect-class', 'inspect-method', 'references'])
    parser.add_argument('--target', type=Path)
    parser.add_argument('--class-name')
    parser.add_argument('--method-name')
    parser.add_argument('--overload-index', type=int)
    parser.add_argument('--query', default='')
    parser.add_argument('--label', default='latest')
    args = parser.parse_args()
    if not args.label or not all(c.isascii() and (c.isalnum() or c in '-_') for c in args.label):
        parser.error('label must contain ASCII letters, digits, - or _')
    config = json.loads((ROOT / 'local-only/rea-android/runtime.json').read_text(encoding='utf-8'))
    env = {k: v for k, v in os.environ.items() if not k.startswith('KAKAO_') and k not in {'NODE_DEBUG', 'NODE_OPTIONS'}}
    env['JAVA_HOME'] = config['java_home']
    env['REA_JADX_MCP_JAR'] = config['jadx_jar']
    env['PATH'] = str(ROOT / 'local-only/runtime/node-v24.21.0-win-x64') + os.pathsep + env.get('PATH', '')
    commands = {'doctor': ['doctor', '--provider', 'jadx'], 'mcp-doctor': ['mcp', 'doctor'], 'analyze-js': ['analyze-javascript-application'], 'trace-feature': ['trace-application-feature'], 'trace-semantics': ['trace-javascript-semantics'], 'inspect-apk': ['inspect-android-package'], 'search-class': ['search-android-classes'], 'inspect-class': ['inspect-android-class'], 'inspect-method': ['inspect-android-method'], 'references': ['trace-android-references']}
    command = commands[args.action].copy()
    target = None
    if args.action not in {'doctor', 'mcp-doctor'}:
        if not args.target or not args.target.exists():
            parser.error('an existing authorized analysis target is required')
        target = args.target.resolve()
        if args.action not in {'analyze-js', 'trace-feature', 'trace-semantics'} and (not target.is_file() or target.suffix.lower() != '.apk'):
            parser.error('Android analysis requires a standalone APK')
        command.append(str(target))
    if args.action == 'search-class':
        command.append(args.query)
    if args.action in {'inspect-class', 'inspect-method', 'references'}:
        if not args.class_name:
            parser.error('class-name is required; discover it from this exact APK first')
        command.append(args.class_name)
    if args.action == 'inspect-method':
        if not args.method_name:
            parser.error('method-name is required')
        command.append(args.method_name)
    elif args.action == 'references' and args.method_name:
        command.extend(['--method-name', args.method_name])
    if args.overload_index is not None:
        if args.overload_index < 0 or args.action not in {'inspect-method', 'references'}:
            parser.error('overload-index requires inspect-method or references and must be nonnegative')
        command.extend(['--overload-index', str(args.overload_index)])
    command.extend(['--format', 'json'])
    OUTPUT.mkdir(parents=True, exist_ok=True)
    destination = OUTPUT / (args.label + '.json')
    error_path = OUTPUT / (args.label + '.stderr.txt')
    # Invoke an argument array, without a shell. APK code is never executed.
    with destination.open('wb') as stdout, error_path.open('wb') as stderr:
        result = subprocess.run([str(ROOT / 'local-only/runtime/node-v24.21.0-win-x64/node.exe'), str(ROOT / 'local-only/rea/node_modules/rea-agents/scripts/rea.mjs'), *command], cwd=ROOT, env=env, stdout=stdout, stderr=stderr, timeout=180, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    receipt = {'action': args.action, 'exit_code': result.returncode, 'output': str(destination.relative_to(ROOT)), 'output_sha256': hashlib.sha256(destination.read_bytes()).hexdigest(), 'account_used': False, 'target_executed': False, 'global_registration_changed': False}
    (OUTPUT / (args.label + '-receipt.json')).write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(receipt))
    raise SystemExit(result.returncode)


if __name__ == '__main__':
    main()
