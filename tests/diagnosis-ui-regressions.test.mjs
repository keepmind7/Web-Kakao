// Actual UI functions with injected state/transport only. No browser/account/network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../experiments/local-web/app.js',import.meta.url),'utf8');
const block=(from,to)=>source.slice(source.indexOf(from),source.indexOf(to,source.indexOf(from)));
const photo='11111111-1111-4111-8111-111111111111',text='22222222-2222-4222-8222-222222222222';
function fixture(){
  const nodes=new Map(),queries=[],messageQueries=[],posts=[];
  const context=vm.createContext({console,encodeURIComponent,crypto:{randomUUID:()=>photo},
    document:{hidden:false,hasFocus:()=>true,activeElement:{id:'BODY'},querySelector:()=>({scrollTop:0,scrollHeight:10,classList:{add(){}}})},performance:{now:()=>0},
    el:id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',disabled:false,focus(){},replaceChildren(){},addEventListener(_event,fn){this.handler=fn;}});return nodes.get(id);},
    queries,messageQueries,posts,entries:new Map(),jsonHook:null,postHook:null,actHook:null,clearedImages:0,refreshCalls:0,renderCalls:0,
  });
  vm.runInContext(`
    let hasAccount=true,readerGeneration=1,actionEpoch=0,resumeEpoch=0,readerAttempt=1,selectedRoom='A';
    let pendingSend=null,uncertainPhoto=null,imageDraft={room:'A',generation:1},outboxEpoch=0,restoredOutbox=[],outboxRevision=-1;
    let outboxAcknowledging=false,acknowledgingClientId=null,settingsBusy=false,settingsEpoch=0,settingsRevision=0,readerRevision=0;
    let viewPin=null,viewPinEpoch=0,viewPinPending=null,viewSequence=0;
    let selectionView=null,pendingSelection=null,reconnectRoom=null,userSelected=false,currentPage=null,busy=false,ackInFlight=false;
    let messageQuery='',renderedMessages=null,renderedMessageRoom=null;
    let roomsCache=[{key:'A',kind:'DirectChat',unreadLocalCount:1},{key:'B',kind:'DirectChat',unreadLocalCount:1},{key:'C',kind:'DirectChat',unreadLocalCount:1}];
    const seenDispatches=new Map(),contextDispatches=new Set(),contextRetryAt=new Map();
    const viewClientId='${photo}',sendNotes=new Map(),drafts=new Map(),replyDrafts=new Map();
    let freshness='fresh',lastState={outboxRecovery:true,viewPin:true,viewOrdering:true,messaging:true,reader:{phase:'connected',revision:1}};
    function requestStamp(){return {generation:readerGeneration,action:actionEpoch,resume:resumeEpoch};}
    function stampCurrent(stamp){return stamp.generation===readerGeneration && stamp.action===actionEpoch && stamp.resume===resumeEpoch;}
    function renderComposer(){globalThis.renderCalls++;}
    function unavailable(){freshness='unavailable';}
    function clearImageDraft(){imageDraft=null;globalThis.clearedImages++;}
    // Photo HTTP lifecycle is exercised by photo-loading tests; this fixture
    // isolates selection/read admission and has no image DOM or loader.
    function clearIncomingPhotos(){}
    function messageViewCovered(){return false;}
    function roomNow(){return roomsCache.find(room=>room.key===selectedRoom);}
    function roomCan(){return true;}
    function nearBottom(){return true;}
    function contextGeneration(){return 0;}
    function closeMessageMenu(){}function closeRoomActions(){}function showAccount(){}
    function resetMessageSearch(){}function renderRooms(){}function renderChatHeading(){}function render(){}
    function invalidateViewPin(){viewPin=null;viewPinPending=null;viewPinEpoch++;}
    function preferenceReady(){return hasAccount;}
    async function refreshMessages(key){messageQueries.push('/api/reader/messages?room='+key);currentPage={key,messages:[{key:'synthetic-message'}],history:{phase:'idle'},latestVisible:true,seenToken:'c'.repeat(48),entryPhase:'idle'};}
    async function refresh(){globalThis.refreshCalls++;}
    async function act(path,body){posts.push({path,body});return globalThis.actHook?globalThis.actHook(path,body):true;}
    async function localJson(path,isCurrent=()=>true){queries.push(path);const value=globalThis.jsonHook?await globalThis.jsonHook(path):{entry:entries.get(decodeURIComponent(path.split('clientId=')[1]))};if(!isCurrent())throw Error('stale');return value;}
    async function postLocal(path,body){posts.push({path,body});return globalThis.postHook?globalThis.postHook(path,body):true;}
    ${block('function markSendUnknown(', 'async function maybeSeen(')}
    ${block('async function maybeSeen(', 'async function pinSelectedRoom(')}
    ${block('async function pinSelectedRoom(', 'function showAccount(')}
    ${block('async function selectRoom(', 'function reconcileChildren(')}
    ${block('async function changeSettings(', 'async function saveSettings(')}
    ${block("el('history-load').addEventListener", "el('room-search').addEventListener")}
  `,context);
  return {context,nodes,queries,messageQueries,posts,run:code=>vm.runInContext(code,context)};
}

for(const phase of ['accepted','failed'])test('D1 lost photo response recovers '+phase+' by original clientId and unlocks photo only',async()=>{
  const f=fixture();f.run(`pendingSend={room:'A',clientId:'${photo}',kind:'photo',phase:'sending'};markSendUnknown(pendingSend);`);
  f.context.entries.set(photo,{key:'A',clientId:photo,kind:'photo',phase});
  await f.run('refreshPendingSend()');
  assert.equal(f.run('uncertainPhoto'),null);assert.equal(f.run('pendingSend'),null);
  assert.equal(f.queries.length,1);assert.match(f.queries[0],new RegExp(photo));assert.equal(f.posts.length,0,'never resend');
  assert.equal(f.run('imageDraft===null'),phase==='accepted','known failure retains the image for explicit user action');
});
test('D1 recovered photo cannot erase a newer pending text request',async()=>{
  const f=fixture();f.run(`uncertainPhoto={room:'A',clientId:'${photo}',kind:'photo',phase:'unknown'};pendingSend={room:'A',clientId:'${text}',kind:'text',phase:'sending',text:'synthetic'};`);
  f.context.entries.set(text,{key:'A',clientId:text,kind:'send',phase:'sending'});
  f.context.entries.set(photo,{key:'A',clientId:photo,kind:'photo',phase:'accepted'});
  await f.run('refreshPendingSend()');assert.equal(f.run('pendingSend.clientId'),text);assert.equal(f.run('uncertainPhoto'),null);assert.equal(f.posts.length,0);
});
for(const value of [null,{phase:'unknown'},{phase:'sending'},{phase:'accepted',key:'B'},{phase:'accepted',kind:'send'},{phase:'accepted',clientId:text}])test('D1 unresolved or mismatched photo result preserves uncertainty '+JSON.stringify(value),async()=>{
  const f=fixture();f.run(`uncertainPhoto={room:'A',clientId:'${photo}',kind:'photo',phase:'unknown'};`);
  f.context.entries.set(photo,value && {key:'A',clientId:photo,kind:'photo',...value});
  await f.run('refreshPendingSend()');assert.equal(f.run('uncertainPhoto.clientId'),photo);assert.equal(f.posts.length,0);
});
test('D1 late old-account photo result cannot clear the new account draft or warning',async()=>{
  const f=fixture();let release;f.context.jsonHook=()=>new Promise(resolve=>{release=resolve;});
  f.run(`uncertainPhoto={room:'A',clientId:'${photo}',kind:'photo',phase:'unknown'};`);const pending=f.run('refreshPendingSend()');
  assert.equal(typeof release,'function');
  f.run(`readerGeneration++;uncertainPhoto={room:'B',clientId:'${text}',kind:'photo',phase:'unknown'};imageDraft={room:'B',generation:readerGeneration};`);
  release({entry:{key:'A',clientId:photo,kind:'photo',phase:'accepted'}});await pending;
  assert.equal(f.run('uncertainPhoto.clientId'),text);assert.equal(f.run('imageDraft.room'),'B');assert.equal(f.context.clearedImages,0);
});
for(const olderSuccess of [true,false])test('D5 old settings completion cannot release newer account lock or display an error '+olderSuccess,async()=>{
  const f=fixture(),releases=[];f.context.postHook=()=>new Promise(resolve=>releases.push(resolve));
  const first=f.run("changeSettings('/api/preferences',{persist:true})");
  f.run('readerGeneration++;settingsEpoch++;settingsBusy=false;');
  const second=f.run("changeSettings('/api/preferences',{persist:false})");assert.equal(f.posts.length,2);
  releases[0](olderSuccess);await first;
  assert.equal(f.run('settingsBusy'),true);assert.equal(f.nodes.get('preferences-status')?.textContent || '','');assert.equal(f.context.refreshCalls,0);
  await f.run("changeSettings('/api/preferences',{persist:true})");assert.equal(f.posts.length,2,'new request remains locked');
  releases[1](true);await second;assert.equal(f.run('settingsBusy'),false);assert.equal(f.context.refreshCalls,1);
});
test('D2 pin is cached only after acceptance and duplicate pending calls share one request',async()=>{
  const f=fixture();let release;f.context.postHook=()=>new Promise(resolve=>{release=resolve;});
  const first=f.run('pinSelectedRoom()');assert.equal(f.run('viewPin'),null);const second=f.run('pinSelectedRoom()');assert.equal(f.posts.length,1);
  release(true);assert.equal(await first,true);assert.equal(await second,true);assert.notEqual(f.run('viewPin'),null);
});

test('D5 same-account reconnect releases its own settings lock without applying the stale response',async()=>{
  const f=fixture();let release;f.context.postHook=()=>new Promise(resolve=>{release=resolve;});
  const first=f.run("changeSettings('/api/preferences',{persist:true})");f.run('readerGeneration++;');
  release(false);assert.equal(await first,false);assert.equal(f.run('settingsBusy'),false);
  assert.equal(f.nodes.get('preferences-status')?.textContent || '','');
  f.context.postHook=()=>true;assert.equal(await f.run("changeSettings('/api/preferences',{persist:false})"),true);
  assert.equal(f.posts.length,2,'reconnect must leave settings usable');
});
test('D2 reverse completion cannot restore an old room pin',async()=>{
  const f=fixture(),releases=[];f.context.postHook=()=>new Promise(resolve=>releases.push(resolve));
  const first=f.run('pinSelectedRoom()');f.run("selectedRoom='B';viewPin=null;viewPinEpoch++;");const second=f.run('pinSelectedRoom()');
  releases[1](true);assert.equal(await second,true);const pin=f.run('viewPin');releases[0](true);assert.equal(await first,false);assert.equal(f.run('viewPin'),pin);
  assert.equal(f.posts[0].body.viewClientId,f.posts[1].body.viewClientId);assert.ok(f.posts[1].body.viewSequence>f.posts[0].body.viewSequence);
});
test('D2 a rejected view is never cached and an explicit retry uses a new sequence',async()=>{
  const f=fixture();f.context.postHook=()=>false;
  assert.equal(await f.run('pinSelectedRoom()'),false);assert.equal(f.run('viewPin'),null);
  f.context.postHook=()=>true;assert.equal(await f.run('pinSelectedRoom()'),true);
  assert.equal(f.posts.length,2);assert.ok(f.posts[1].body.viewSequence>f.posts[0].body.viewSequence);
});
test('D2 new static UI retains legacy view shape until the running server advertises ordering',async()=>{
  const f=fixture();f.run('delete lastState.viewOrdering;');
  assert.equal(await f.run('pinSelectedRoom()'),true);
  assert.deepEqual(Object.keys(f.posts[0].body),['room']);
});

for(const result of ['rejected','exception'])test('D2 '+result+' selection cannot issue history or be revived by polling, cache invalidation or direct reads',async()=>{
  const f=fixture();f.context.postHook=()=>{if(result==='exception')throw Error('synthetic lost view response');return false;};
  await f.run("selectRoom('B')").catch(()=>{});
  assert.equal(f.messageQueries.length,0,'a nonaccepted selection stops before its own page GET');
  assert.equal(f.posts.filter(row=>row.path==='/api/reader/history').length,0);
  f.run("currentPage={key:'B',messages:[{key:'synthetic-message'}],history:{phase:'idle'},latestVisible:true,seenToken:'c'.repeat(48),entryPhase:'idle'};");
  f.nodes.get('read-sync') || f.run("el('read-sync').checked=true;");
  f.context.postHook=()=>true;
  for(let n=0;n<3;n++){f.run('invalidateViewPin();lastState.reader.revision++;');await f.run('flushSelection()');await f.run('advanceRoom()');await f.run('maybeSeen()');}
  assert.equal(f.posts.length,1,'poll/flush/advance/scroll-like direct read must not revive a rejected intent');
});
test('D2 a view still awaiting acceptance blocks flush even when a poll has already supplied an idle page',async()=>{
  const f=fixture();let release;f.context.postHook=()=>new Promise(resolve=>{release=resolve;});
  const selecting=f.run("selectRoom('B')");f.run("currentPage={key:'B',messages:[],history:{phase:'idle'}};");
  const flushing=f.run('flushSelection()');await Promise.resolve();
  assert.equal(f.posts.filter(row=>row.path==='/api/reader/history').length,0);
  release(false);await selecting;await flushing;await f.run('flushSelection()');
  assert.equal(f.posts.filter(row=>row.path==='/api/reader/history').length,0);
});
test('D2 accepted selection fetches its page and automatic history once',async()=>{
  const f=fixture();await f.run("selectRoom('B')");await f.run('flushSelection()');
  assert.equal(f.messageQueries.length,1);assert.deepEqual(f.posts.map(row=>row.path),['/api/reader/view','/api/reader/history']);
});
test('D2 same-room explicit reselection replaces a rejected intent and can load normally',async()=>{
  const f=fixture();f.context.postHook=()=>false;await f.run("selectRoom('B')");f.context.postHook=()=>true;
  await f.run("selectRoom('B')");assert.deepEqual(f.posts.map(row=>row.path),['/api/reader/view','/api/reader/view','/api/reader/history']);
});
test('D2 manual history is a new explicit intent after rejection and first obtains its own view acceptance',async()=>{
  const f=fixture();f.context.postHook=()=>false;await f.run("selectRoom('B')");f.context.postHook=()=>true;
  await f.nodes.get('history-load').handler();
  assert.deepEqual(f.posts.map(row=>row.path),['/api/reader/view','/api/reader/view','/api/reader/history']);
});
test('D2 deferred reconnect catches up once after becoming eligible without granting context or read',async()=>{
  const f=fixture();f.run("selectedRoom='B';userSelected=false;freshness='checking';pendingSelection=selectionView={key:'B',generation:readerGeneration,attempt:readerAttempt,phase:'waiting'};");
  await f.run('flushSelection()');assert.equal(f.posts.length,0,'freshness shortage is deferred');
  f.run("freshness='fresh';document.hidden=true;");await f.run('flushSelection()');assert.equal(f.posts.length,0);
  f.run('document.hidden=false;');await f.run('flushSelection()');await f.run('flushSelection()');await f.run('advanceRoom()');await f.run('maybeSeen()');
  assert.deepEqual(f.posts.map(row=>row.path),['/api/reader/view','/api/reader/history']);assert.equal(f.run('userSelected'),false);
});
test('D2 a rejected restored view stays rejected rather than retrying on a later revision',async()=>{
  const f=fixture();f.run("selectedRoom='B';pendingSelection=selectionView={key:'B',generation:readerGeneration,attempt:readerAttempt,phase:'waiting'};");
  f.context.postHook=()=>false;await f.run('flushSelection()');f.context.postHook=()=>true;
  f.run('lastState.reader.revision++;');await f.run('flushSelection()');await f.run('advanceRoom()');
  assert.deepEqual(f.posts.map(row=>row.path),['/api/reader/view']);
});
test('D2 accepted view retains the existing busy-history revision retry contract',async()=>{
  const f=fixture();let calls=0;f.context.actHook=()=>++calls>1;
  await f.run("selectRoom('B')");await f.run('flushSelection()');assert.equal(calls,1);
  f.run('lastState.reader.revision++;');await f.run('flushSelection()');await f.run('flushSelection()');
  assert.equal(calls,2);assert.equal(f.posts.filter(row=>row.path==='/api/reader/view').length,1);
});
test('D2 a late rejected prior-room selection cannot poison the newly accepted intent',async()=>{
  const f=fixture();let release;f.context.postHook=()=>new Promise(resolve=>{release=resolve;});
  const older=f.run("selectRoom('B')");f.context.postHook=()=>true;await f.run("selectRoom('C')");release(false);await older;
  assert.deepEqual(f.posts.filter(row=>row.path==='/api/reader/history').map(row=>row.body.room),['C']);assert.equal(f.run('selectedRoom'),'C');
});
test('D2 concurrent flushes sharing a pending view cannot duplicate automatic history',async()=>{
  const f=fixture();let release;f.context.postHook=()=>new Promise(resolve=>{release=resolve;});
  const selecting=f.run("selectRoom('B')");f.run("currentPage={key:'B',messages:[],history:{phase:'idle'}};");
  const first=f.run('flushSelection()'),second=f.run('flushSelection()');release(true);
  await Promise.all([selecting,first,second]);assert.equal(f.posts.filter(row=>row.path==='/api/reader/history').length,1);
});
test('D2 accepted view still permits the eligible direct read path',async()=>{
  const f=fixture();await f.run("selectRoom('B')");await f.run("el('read-sync').checked=true;maybeSeen()");
  const seen=f.posts.filter(row=>row.path==='/api/reader/seen');assert.equal(seen.length,1);assert.equal(seen[0].body.notify,true);
});
test('D2 legacy server without view capability retains explicit history behavior',async()=>{
  const f=fixture();f.run('lastState.viewPin=false;');await f.run("selectRoom('B')");
  assert.deepEqual(f.posts.map(row=>row.path),['/api/reader/history']);
});
test('D2 late old-account rejection cannot revoke the new account accepted selection',async()=>{
  const f=fixture();let release;f.context.postHook=()=>new Promise(resolve=>{release=resolve;});const old=f.run("selectRoom('B')");
  f.run("readerGeneration++;readerAttempt++;pendingSelection=null;selectionView=null;invalidateViewPin();selectedRoom='A';");
  f.context.postHook=()=>true;await f.run("selectRoom('C')");release(false);await old;
  assert.equal(f.run('selectionView.phase'),'accepted');assert.equal(f.run('selectionView.key'),'C');
  assert.deepEqual(f.posts.filter(row=>row.path==='/api/reader/history').map(row=>row.body.room),['C']);
});
test('D2 cache invalidation during a held view cannot discard its rejection or start a competing admission',async()=>{
  const f=fixture();let release;f.context.postHook=()=>new Promise(resolve=>{release=resolve;});
  const selecting=f.run("selectRoom('B')");f.run("invalidateViewPin();currentPage={key:'B',messages:[],history:{phase:'idle'}};");
  f.context.postHook=()=>true;const flushing=f.run('flushSelection()');await Promise.resolve();
  assert.equal(f.posts.length,1,'cache invalidation must not start a competing view for the same intent');
  release(false);await Promise.all([selecting,flushing]);await f.run('flushSelection()');await f.run('advanceRoom()');
  assert.equal(f.posts.length,1);assert.equal(f.run('selectionView.phase'),'rejected');
});
test('D2 an accepted held view invalidated by focus can acquire a fresh pin and finish normally',async()=>{
  const f=fixture();let release;f.context.postHook=()=>new Promise(resolve=>{release=resolve;});
  const selecting=f.run("selectRoom('B')");f.run('invalidateViewPin();');release(true);await selecting;
  f.context.postHook=()=>true;await f.run("refreshMessages('B')");await f.run('flushSelection()');
  assert.equal(f.run('selectionView.phase'),'accepted');assert.equal(f.posts.filter(row=>row.path==='/api/reader/history').length,1);
});
for(const legacy of [false,true])test('P3 checking manual loaded-page request survives until fresh and runs exactly once '+(legacy?'legacy':'ordered'),async()=>{
  const f=fixture();f.run(`freshness='checking';lastState.viewPin=${!legacy};currentPage={key:'A',messages:[],history:{phase:'loaded'}};`);
  await f.nodes.get('history-load').handler();await f.run('flushSelection()');
  assert.equal(f.posts.length,0);assert.notEqual(f.run('pendingSelection'),null);
  f.run("freshness='fresh';");await f.run('flushSelection()');await f.run('advanceRoom()');await f.run('flushSelection()');
  assert.deepEqual(f.posts.map(row=>row.path),legacy?['/api/reader/history']:['/api/reader/view','/api/reader/history']);
});
test('P3 repeated manual clicks while checking share one queued history and one accepted view',async()=>{
  const f=fixture();f.run("freshness='checking';currentPage={key:'A',messages:[],history:{phase:'loaded'}};");
  await f.nodes.get('history-load').handler();const intent=f.run('pendingSelection');
  await Promise.all([f.nodes.get('history-load').handler(),f.nodes.get('history-load').handler()]);
  assert.equal(f.run('pendingSelection'),intent);assert.equal(f.posts.length,0);
  f.run("freshness='fresh';");await Promise.all([f.run('flushSelection()'),f.run('flushSelection()')]);
  assert.deepEqual(f.posts.map(row=>row.path),['/api/reader/view','/api/reader/history']);
});
test('P3 checking manual intent is discarded when the user selects another room',async()=>{
  const f=fixture();f.run("freshness='checking';");await f.nodes.get('history-load').handler();
  f.run("freshness='fresh';");await f.run("selectRoom('B')");await f.run('flushSelection()');
  assert.deepEqual(f.posts.filter(row=>row.path==='/api/reader/history').map(row=>row.body.room),['B']);
});
for(const boundary of ['readerGeneration','readerAttempt'])test('P3 checking manual intent cannot cross '+boundary,async()=>{
  const f=fixture();f.run("freshness='checking';");await f.nodes.get('history-load').handler();
  f.run(`${boundary}++;freshness='fresh';`);await f.run('flushSelection()');
  assert.equal(f.posts.length,0);assert.equal(f.run('pendingSelection'),null);
});
test('P3 a deferred manual view rejected after recovery stays rejected through further polls',async()=>{
  const f=fixture();f.run("freshness='checking';currentPage={key:'A',messages:[],history:{phase:'loaded'}};");
  await f.nodes.get('history-load').handler();f.context.postHook=()=>false;f.run("freshness='fresh';");await f.run('flushSelection()');
  assert.deepEqual(f.posts.map(row=>row.path),['/api/reader/view']);assert.equal(f.run('selectionView.phase'),'rejected');
  f.context.postHook=()=>true;await f.run('flushSelection()');await f.run('advanceRoom()');
  assert.equal(f.posts.length,1,'recovery must not retry a rejected view');
});
test('P3 double clicks sharing a held manual view do not duplicate its history',async()=>{
  const f=fixture();let release;f.context.postHook=()=>new Promise(resolve=>{release=resolve;});
  const first=f.nodes.get('history-load').handler(),second=f.nodes.get('history-load').handler();
  assert.equal(f.posts.length,1);release(true);await Promise.all([first,second]);
  assert.equal(f.posts.filter(row=>row.path==='/api/reader/history').length,1);
});
