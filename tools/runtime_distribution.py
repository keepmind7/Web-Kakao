"""Side-effect-free, pinned distributions for supported local server platforms."""
from pathlib import Path
import platform

VERSION = '24.21.0'
BASE_URL = 'https://nodejs.org/dist/v' + VERSION + '/'
# Official https://nodejs.org/dist/v24.21.0/SHASUMS256.txt, read 2026-10-23.
_DISTRIBUTIONS = {
    'Windows': {
        'archive': 'node-v24.21.0-win-x64.zip',
        'sha256': '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541',
        'directory': 'node-v24.21.0-win-x64',
        'executable': 'node.exe',
        'npm_cli': 'node_modules/npm/bin/npm-cli.js',
    },
    'Linux': {
        'archive': 'node-v24.21.0-linux-x64.tar.xz',
        'sha256': 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6',
        'directory': 'node-v24.21.0-linux-x64',
        'executable': 'bin/node',
        'npm_cli': 'lib/node_modules/npm/bin/npm-cli.js',
    },
}
# Darwin uses .tar.gz: Python builds without lzma are common on macOS (pyenv).
_DARWIN = {
    'x86_64': ('node-v24.21.0-darwin-x64', '1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097'),
    'arm64': ('node-v24.21.0-darwin-arm64', 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057'),
}


def runtime_spec(system=None, machine=None):
    """Return a detached specification; unknown OS/CPU combinations fail closed.

    Linux means x86_64 glibc (including WSL2 Ubuntu). This does not promise
    compatibility with musl/Alpine or Linux ARM. Darwin is x86_64 or arm64;
    platform.machine() reports the running architecture (x86_64 under Rosetta).
    """
    system = platform.system() if system is None else system
    machine = platform.machine() if machine is None else machine
    if system == 'Darwin' and machine in _DARWIN:
        directory, digest = _DARWIN[machine]
        return {'version': VERSION, 'archive': directory + '.tar.gz', 'sha256': digest,
                'directory': directory, 'executable': 'bin/node',
                'npm_cli': 'lib/node_modules/npm/bin/npm-cli.js'}
    if system not in _DISTRIBUTIONS or not isinstance(machine, str) or machine.lower() not in {'amd64', 'x86_64'}:
        raise ValueError('unsupported_runtime_platform')
    return {'version': VERSION, **_DISTRIBUTIONS[system]}


def runtime_path(project_root, system=None, machine=None):
    spec = runtime_spec(system, machine)
    return Path(project_root) / 'local-only' / 'runtime' / spec['directory'] / spec['executable']
