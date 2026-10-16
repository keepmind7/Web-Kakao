"""합성 PNG 준비. 실제 발송은 나와의 채팅·명시적으로 승인된 case에 한정한다."""
import argparse
import hashlib
import json
from pathlib import Path
import random
import struct
import sys
import time
import uuid
from urllib import request
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from tools.local_web import connect

ROOT = Path(__file__).resolve().parent.parent
FOLDER = ROOT / 'local-only/upload-probe'


def make_png(width, height):
    pixels = random.Random(42).randbytes(width*height*3)
    rows = b''.join(b'\0'+pixels[y*width*3:(y+1)*width*3] for y in range(height))

    def chunk(kind, data):
        return struct.pack('>I', len(data))+kind+data+struct.pack('>I', zlib.crc32(kind+data))

    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))+chunk(b'IDAT', zlib.compress(rows))+chunk(b'IEND', b'')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--send-case', choices=['small', 'large', 'large-corrected', 'small-unique', 'large-unique', 'large-bounded'])
    parser.add_argument('--confirmed-self-test', action='store_true')
    args = parser.parse_args()
    FOLDER.mkdir(parents=True, exist_ok=True)
    cases = {}
    for name, size in [('small', 1), ('large', 512)]:
        data = make_png(size, size)
        assert len(data) < 1024*1024
        file = FOLDER / (name+'.png')
        if file.exists():
            assert file.read_bytes() == data
        else:
            file.write_bytes(data)
        cases[name] = {'width': size, 'height': size, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
    if not args.send_case:
        print(json.dumps({'prepared': cases, 'actual_send': False}))
        return
    if not args.confirmed_self_test:
        raise SystemExit('Explicit approval of self-chat recipient and synthetic image is required.')
    # Only the generated, fixed image above can be sent. Never a user file.
    url, client, state = connect()
    assert state.get('credentialInMemory') and state.get('messaging')
    assert state.get('reader', {}).get('phase') == 'connected' and not state['reader'].get('operationBusy')
    with client.open(url+'/api/reader/rooms', timeout=4) as response:
        rooms = json.load(response).get('rooms', [])
    memo = [row for row in rooms if row.get('kind') == 'MemoChat' and row.get('canSend')]
    assert len(memo) == 1
    room = memo[0]['key']
    client_id = str(uuid.uuid4())
    import base64
    fixture = 'small' if args.send_case.startswith('small') else 'large'
    body = {'room': room, 'clientId': client_id, 'image': base64.b64encode((FOLDER/(fixture+'.png')).read_bytes()).decode('ascii')}
    with (FOLDER/(args.send_case+'-attempted.json')).open('x', encoding='utf-8') as marker:
        json.dump({'case': args.send_case, 'requests': 1, 'recipient_kind': 'MemoChat'}, marker)
    req = request.Request(url+'/api/reader/photo', data=json.dumps(body).encode('utf-8'), method='POST', headers={'Origin': url, 'Content-Type': 'application/json', 'X-CSRF-Token': state['csrf']})
    with client.open(req, timeout=8) as response:
        assert response.status == 202
    result = {'case': args.send_case, 'recipient_kind': 'MemoChat', 'requests': 1, 'phase': 'unknown', 'status': None}
    for _ in range(80):
        with client.open(url+'/api/reader/messages?room='+room, timeout=4) as response:
            page = json.load(response)
        outcome = next((row for row in page.get('outbox', []) if row.get('clientId') == client_id), None)
        if outcome and outcome.get('phase') != 'sending':
            result.update({key: outcome.get(key) for key in ['phase', 'status']})
            break
        time.sleep(.5)
    # Persist only aggregate test results, never message DTOs, opaque room keys,
    # client UUID, cookies, token, upload URLs or a user-provided image.
    (FOLDER/(args.send_case+'-result.json')).write_text(json.dumps(result, indent=2)+'\n', encoding='utf-8')
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'probe_error': type(error).__name__, 'automatic_retry': False}))
        raise SystemExit(1)
