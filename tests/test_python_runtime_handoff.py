"""Launcher forwards its validated Python; no actual server/tool is started."""
import contextlib
import io
from pathlib import Path
import sys,tempfile,unittest
from unittest.mock import Mock,patch
from tools import local_web

class PythonRuntimeHandoff(unittest.TestCase):
 def test_start_overwrites_inherited_python_hint_with_current_interpreter(self):
  process=Mock();process.poll.return_value=1
  with tempfile.TemporaryDirectory(prefix='p-') as temporary, \
       patch.object(local_web,'FOLDER',Path(temporary)),patch.object(local_web,'connect',return_value=None), \
       patch.object(local_web,'assert_port_available'),patch.object(local_web,'ensure_private_directory'), \
       patch.object(local_web,'verify_private_file'),patch.object(local_web,'broad_write_warnings',return_value=[]), \
       patch.object(local_web.subprocess,'Popen',return_value=process) as popen, \
       patch.dict(local_web.os.environ,{'WEB_KAKAO_PYTHON':'C:\\SyntheticUntrusted\\python.exe'}), \
       patch.object(sys,'argv',['local_web.py','start','--mock','--port','1']),contextlib.redirect_stdout(io.StringIO()):
   local_web.main()
   self.assertEqual(popen.call_count,1)
   self.assertEqual(popen.call_args.kwargs['env'].get('WEB_KAKAO_PYTHON'),sys.executable)

if __name__=='__main__':unittest.main()
