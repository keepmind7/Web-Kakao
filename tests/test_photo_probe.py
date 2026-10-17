"""Probe guards execute offline, including under Python optimization."""
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parent.parent
PROBE = ROOT / 'experiments/photo_upload_probe.py'


class PhotoProbeGuardTests(unittest.TestCase):
    def run_probe(self, optimization, state, rooms=None, confirmed=True):
        namespace = {'__name__': 'offline_probe_fixture', '__file__': str(PROBE)}
        exec(compile(PROBE.read_text(encoding='utf-8'), str(PROBE), 'exec', optimize=optimization), namespace)
        calls = []
        effective_state = {'credentialInMemory': True, 'messaging': True, 'reader': {'phase': 'connected'}, 'csrf': 'synthetic-offline-csrf'}
        effective_state.update(state)
        effective_rooms = rooms if rooms is not None else [{'kind': 'MemoChat', 'canSend': True, 'key': 'synthetic-self'}]

        class Client:
            def open(self, target, **_kwargs):
                path = target if isinstance(target, str) else target.full_url
                calls.append(path)
                if path.endswith('/api/reader/rooms'):
                    import json
                    return io.BytesIO(json.dumps({'rooms': effective_rooms}).encode('utf-8'))
                raise RuntimeError('offline fixture stopped a photo submission')

        namespace['connect'] = lambda: ('http://127.0.0.1:1', Client(), effective_state)
        with tempfile.TemporaryDirectory() as folder:
            namespace['FOLDER'] = Path(folder)
            argv = ['photo_upload_probe', '--send-case', 'small']
            if confirmed:
                argv.append('--confirmed-self-test')
            with patch('sys.argv', argv):
                try:
                    namespace['main']()
                except BaseException as error:
                    return error, calls
        self.fail('guard allowed probe to return without rejecting the unsafe state')

    def test_invalid_authentication_never_reaches_room_or_photo_request(self):
        for optimization in (0, 1, 2):
            with self.subTest(optimization=optimization):
                error, calls = self.run_probe(optimization, {'credentialInMemory': False, 'messaging': True})
                self.assertIsInstance(error, SystemExit)
                self.assertEqual(calls, [])

    def test_busy_or_disconnected_reader_never_reaches_room_or_photo_request(self):
        for reader in ({'phase': 'disconnected'}, {'phase': 'connected', 'operationBusy': True}):
            for optimization in (0, 1, 2):
                with self.subTest(reader=reader, optimization=optimization):
                    error, calls = self.run_probe(optimization, {'credentialInMemory': True, 'messaging': True, 'reader': reader})
                    self.assertIsInstance(error, SystemExit)
                    self.assertEqual(calls, [])

    def test_ambiguous_self_chat_never_submits_photo(self):
        state = {'credentialInMemory': True, 'messaging': True, 'reader': {'phase': 'connected'}}
        rooms = [{'kind': 'MemoChat', 'canSend': True, 'key': key} for key in ('synthetic-one', 'synthetic-two')]
        for optimization in (0, 1, 2):
            with self.subTest(optimization=optimization):
                error, calls = self.run_probe(optimization, state, rooms)
                self.assertIsInstance(error, SystemExit)
                self.assertEqual(calls, ['http://127.0.0.1:1/api/reader/rooms'])

    def test_missing_explicit_confirmation_never_connects(self):
        for optimization in (0, 1, 2):
            with self.subTest(optimization=optimization):
                error, calls = self.run_probe(optimization, {}, confirmed=False)
                self.assertIsInstance(error, SystemExit)
                self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main()
