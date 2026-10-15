// 구 node-kakao의 코덱을 메모리 스트림에서만 검사한다.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Long } from 'bson';

const base = process.cwd();
const load = (path: string) => import(pathToFileURL(resolve(base, path)).href);
const { BsonDataCodec } = await load('src/packet/bson-data-codec.ts');
const { PacketAssembler } = await load('src/network/packet-assembler.ts');
const { LocoPacketCodec } = await load('src/network/loco-packet-codec.ts');
const checks: Array<{name: string; passed: boolean}> = [];
const check = (name: string, condition: boolean) => { checks.push({name,passed:condition}); assert(condition,name); };
const assembler = new PacketAssembler(BsonDataCodec);
const body = { value: 'synthetic-codec-data', logId: Long.fromString('9007199254740993') };
const packet = assembler.construct('PING', body);
const decoded = assembler.deconstruct(packet);
check('bson_preserves_64bit_identifier', decoded.logId.toString() === '9007199254740993' && decoded.value === body.value);

let memory = new Uint8Array();
let offset = 0;
const stream = {
  ended: false, close() { this.ended = true; },
  async write(data: Uint8Array) { memory = new Uint8Array(data); return data.length; },
  async read(destination: Uint8Array) {
    if (offset >= memory.length) return null;
    const size = Math.min(7, destination.length, memory.length-offset);
    destination.set(memory.subarray(offset, offset+size)); offset += size; return size;
  }
};
const codec = new LocoPacketCodec(stream);
await codec.write(packet);
const restored = await codec.read();
check('fragmented_memory_frame_roundtrip', restored?.header.method === 'PING' &&
  restored?.header.id === packet.header.id && assembler.deconstruct(restored).value === body.value);
let rejected = false;
try { assembler.deconstruct({...packet,data:[255,packet.data[1]]}); } catch { rejected = true; }
check('unsupported_data_type_rejected', rejected);
rejected = false;
try { await codec.write({...packet,header:{...packet.header,method:'한글'}}); } catch { rejected = true; }
check('non_ascii_method_rejected', rejected);
const guard = (globalThis as any).__spikeGuard;
check('external_network_not_attempted', guard.externalConnectionsBlocked === 0 && guard.externalRequestsBlocked === 0);
const result = {experiment:'legacy_memory_codec',candidate_commit:'8512e4699e2cd4c26516b80d38b57b2f85a6cc8a',
  observed_at_utc:new Date().toISOString(),checks,passed:checks.every(c=>c.passed),
  real_account_verified:false,actual_message_sent:false,network_protocol_connected:false};
writeFileSync(resolve(base,'../../../evidence/alternatives/legacy-codec-spike.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
