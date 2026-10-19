// Independent contract tests: injected peers only; no SDK, TLS, OS share or account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  makeSyntheticImage, inspectImage, createPhotoSimulator, simulateOfficial,
  simulateManualShare, simulateCrypto, simulateTransportPolicy,
} from '../experiments/photo-method-simulation/model.mjs';

const context={account:'qa-account',room:'qa-room',generation:1};
const image=()=>makeSyntheticImage({size:1024});
const request=(extra={})=>({method:'http-write',clientId:'qa-request',context:{...context},image:image(),...extra});
const asset=()=>({status:200,contentType:'text/plain',body:'fixture-asset:qa',redirected:false});
const hash=b=>createHash('sha256').update(b).digest('hex');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function unverified(result){assert.equal(result.delivery,'unverified');assert.notEqual(result.evidenceLevel,'actual-delivery');}

for(const method of ['http-write','loco'])for(const size of [1024,629748]){
  test(method+' independently verifies every payload byte and SHA256 at size '+size,async()=>{
    const original=makeSyntheticImage({size}),expected=Buffer.from(original.bytes);let observed=0;
    const peer=({payload,image:meta,multipart})=>{
      observed++;assert.notEqual(payload,original.bytes);assert.deepEqual(payload,expected);
      assert.equal(hash(payload),hash(expected));assert.equal(meta.sha256,hash(expected));assert.equal(meta.bytes,size);
      if(method==='http-write')assert.deepEqual(multipart,{user_id:'0',attachment_type:'image/jpeg',filename:'synthetic.jpg'});
      payload.fill(0);return method==='http-write'?asset():{status:0};
    };
    const result=await createPhotoSimulator({adapters:{[method==='http-write'?'upload':'file']:peer}}).send(request({method,image:original}));
    assert.equal(result.messagePhase,'accepted');assert.equal(observed,1);assert.deepEqual(original.bytes,expected);
    assert.equal(result.image.sha256,hash(expected));assert.equal(result.calls.write??0,method==='http-write'?1:0);unverified(result);
  });
}

test('input and context are copied before an asynchronous upload; mutated caller cannot redirect WRITE',async()=>{
  const gate=deferred(),begun=deferred(),r=request(),expected=Buffer.from(r.image.bytes),seen=[];
  const simulator=createPhotoSimulator({adapters:{upload:async p=>{seen.push(p);begun.resolve();await gate.promise;return asset();},write:p=>{seen.push(p);return {status:0};}}});
  const pending=simulator.send(r);r.image.bytes.fill(0);r.context.room='foreign-room';r.method='loco';
  await begun.promise;gate.resolve();const result=await pending;
  assert.equal(result.messagePhase,'accepted');assert.deepEqual(seen[0].payload,expected);
  assert.deepEqual(seen.map(x=>x.context),[context,context]);assert.equal(seen[1].image.sha256,hash(expected));unverified(result);
});

for(const [name,change] of [
  ['PNG declared JPEG',()=>({...makeSyntheticImage({format:'png'}),mime:'image/jpeg',name:'qa.jpg'})],
  ['extension mismatch',()=>({...image(),name:'qa.png'})],
  ['non-image bytes',()=>({bytes:Buffer.from('not-an-image'),mime:'image/jpeg',name:'qa.jpg'})],
  ['empty image',()=>({bytes:Buffer.alloc(0),mime:'image/jpeg',name:'qa.jpg'})],
  ['oversized image',()=>({bytes:Buffer.alloc(5*1024*1024+1),mime:'image/jpeg',name:'qa.jpg'})],
])test(name+' is refused before either transport',async()=>{
  let calls=0;const result=await createPhotoSimulator({adapters:{upload:()=>{calls++;return asset();},write:()=>{calls++;return {status:0};}}}).send(request({image:change()}));
  assert.equal(result.messagePhase,'refused');assert.equal(calls,0);assert.deepEqual(result.calls,{});unverified(result);
});

for(const [name,response] of [
  ['HTTP403',{...asset(),status:403}],['HTML',{...asset(),contentType:'text/html',body:'<html>qa</html>'}],
  ['empty',{...asset(),body:''}],['oversize',{...asset(),body:'x'.repeat(257)}],
  ['redirect',{...asset(),redirected:true}],['outside synthetic grammar',{...asset(),body:'https://invalid.example/private'}],
])test(name+' upload response never invokes WRITE or exposes response',async()=>{
  let writes=0;const result=await createPhotoSimulator({adapters:{upload:()=>response,write:()=>{writes++;return {status:0};}}}).send(request());
  assert.equal(result.uploadPhase,'failed');assert.equal(result.messagePhase,'not_started');assert.equal(writes,0);
  assert.equal(JSON.stringify(result).includes(response.body),response.body===''?true:false);unverified(result);
});

test('concurrent identical requests share one operation and returned results cannot mutate dedupe state',async()=>{
  const begun=deferred(),gate=deferred();let uploads=0,writes=0;
  const simulator=createPhotoSimulator({adapters:{upload:async()=>{uploads++;begun.resolve();await gate.promise;return asset();},write:()=>{writes++;return {status:0};}}});
  const r=request(),a=simulator.send(r),b=simulator.send(r);await begun.promise;assert.equal(uploads,1);gate.resolve();
  const [first,second]=await Promise.all([a,b]);assert.deepEqual(first,second);assert.equal(writes,1);
  first.calls.write=999;first.image.sha256='mutated-result';assert.deepEqual(await simulator.send(r),second);unverified(second);
});

test('reused clientId cannot change account, room, generation, method or content',async()=>{
  const simulator=createPhotoSimulator(),r=request();await simulator.send(r);
  for(const changed of [
    {context:{...context,account:'other-account'}},{context:{...context,room:'other-room'}},
    {context:{...context,generation:2}},{method:'loco'},{image:makeSyntheticImage({size:1025})},
  ]){
    const result=await simulator.send({...r,...changed});assert.equal(result.reason,'client_id_reuse_refused');assert.deepEqual(result.calls,{});unverified(result);
  }
});

for(const changedField of ['account','room','generation']){
  for(const stage of ['upload','write'])test(changedField+' changes during held '+stage+' cannot accept in a new context',async()=>{
    let active={...context};const begun=deferred(),gate=deferred();let writes=0;
    const simulator=createPhotoSimulator({isCurrent:c=>JSON.stringify(c)===JSON.stringify(active),adapters:{
      upload:async()=>{if(stage==='upload'){begun.resolve();await gate.promise;}return asset();},
      write:async()=>{writes++;if(stage==='write'){begun.resolve();await gate.promise;}return {status:0};},
    }});
    const pending=simulator.send(request());await begun.promise;
    active={...active,[changedField]:changedField==='generation'?2:'new-'+changedField};gate.resolve();
    const result=await pending;assert.equal(result.uploadPhase,'asset_uploaded');
    assert.equal(result.messagePhase,stage==='upload'?'refused':'unknown');assert.equal(writes,stage==='upload'?0:1);unverified(result);
  });
}

test('pending and unknown WRITE lock new IDs and method/generation switches without extra transports',async()=>{
  const begun=deferred(),gate=deferred();let uploads=0,writes=0;
  const simulator=createPhotoSimulator({adapters:{upload:()=>{uploads++;return asset();},write:async()=>{writes++;begun.resolve();await gate.promise;return undefined;}}});
  const r=request(),pending=simulator.send(r);await begun.promise;
  const variations=[{clientId:'other-http'},{clientId:'other-loco',method:'loco'},{clientId:'other-generation',context:{...context,generation:2}}];
  for(const variant of variations){const result=await simulator.send({...r,...variant});assert.equal(result.reason,'unknown_content_retry_refused');assert.deepEqual(result.calls,{});}
  gate.resolve();const unknown=await pending;assert.equal(unknown.messagePhase,'unknown');assert.equal(unknown.uploadPhase,'asset_uploaded');
  for(const variant of variations){const result=await simulator.send({...r,...variant});assert.equal(result.messagePhase,'refused');assert.deepEqual(result.calls,{});}
  assert.equal(uploads,1);assert.equal(writes,1);unverified(unknown);
});

test('bounded adapter timeout ignores late ACK and keeps the uncertain request locked',async()=>{
  const gate=deferred();let writes=0;
  const simulator=createPhotoSimulator({timeoutMs:10,adapters:{write:()=>{writes++;return gate.promise;}}}),r=request();
  const result=await simulator.send(r);assert.equal(result.uploadPhase,'asset_uploaded');assert.equal(result.messagePhase,'unknown');
  gate.resolve({status:0});await flush();assert.deepEqual(await simulator.send(r),result);
  const retry=await simulator.send({...r,clientId:'timeout-switch',method:'loco'});assert.equal(retry.messagePhase,'refused');assert.equal(writes,1);unverified(result);
});

test('WRITE rejection preserves asset state while missing/reset remain unknown; no automatic fallback',async()=>{
  for(const [write,phase] of [[()=>({status:-203}),'failed'],[()=>undefined,'unknown'],[()=>{throw new Error('PRIVATE_QA_RAW_SENTINEL');},'unknown']]){
    const result=await createPhotoSimulator({adapters:{write}}).send(request());
    assert.equal(result.uploadPhase,'asset_uploaded');assert.equal(result.messagePhase,phase);assert.deepEqual(result.calls,{upload:1,write:1});
    assert.equal(JSON.stringify(result).includes('PRIVATE_QA_RAW_SENTINEL'),false);unverified(result);
  }
});

test('official HTTP200 per-recipient failure is partial and foreign or duplicate success IDs do not accept',()=>{
  const base={target:'friends',configured:true,consent:true,friendUuids:['qa-1','qa-2']};
  const partial=simulateOfficial({...base,response:{httpStatus:200,successful_receiver_uuids:['qa-1'],failure_info:[{}]}});
  assert.equal(partial.messagePhase,'partial_failure');assert.equal(partial.successfulRecipients,1);assert.equal(partial.failedRecipients,1);unverified(partial);
  for(const ids of [['qa-1','foreign'],['qa-1','qa-1'],[]]){const r=simulateOfficial({...base,response:{httpStatus:200,successful_receiver_uuids:ids}});assert.equal(r.messagePhase,'unknown');unverified(r);}
});

test('official capability gates never treat arbitrary rooms or user selection as native photo delivery',()=>{
  for(const [r,phase] of [
    [simulateOfficial({target:'arbitrary-room',configured:true,consent:true}),'unsupported'],
    [simulateOfficial({target:'self',configured:true}),'blocked'],
    [simulateOfficial({target:'friends',configured:true,consent:true,friendUuids:Array(6).fill('qa')}),'refused'],
    [simulateOfficial({target:'share',configured:true}),'requires_user_selection'],
  ]){assert.equal(r.messagePhase,phase);assert.equal(r.messageForm,'image_template_card');unverified(r);}
});

test('Web Share capability, gesture and cancel are separate from successful handoff and recipient arrival',()=>{
  const base={supported:true,canShare:true,userActivation:true};
  for(const [r,phase] of [[{},'unsupported'],[{...base,canShare:false},'unsupported'],[{...base,userActivation:false},'blocked'],[{...base,outcome:'cancel'},'cancelled'],[{...base,outcome:'resolve'},'handed_off'],[{...base,outcome:'error'},'failed']]){
    const result=simulateManualShare(r);assert.equal(result.messagePhase,phase);assert.equal(result.targetApp,'unknown');assert.equal(result.targetRoom,'user_selected_unknown');unverified(result);
  }
});

test('offline crypto covers its fixed plaintext only, detects GCM tamper and never asserts CFB compatibility',()=>{
  for(const profile of ['cfb','gcm']){
    const result=simulateCrypto({profile});assert.equal(result.cryptoPhase,'roundtrip');assert.equal(result.plaintextBytes,Buffer.byteLength('synthetic-file-boundary'));
    assert.equal(result.compatibility,'unverified');assert.equal(result.evidenceLevel,'offline-synthetic-crypto');assert.equal(result.authenticated,profile==='gcm');unverified(result);
    assert.equal(simulateCrypto({profile,decryptProfile:profile==='cfb'?'gcm':'cfb'}).cryptoPhase,'refused');
  }
  assert.equal(simulateCrypto({profile:'gcm',tamper:true}).cryptoPhase,'rejected');
  assert.equal(simulateCrypto({profile:'cfb',tamper:true}).cryptoPhase,'modified_plaintext');
});

test('selective block is a hypothesis; HTTP asset alone cannot register when all LOCO is blocked',async()=>{
  for(const allLocoBlocked of [false,true]){
    const policy={fileTransportBlocked:true,allLocoBlocked};const hypothesis=simulateTransportPolicy(policy);
    assert.equal(hypothesis.evidenceLevel,'hypothesis-model');assert.equal(hypothesis.bypassClaim,false);assert.equal(hypothesis.httpAloneCanDeliver,false);
    const result=await createPhotoSimulator({policy}).send(request());
    assert.equal(result.uploadPhase,'asset_uploaded');assert.equal(result.messagePhase,allLocoBlocked?'failed':'accepted');assert.equal(result.calls.write??0,allLocoBlocked?0:1);unverified(result);
  }
});

test('image inspection is explicitly a signature check and synthetic JPEG exact-size boundaries are enforced',()=>{
  for(const size of [1024,65535,65536,65537,629748]){const f=makeSyntheticImage({size});assert.equal(f.bytes.length,size);assert.equal(inspectImage(f).sha256,hash(f.bytes));}
  // A signature-only inspector accepts this deliberately incomplete body. This
  // assertion documents the scope limit; it is not evidence of valid decoding.
  assert.equal(inspectImage({bytes:Buffer.from([255,216,0,0,255,217]),mime:'image/jpeg',name:'qa.jpg'}).valid,true);
  for(const size of [-1,1,5*1024*1024+1])assert.throws(()=>makeSyntheticImage({size}),RangeError);
});

// Added after the independent review: these are minimal legacy-derived semantic
// fields, not current PHOTO extra/BSON/server acceptance or production WRITE tests.
function assertBoundRegistration(payload,{clientId,path,bytes,room=context.room}){
  assert.equal(payload.clientId,clientId,'WRITE must retain its local client request identity');
  assert.deepEqual(payload.asset,{path,s:bytes.length,sha256:hash(bytes)},'asset size/hash must come from this request, not response metadata');
  assert.equal(payload.registration?.chatId,room);assert.equal(payload.registration?.type,2);assert.equal(payload.registration?.noSeen,true);
  assert.ok(Number.isSafeInteger(payload.registration?.msgId) && payload.registration.msgId>0,'modeled message sequence must be a positive safe integer');
  assert.deepEqual(JSON.parse(payload.registration.extra),{path,s:bytes.length},'wire proposal contains path+s only, not invented hash fields');
}

test('binding: uploaded path and copied request bytes are snapshotted into the exact WRITE registration',async()=>{
  const begun=deferred(),gate=deferred(),r=request({clientId:'binding-original'}),bytes=Buffer.from(r.image.bytes);
  const response={...asset(),body:'fixture-asset:binding_original',s:1,sha256:'untrusted-response-hash'};let peer;
  const simulator=createPhotoSimulator({adapters:{upload:()=>response,write:async p=>{peer=structuredClone(p);begun.resolve();await gate.promise;return {status:0};}}});
  const pending=simulator.send(r);await begun.promise;
  response.body='fixture-asset:mutated_after_write';response.s=999;r.image.bytes.fill(0);r.context.room='caller-mutated-room';gate.resolve();
  const result=await pending;
  assert.equal(result.messagePhase,'accepted');assertBoundRegistration(peer,{clientId:'binding-original',path:'fixture-asset:binding_original',bytes});
  const json=JSON.stringify(result);for(const secret of ['fixture-asset:binding_original','binding-original','registration','untrusted-response-hash'])assert.equal(json.includes(secret),false);
  unverified(result);
});

test('binding: concurrent reverse-order assets and late ACKs remain attached to their own bytes and sequence',async()=>{
  const a=makeSyntheticImage({size:1024}),b=makeSyntheticImage({size:2048});
  const expected=new Map([[hash(a.bytes),{path:'fixture-asset:asset_a',clientId:'binding-a',bytes:Buffer.from(a.bytes)}],[hash(b.bytes),{path:'fixture-asset:asset_b',clientId:'binding-b',bytes:Buffer.from(b.bytes)}]]);
  const uploadGates=new Map([...expected].map(([key])=>[key,deferred()])),both=deferred(),writeA=deferred(),peer=[];let uploads=0;
  const simulator=createPhotoSimulator({adapters:{upload:async p=>{uploads++;if(uploads===2)both.resolve();await uploadGates.get(p.image.sha256).promise;return {...asset(),body:expected.get(p.image.sha256).path};},write:async p=>{peer.push(structuredClone(p));if(p.image.sha256===hash(a.bytes))await writeA.promise;return {status:0};}}});
  const pa=simulator.send(request({clientId:'binding-a',image:a})),pb=simulator.send(request({clientId:'binding-b',image:b}));
  await both.promise;uploadGates.get(hash(b.bytes)).resolve();const rb=await pb;
  uploadGates.get(hash(a.bytes)).resolve();await flush();writeA.resolve();const ra=await pa;
  assert.equal(ra.messagePhase,'accepted');assert.equal(rb.messagePhase,'accepted');assert.equal(peer.length,2);
  for(const p of peer)assertBoundRegistration(p,expected.get(p.image.sha256));
  assert.notEqual(peer[0].registration.msgId,peer[1].registration.msgId,'separate registrations need distinct local sequence IDs');unverified(ra);unverified(rb);
});

test('binding: explicitly mismatched ACK identity or asset metadata cannot promote any registration to accepted',async()=>{
  const mismatches=[{clientId:'foreign-client'},{chatId:'foreign-room'},{msgId:-1},{asset:{path:'fixture-asset:foreign'}},{asset:{s:1}},{asset:{sha256:'0'.repeat(64)}}];
  const outcomes=[];
  for(const mismatch of mismatches){
    const result=await createPhotoSimulator({adapters:{write:()=>({status:0,...mismatch})}}).send(request());
    outcomes.push(result.messagePhase);assert.equal(result.uploadPhase,'asset_uploaded');assert.deepEqual(result.calls,{upload:1,write:1});unverified(result);
  }
  assert.deepEqual(outcomes,Array(6).fill('unknown'),'provided correlation fields must be compared, even though bare status0 remains supported');
});

test('binding: adapter mutation cannot replace the canonical asset used for ACK matching or deduped requests',async()=>{
  const r=request({clientId:'binding-canonical'}),bytes=Buffer.from(r.image.bytes);let writes=0,seen;
  const simulator=createPhotoSimulator({adapters:{upload:()=>({...asset(),body:'fixture-asset:canonical'}),write:p=>{
    writes++;seen=structuredClone(p);
    if(p.asset)p.asset.path='fixture-asset:adapter_mutation';if(p.registration){p.registration.chatId='adapter-mutated-room';p.registration.extra='{}';}
    p.context.room='adapter-mutated-context';p.image.sha256='adapter-mutated-hash';
    return {status:0,...(seen.clientId?{clientId:seen.clientId,chatId:seen.registration.chatId,msgId:seen.registration.msgId,asset:seen.asset}:{})};
  }}});
  const first=await simulator.send(r),duplicate=await simulator.send(r);
  assert.equal(first.messagePhase,'accepted');assert.deepEqual(first,duplicate);assert.equal(writes,1);
  assertBoundRegistration(seen,{clientId:'binding-canonical',path:'fixture-asset:canonical',bytes});unverified(first);
});

test('binding control: upload response after its deadline causes no late WRITE or new same-request upload',async()=>{
  const gate=deferred();let uploads=0,writes=0;
  const simulator=createPhotoSimulator({timeoutMs:10,adapters:{upload:()=>{uploads++;return gate.promise;},write:()=>{writes++;return {status:0};}}}),r=request();
  const result=await simulator.send(r);assert.equal(result.messagePhase,'not_started');
  gate.resolve({...asset(),body:'fixture-asset:too_late'});await flush();
  assert.deepEqual(await simulator.send(r),result);assert.equal(uploads,1);assert.equal(writes,0);unverified(result);
  // A dishonest server's syntactically valid path swap cannot itself be
  // authenticated by this model. The tests bind the received path to request
  // bytes; they do not claim server-side path-to-content proof.
});
