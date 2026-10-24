"""CLI entry contracts with all product writes/downloads/tool execution intercepted."""
import contextlib
import io
import os
from pathlib import Path
import platform
import subprocess
import sys
import types
import unittest
from unittest.mock import patch
from urllib.error import URLError
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
PREPARERS=['prepare_node_spike.py','prepare_android_adb.py','prepare_rea_android.py','prepare_rea_windows.py','prepare_spikes.py','fetch_source_spike.py']


class Pipe(io.StringIO):
    encoding='cp949'
    def __init__(self):
        super().__init__();self.configurations=[]
    def isatty(self):
        return False
    def reconfigure(self,**options):
        self.configurations.append(options)


def invoke(name,args=(),*,import_only=False,local_app_data=True,version=None,non_windows=False):
    path=ROOT/'tools'/name
    source=compile(path.read_text('utf-8'),str(path),'exec')
    stdout,stderr=Pipe(),io.StringIO();calls=[];caught=None
    def forbidden(kind):
        def called(*_args,**_kwargs):
            calls.append(kind);raise OSError('SYNTHETIC_PRIVATE_DETAIL')
        return called
    # Proxy only the CLI's os import; pathlib keeps its real host OS implementation.
    proxy=types.ModuleType('os');proxy.__dict__.update(os.__dict__);proxy.name='posix'
    with contextlib.ExitStack() as stack:
        stack.enter_context(patch.object(sys,'argv',[str(path),*args]))
        stack.enter_context(patch.dict(os.environ,{'LOCALAPPDATA':str(ROOT/'local-only/perf-portability-20261018/qa/contracts/unused-local-data')}))
        if not local_app_data:
            os.environ.pop('LOCALAPPDATA',None)
        if version is not None:
            stack.enter_context(patch.object(sys,'version_info',version))
        if non_windows:
            stack.enter_context(patch.dict(sys.modules,{'os':proxy}))
            target=non_windows if isinstance(non_windows,str) else 'linux'
            stack.enter_context(patch.object(sys,'platform',target))
            stack.enter_context(patch.object(platform,'system',return_value='Darwin' if target=='darwin' else 'Linux'))
        stack.enter_context(contextlib.redirect_stdout(stdout));stack.enter_context(contextlib.redirect_stderr(stderr))
        for attribute in ['mkdir','write_text','write_bytes','read_text','open']:
            stack.enter_context(patch.object(Path,attribute,side_effect=forbidden(attribute)))
        stack.enter_context(patch.object(urllib.request,'urlopen',side_effect=forbidden('network')))
        stack.enter_context(patch.object(subprocess,'run',side_effect=forbidden('process')))
        stack.enter_context(patch.object(subprocess,'Popen',side_effect=forbidden('process')))
        try:
            exec(source,{'__name__':'synthetic_cli_import' if import_only else '__main__','__file__':str(path)})
        except BaseException as error:
            caught=error
    return {'exception':caught,'code':caught.code if isinstance(caught,SystemExit) else None,'stdout':stdout.getvalue(),'stderr':stderr.getvalue(),'reconfigure':stdout.configurations,'calls':calls}


class CliPortabilityContracts(unittest.TestCase):
    def test_preparation_help_is_parse_only(self):
        for name in PREPARERS:
            with self.subTest(tool=name):
                result=invoke(name,['--help'])
                self.assertEqual(result['calls'],[],'--help must not read product state, write, download or run tools')
                self.assertEqual(result['code'],0)
                self.assertIn('usage:',result['stdout'].lower())

    def test_preparation_invalid_arguments_stop_before_IO(self):
        for name in PREPARERS:
            with self.subTest(tool=name):
                result=invoke(name,['--synthetic-invalid-option'])
                self.assertEqual(result['calls'],[],'invalid args must stop before preparation')
                self.assertIsInstance(result['exception'],SystemExit)
                self.assertNotEqual(result['code'],0)

    def test_preparation_imports_do_not_parse_or_prepare(self):
        for name in PREPARERS:
            with self.subTest(tool=name):
                result=invoke(name,import_only=True)
                self.assertEqual(result['calls'],[])
                self.assertIsNone(result['exception'],'import must not parse CLI arguments or execute preparation')

    def test_launcher_help_without_LOCALAPPDATA(self):
        result=invoke('local_web.py',['--help'],local_app_data=False)
        self.assertEqual(result['code'],0,'help must not resolve the private data location')
        self.assertIn('usage:',result['stdout'].lower())
        self.assertEqual(result['calls'],[])

    def test_launcher_import_without_LOCALAPPDATA(self):
        result=invoke('local_web.py',local_app_data=False,import_only=True)
        self.assertIsNone(result['exception'],'import must not require Windows private data environment')
        self.assertEqual(result['calls'],[])

    def test_launcher_rejects_python310_with_311_guidance(self):
        result=invoke('local_web.py',['--help'],version=(3,10,0))
        self.assertIsInstance(result['exception'],SystemExit)
        self.assertNotEqual(result['code'],0)
        text=result['stdout']+result['stderr']+str(result['exception'])
        self.assertIn('3.11',text)
        self.assertNotIn('3.10 이상',text)
        self.assertEqual(result['calls'],[])

    def test_launcher_help_on_non_windows_is_parse_only(self):
        result=invoke('local_web.py',['--help'],local_app_data=False,non_windows=True)
        self.assertEqual(result['code'],0)
        self.assertEqual(result['calls'],[])

    def test_launcher_unsupported_mac_cpu_stops_before_runtime_read(self):
        with patch.object(platform,'machine',return_value='ppc'):
            result=invoke('local_web.py',['status'],non_windows='darwin')
        self.assertEqual(result['calls'],[],'unsupported platform must stop before reading runtime information')
        text=result['stdout']+result['stderr']+str(result['exception'])
        self.assertIn('Windows',text)
        self.assertNotIn('Traceback',text)

    def test_redirected_stdout_encoding_is_not_reconfigured(self):
        result=invoke('local_web.py',['--help'])
        self.assertEqual(result['code'],0)
        self.assertEqual(result['reconfigure'],[],'piped stdout encoding belongs to the caller')

    def test_source_download_network_failure_is_a_concise_CLI_error(self):
        # Only an in-memory raised error; no actual network or output directory.
        result=invoke('fetch_source_spike.py',['modern'])
        self.assertEqual(result['calls'],['network'])
        self.assertIsInstance(result['exception'],SystemExit,'expected network failures need a CLI exit rather than an unhandled exception')
        self.assertNotEqual(result['code'],0)
        self.assertNotIn('SYNTHETIC_PRIVATE_DETAIL',result['stdout']+result['stderr']+str(result['exception']))


if __name__=='__main__':
    unittest.main()
