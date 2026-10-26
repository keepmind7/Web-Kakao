// Execute actual app functions against synthetic UI/transport state. No account/network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../experiments/local-web/app.js',import.meta.url),'utf8');
const block=(from,to)=>source.slice(source.indexOf(from),source.indexOf(to,source.indexOf(from)));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const settle=async()=>{for(let n=0;n<15;n++)await Promise.resolve();};
function settingsFixture(){
  const nodes=new Map(),calls=[],gates=[],server={readSync:false,notifications:false,persist:false,roomFilter:'all'};
  const context=vm.createContext({hasAccount:true,readerGeneration:1,settingsBusy:false,settingsEpoch:0,settingsRevision:0,readerRevision:0,readSyncIntent:null,
    lastState:{preferences:true,messaging:true,reader:{settingsRevision:1}},personalSettings:{...server},roomFilter:'all',shownNotifications:new Map(),window:{},
    el:id=>{if(!nodes.has(id))nodes.set(id,{checked:false,textContent:'',disabled:false});return nodes.get(id);},
    preferenceReady:()=>context.hasAccount,requestStamp:()=>({}),stampCurrent:()=>true,revisionFor:(r,f)=>r[f],renderComposer(){},
    localJson:async()=>({settings:{...server}}),postLocal:async(path,body)=>{calls.push({path,body});const gate=deferred();gates.push(gate);const ok=await gate.promise;if(ok)Object.assign(server,body);return ok;}});
  vm.runInContext(block('async function refreshSettings(state){','async function receiveNotifications(){'),context);
  context.refresh=async()=>context.refreshSettings(context.lastState);
  return {context,calls,gates,nodes,server,run:code=>vm.runInContext(code,context)};
}
test('last read OFF is queued behind a held ON and never restored by a refresh',async()=>{
  const f=settingsFixture();f.run("el('read-sync').checked=true");const first=f.run('saveSettings({readSync:true})');
  f.run("el('read-sync').checked=false");await f.run('saveSettings({readSync:false})');
  assert.equal(f.calls.length,1);f.gates[0].resolve(true);await settle();
  assert.equal(f.calls.length,2,'latest OFF must be sent after ON, with no dropped intent');
  assert.equal(f.calls[1].body.readSync,false);assert.equal(f.nodes.get('read-sync').checked,false);
  f.gates[1].resolve(true);await first;
  assert.equal(f.server.readSync,false);assert.equal(f.nodes.get('read-sync').checked,false);assert.equal(f.context.readSyncIntent,null);
});
test('multiple changes coalesce to the latest read intent behind another setting save',async()=>{
  const f=settingsFixture(),first=f.run('saveSettings({persist:true})');
  await f.run('saveSettings({readSync:true})');await f.run('saveSettings({readSync:false})');await f.run('saveSettings({readSync:true})');
  f.gates[0].resolve(true);await settle();assert.equal(f.calls.length,2);assert.equal(f.calls[1].body.readSync,true);
  f.gates[1].resolve(true);await first;assert.equal(f.server.readSync,true);assert.equal(f.context.settingsBusy,false);
});
test('failed last OFF stays OFF locally and is not automatically retried',async()=>{
  const f=settingsFixture();f.server.readSync=true;f.context.personalSettings.readSync=true;
  f.run("el('read-sync').checked=false");const saving=f.run('saveSettings({readSync:false})');
  f.gates[0].resolve(false);await saving;await f.context.refresh();
  assert.equal(f.nodes.get('read-sync').checked,false);assert.equal(f.calls.length,1);assert.equal(f.context.readSyncIntent?.value,false);
  assert.match(f.nodes.get('preferences-status').textContent,/읽음.*확인하지 못/,'a held local OFF must not look durably saved');
});
test('an unrelated settings save never retries an already attempted read intent',async()=>{
  const f=settingsFixture();f.server.readSync=true;
  const off=f.run('saveSettings({readSync:false})');f.gates[0].resolve(false);await off;
  const other=f.run('saveSettings({persist:true})');f.gates[1].resolve(true);await settle();
  const observed=f.calls.length;
  // Settle an erroneous retry so a RED result cannot leak a pending fixture.
  for(const gate of f.gates.slice(2))gate.resolve(false);await other;
  assert.equal(observed,2,'a failed OFF is not a new explicit choice');assert.equal(f.nodes.get('read-sync').checked,false);
  assert.match(f.nodes.get('preferences-status').textContent,/읽음.*확인하지 못/);
  const explicit=f.run('saveSettings({readSync:false})');f.gates.at(-1).resolve(true);await explicit;
  assert.equal(f.context.readSyncIntent,null);assert.equal(f.server.readSync,false);
});
test('queued read change cannot cross account replacement',async()=>{
  const f=settingsFixture(),first=f.run('saveSettings({persist:true})');await f.run('saveSettings({readSync:false})');
  f.run('settingsEpoch++;readSyncIntent=null;personalSettings={readSync:true};settingsBusy=false;');f.gates[0].resolve(true);await first;
  assert.equal(f.calls.length,1);assert.equal(f.context.personalSettings.readSync,true);
});
for(const outcome of ['success','denied','error'])test('late name '+outcome+' cannot close or write into a newer editor',async()=>{
  const gate=deferred(),error={textContent:''},dialog={open:true,closes:0,close(){this.open=false;this.closes++;}};
  const old={key:'A',generation:1},next={key:'B',generation:1};
  const context=vm.createContext({renameTarget:old,readerGeneration:1,hasAccount:true,readerRevision:0,lastState:null,roomPreferenceSequence:0,viewClientId:'11111111-1111-4111-8111-111111111111',
    el:id=>id==='rename-dialog'?dialog:error,postLocal:()=>gate.promise,refresh:async()=>{}});
  vm.runInContext(block('async function saveRoomTitle(value){',"el('rename-form').addEventListener"),context);
  const saving=context.saveRoomTitle('Synthetic A');context.renameTarget=next;error.textContent='B EDITOR';
  outcome==='error'?gate.reject(Error('synthetic')):gate.resolve(outcome==='success');await saving;
  assert.equal(dialog.open,true);assert.equal(dialog.closes,0);assert.equal(error.textContent,'B EDITOR');
});
test('closing a name editor invalidates a held save even without a replacement editor',async()=>{
  const gate=deferred(),dialog={open:false,close(){throw Error('old completion must not close again');}},error={textContent:''};
  const context=vm.createContext({renameTarget:{key:'A',generation:1},readerGeneration:1,hasAccount:true,readerRevision:0,lastState:null,roomPreferenceSequence:0,viewClientId:'11111111-1111-4111-8111-111111111111',
    el:id=>id==='rename-dialog'?dialog:error,postLocal:()=>gate.promise,refresh:async()=>{}});
  vm.runInContext(block('async function saveRoomTitle(value){',"el('rename-form').addEventListener"),context);
  // Native close/cancel clears the owner; a completion must still check it.
  dialog.open=true;const saving=context.saveRoomTitle('Synthetic');dialog.open=false;context.renameTarget=null;
  gate.resolve(true);await saving;assert.equal(context.renameTarget,null);
});
test('same name editor admits only one write while its response is pending',async()=>{
  const gate=deferred(),dialog={open:true,close(){this.open=false;}},node={textContent:''};let calls=0;
  const context=vm.createContext({renameTarget:{key:'A',generation:1},readerGeneration:1,hasAccount:true,readerRevision:0,lastState:null,roomPreferenceSequence:0,viewClientId:'11111111-1111-4111-8111-111111111111',
    el:id=>id==='rename-dialog'?dialog:node,postLocal:()=>{calls++;return gate.promise;},refresh:async()=>{}});
  vm.runInContext(block('async function saveRoomTitle(value){',"el('rename-form').addEventListener"),context);
  const first=context.saveRoomTitle('Synthetic');const second=context.saveRoomTitle('Synthetic twice');
  gate.resolve(true);await Promise.all([first,second]);assert.equal(calls,1);
});
function renameFixture(lastState={roomPreferenceOrdering:true}){
  const dialog={open:true,closes:0,close(){this.open=false;this.closes++;}},error={textContent:''},calls=[],gates=[];
  const context=vm.createContext({renameTarget:{key:'A',generation:1},readerGeneration:1,hasAccount:true,readerRevision:0,
    lastState,roomPreferenceSequence:0,viewSequence:83,viewClientId:'11111111-1111-4111-8111-111111111111',
    el:id=>id==='rename-dialog'?dialog:error,postLocal:(path,body)=>{calls.push({path,body:JSON.parse(JSON.stringify(body))});const gate=deferred();gates.push(gate);return gate.promise;},refresh:async()=>{}});
  vm.runInContext(block('async function saveRoomTitle(value){',"el('rename-form').addEventListener"),context);
  return {context,dialog,error,calls,gates,open:(key='A')=>{context.renameTarget={key,generation:context.readerGeneration};dialog.open=true;}};
}
test('same-room cancelled edit and its replacement carry distinct increasing alias intents',async()=>{
  const f=renameFixture(),first=f.context.saveRoomTitle(' First ');
  f.context.renameTarget=null;f.dialog.open=false;f.open();const latest=f.context.saveRoomTitle(' Latest ');
  assert.deepEqual(f.calls.map(v=>v.body),[
    {room:'A',title:'First',preferenceClientId:f.context.viewClientId,preferenceSequence:1},
    {room:'A',title:'Latest',preferenceClientId:f.context.viewClientId,preferenceSequence:2},
  ]);
  f.gates[1].resolve(true);await latest;f.gates[0].resolve(true);await first;
  assert.equal(f.dialog.closes,1);assert.equal(f.context.viewSequence,83,'alias order must not consume the view-selection counter');
});
for(const outcome of ['denied','error'])test('an explicit alias retry after '+outcome+' receives a fresh intent without automatic retry',async()=>{
  const f=renameFixture(),first=f.context.saveRoomTitle('First');
  outcome==='denied'?f.gates[0].resolve(false):f.gates[0].reject(Error('synthetic'));await first;await settle();
  assert.equal(f.calls.length,1);assert.equal(f.dialog.open,true);assert.equal(f.context.renameTarget.saving,false);
  const retry=f.context.saveRoomTitle('Retry');f.gates[1].resolve(true);await retry;
  assert.deepEqual(f.calls.map(v=>v.body.preferenceSequence),[1,2]);
});
test('resetting an alias participates in the same per-page sequence across rooms',async()=>{
  const f=renameFixture(),first=f.context.saveRoomTitle('Alias');f.gates[0].resolve(true);await first;
  f.open('B');const reset=f.context.saveRoomTitle(null);f.gates[1].resolve(true);await reset;
  assert.deepEqual(f.calls[1].body,{room:'B',title:null,preferenceClientId:f.context.viewClientId,preferenceSequence:2});
});
for(const status of [null,{}, {roomPreferenceOrdering:false},{roomPreferenceOrdering:'true'}])test('unadvertised alias ordering keeps the legacy room/title body: '+JSON.stringify(status),async()=>{
  const f=renameFixture(status),saving=f.context.saveRoomTitle(' Legacy ');f.gates[0].resolve(true);await saving;
  assert.deepEqual(f.calls[0].body,{room:'A',title:'Legacy'});assert.equal(f.context.roomPreferenceSequence,0);
});
test('invalid or stale editors consume no alias intent and account replacement rejects an old completion',async()=>{
  const f=renameFixture();await f.context.saveRoomTitle(' ');assert.equal(f.calls.length,0);assert.equal(f.context.roomPreferenceSequence,0);
  f.context.readerGeneration=2;await f.context.saveRoomTitle('Stale');assert.equal(f.calls.length,0);
  f.open();const old=f.context.saveRoomTitle('Old account');
  f.context.readerGeneration=3;f.open();f.error.textContent='NEW ACCOUNT';
  const latest=f.context.saveRoomTitle('New account');f.gates[0].resolve(true);await old;
  assert.equal(f.dialog.open,true);assert.equal(f.error.textContent,'NEW ACCOUNT');
  f.gates[1].resolve(true);await latest;assert.deepEqual(f.calls.map(v=>v.body.preferenceSequence),[1,2]);
});
test('cancelling obsolete message GET releases even an abort-ignoring body and leaves POST untouched',async()=>{
  const requests=[],context=vm.createContext({AbortController,Headers,setTimeout,clearTimeout,messageReads:new Set(),lastState:null,localSession:null,
    requestStamp:()=>({}),stampCurrent:()=>true,staleResult:()=>Object.assign(Error('stale'),{name:'StaleLocalResult'}),
    requestDeadline:()=>1000,unavailable(){throw Error('obsolete GET must not mark connection unavailable');},
    fetch:async(path,options)=>{const gate=deferred();requests.push({path,options,gate});return {status:200,json:()=>gate.promise};}});
  vm.runInContext(block('async function localRequest(', 'function tabGraceLabel('),context);
  assert.equal(typeof context.cancelMessageReads,'function','actual message GET cancellation owner must exist');
  const get=context.localRequest('/api/reader/messages?room=A').then(()=>({ok:true}),error=>({error:error.name}));
  const post=context.localRequest('/api/reader/send',{method:'POST'});await settle();context.cancelMessageReads();
  assert.equal((await get).error,'StaleLocalResult');assert.equal(requests[0].options.signal.aborted,true);assert.equal(requests[1].options.signal.aborted,false);
  requests[1].gate.resolve({accepted:true});assert.equal((await post).data.accepted,true);assert.equal(context.messageReads.size,0);
  requests[0].gate.resolve({stale:true});await settle();
});
