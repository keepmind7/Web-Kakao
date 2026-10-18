// Real UI/local HTTP, injected account-free auth/reader/preferences only.
import {spawn} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {createLocalServer} from '../experiments/local-web/server.mjs';
const output=resolve(process.env.WEB_KAKAO_QA_OUTPUT_ROOT||'local-only/qr-openchat-20261018/qa/browser',String(Date.now()));mkdirSync(output,{recursive:true});
const profile=resolve(output,'p'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const chrome=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(existsSync);assert.ok(chrome,'installed Chrome required');
const key='r_'+'a'.repeat(24),other='r_'+'b'.repeat(24),message='m_'+'1'.repeat(24),checks=[],pending=new Map(),authCalls=[];
let browser,socket,sequence=0,revision=1,outbox=[],requests=[],reads=0,acks=0,phase='failed',status=-203,holdResults=false;
const rows=[key,other].map((key,n)=>({key,title:'Synthetic OM '+n,kind:'OpenMultiChat',canText:true,canReply:true,canPhoto:true,canRead:false,canContext:false,historyAvailable:false,unreadLocalCount:0,unreadCoverage:'observed'}));
const app=createLocalServer({mode:'live',messaging:true,encode:()=>[[true]],
 transport:async op=>{authCalls.push(op);return op==='allowlist'?{httpStatus:200,body:{allowlisted:true}}:op==='generate'?{httpStatus:200,body:{status:0,url:'SYNTHETIC_NO_LOGIN',remainingSeconds:180}}:{httpStatus:200,body:{status:0,user:{userId:'999'},accessToken:'SYNTHETIC_NO_ACCOUNT'}};},
 preferenceStore:{account(){assert.fail('no real preference IO');},close(){}},
 readerFactory:()=>({snapshot:()=>({instanceId:'a'.repeat(24),phase:'connected',attempts:1,canConnect:false,roomCount:2,revision,roomsRevision:revision,outboxRevision:revision,settingsRevision:0,historyBusy:false,operationBusy:false}),rooms:()=>({rooms:rows}),
  messages:room=>({key:room,messages:[{key:message,text:'Synthetic quoted text',sender:'Synthetic peer',canReply:true}],history:{phase:'loaded'},latestVisible:true}),
  outbox:id=>{const values=holdResults?outbox.map(e=>({...e,phase:'sending'})):outbox;return id?values.find(e=>e.clientId===id)??null:values.filter(e=>['sending','unknown'].includes(e.phase));},
  acknowledgeOutbox(id){acks++;outbox=outbox.filter(e=>e.clientId!==id);revision++;return true;},
  sendText(room,_text,id,replyTo){requests.push({kind:'text',room,reply:replyTo!==undefined});outbox.push({key:room,clientId:id,kind:'send',phase,status});revision++;return true;},
  sendPhoto(room,_image,id){requests.push({kind:'photo',room});outbox.push({key:room,clientId:id,kind:'photo',phase,status});revision++;return true;},seen(){reads++;return false;},close(){}})});
function command(method,params={}){return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP deadline '+method));},8000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const r=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||'evaluation failed');return r.result?.value;}
async function until(expression){const end=Date.now()+8000;while(!await evaluate(expression).catch(()=>false)){if(Date.now()>end)throw new Error('fixture deadline '+expression);await sleep(25);}}
async function check(name,fn){try{checks.push({name,status:'passed',observed:await fn()});}catch(e){checks.push({name,status:e.code==='ERR_ASSERTION'?'expected_red':'fixture_error',error:String(e.message).slice(0,1600)});}}
async function refresh(){await evaluate("(async()=>{while(busy||refreshing)await new Promise(r=>setTimeout(r,5));await refresh();clearTimeout(pollTimer);pollTimer=null;})()");}
async function reset(){
 outbox=[];phase='failed';status=-203;holdResults=false;revision++;
 await evaluate(`pendingSend=null;uncertainPhoto=null;clearImageDraft();replyDrafts.clear();drafts.clear();sendNotes.clear();el('compose-text').value='';showAccount(false);renderComposer();`);
 await refresh();await evaluate('selectRoom('+JSON.stringify(key)+')');await until('currentPage?.key===selectedRoom&&!pendingSelection&&!busy&&!refreshing');
}
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
async function submit(kind='text'){
 if(kind==='reply'){await evaluate("document.querySelector('.message').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));el('message-menu-reply').click()");assert.equal(await evaluate('replyDrafts.has(selectedRoom)'),true);}
 if(kind==='photo'){
  await evaluate(`prepareImage(new File([Uint8Array.from(atob('${png}'),c=>c.charCodeAt(0))],'synthetic.png',{type:'image/png'}))`);await until("el('image-send-dialog').open&&!el('image-send').disabled");await evaluate("el('image-send').click()");
 }else await evaluate("el('compose-text').value='Synthetic retained draft';el('compose-text').dispatchEvent(new Event('input'));el('compose-form').requestSubmit()");
 if(!holdResults)await until("pendingSend===null&&!busy&&!refreshing");
}
const observe="({note:el('send-status').textContent,draft:el('compose-text').value,reply:replyDrafts.has(selectedRoom),photo:Boolean(imageDraft),connected:lastState.reader.phase,warning:!el('send-reset').hidden,room:selectedRoom})";
let fatal=null,chromeExitObserved=false;
try{
 const url=await app.listen(0);assert.notEqual(app.server.address().port,8787);await app.lab.start();const authEnd=Date.now()+4000;while(!app.lab.snapshot().credentialInMemory){if(Date.now()>authEnd)throw new Error('synthetic auth deadline');await sleep(20);}
 browser=spawn(chrome,['--headless=new','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--disable-component-update','--disable-background-timer-throttling','--disable-renderer-backgrounding','--no-proxy-server','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,'--window-size=1100,900','about:blank'],{windowsHide:true,stdio:'ignore'});
 const file=resolve(profile,'DevToolsActivePort'),end=Date.now()+14000;while(!existsSync(file)){if(Date.now()>end)throw new Error('Chrome startup deadline');await sleep(40);}
 const port=Number(readFileSync(file,'utf8').split(/\r?\n/)[0]);assert.notEqual(port,8787);const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});socket.addEventListener('message',event=>{const r=JSON.parse(event.data),entry=pending.get(r.id);if(!entry)return;pending.delete(r.id);clearTimeout(entry.timer);r.error?entry.reject(new Error(r.error.message)):entry.resolve(r.result);});
 const issue=await fetch(url+'/api/local/launch',{method:'POST',headers:{Origin:url,'Content-Type':'application/json','X-Local-Control':app.controlToken},body:'{}'});assert.equal(issue.status,200);await command('Page.navigate',{url:url+'/launch#launch='+(await issue.json()).ticket});
 await until("location.pathname==='/'&&typeof lastState!=='undefined'&&lastState!==null&&roomsCache.length===2&&!busy&&!refreshing");await evaluate("clearTimeout(pollTimer);pollTimer=null;clearTimeout(queuedRefreshTimer);queuedRefreshTimer=null;refreshPending=false;Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});document.hasFocus=()=>false;foregroundFocused=false;el('read-sync').checked=false");
 for(const kind of ['text','reply','photo'])await check('known body-203 rejection retains '+kind+' draft and healthy connection without resending',async()=>{
  await reset();const count=requests.length;await submit(kind);const value=await evaluate(observe);await refresh();await sleep(100);
  assert.equal(requests.length,count+1);assert.equal(value.connected,'connected');assert.equal(value.warning,false);assert.equal(reads,0);
  if(kind==='photo')assert.equal(value.photo,true);else assert.equal(value.draft,'Synthetic retained draft');if(kind==='reply')assert.equal(value.reply,true);
  assert.match(value.note,/서버.*거절/);assert.ok(value.note.includes('-203'));assert.doesNotMatch(value.note,/연결 상태|연결.*종료/);return {...value,requests:requests.length-count};
 });
 for(const [label,value] of [['null',null],['numeric string','-203'],['object',{detail:'RAW_STATUS_CANARY'}],['outside signed32',2147483648],['zero',0]])await check('failed '+label+' status stays neutral and is never interpolated',async()=>{
  await reset();status=value;const count=requests.length;await submit();const v=await evaluate(observe);assert.equal(requests.length,count+1);assert.equal(v.draft,'Synthetic retained draft');assert.equal(v.connected,'connected');assert.ok(v.note.trim());assert.doesNotMatch(v.note,/서버.*거절|연결 상태|연결.*종료|-203|RAW_STATUS_CANARY|2147483648|\[object Object\]/);return {label,...v};
 });
 await check('unknown keeps mobile confirmation warning and does not retry or assert rejection',async()=>{
  await reset();phase='unknown';status=null;const count=requests.length;await evaluate("el('compose-text').value='Synthetic unknown draft';el('compose-text').dispatchEvent(new Event('input'));el('compose-form').requestSubmit()");await until("pendingSend?.phase==='unknown'&&!busy&&!refreshing");const v=await evaluate(observe);assert.equal(v.warning,true);assert.match(v.note,/확인할 수 없/);assert.doesNotMatch(v.note,/서버.*거절/);assert.equal(await evaluate("el('send-reset').textContent"),'모바일 확인 후 경고 닫기');await refresh();assert.equal(requests.length,count+1);assert.equal(acks,0);return v;
 });
 await check('late rejection is scoped to its original room, never the selected other room',async()=>{
  await reset();holdResults=true;const count=requests.length;await submit();await until('pendingSend!==null&&!busy&&!refreshing');await evaluate('selectRoom('+JSON.stringify(other)+')');await until('selectedRoom==='+JSON.stringify(other)+'&&!pendingSelection');holdResults=false;revision++;await refresh();const v=await evaluate(observe);assert.equal(v.room,other);assert.doesNotMatch(v.note,/-203|서버.*거절/);assert.equal(requests.length,count+1);return v;
 });
 await check('account end discards pending rejection and cannot publish it into a new account view',async()=>{
  await reset();holdResults=true;const count=requests.length;await submit();await until('pendingSend!==null&&!busy&&!refreshing');app.lab.cancel();holdResults=false;revision++;await refresh();const v=await evaluate("({hasAccount,pending:pendingSend,note:el('send-status').textContent,notes:sendNotes.size,drafts:drafts.size})");assert.equal(v.hasAccount,false);assert.equal(v.pending,null);assert.equal(v.notes,0);assert.equal(v.drafts,0);assert.doesNotMatch(v.note,/-203|서버.*거절/);assert.equal(requests.length,count+1);return v;
 });
 assert.equal(reads,0);assert.deepEqual(authCalls,['allowlist','generate','poll']);
}catch(e){fatal=String(e.stack);}
finally{
 for(const item of pending.values())clearTimeout(item.timer);pending.clear();socket?.close();chromeExitObserved=Boolean(browser&&(browser.exitCode!==null||browser.signalCode!==null));if(browser&&!chromeExitObserved){const exit=new Promise(r=>browser.once('exit',()=>{chromeExitObserved=true;r();}));browser.kill();await Promise.race([exit,sleep(3000)]);}
 app.lab.cancel();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));
 const result={checks,actualAccount:false,fatal,cleanup:{chromeExitObserved,serverListening:app.server.listening,pending:pending.size},profile,requests:requests.map(({kind,reply})=>({kind,reply})),readRequests:reads,acknowledgements:acks};writeFileSync(resolve(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({checks:checks.length,passed:checks.filter(c=>c.status==='passed').length,expectedRed:checks.filter(c=>c.status==='expected_red').length,fixtureErrors:checks.filter(c=>c.status==='fixture_error').length,fatal,cleanup:result.cleanup,output}));if(fatal||checks.some(c=>c.status!=='passed'))process.exitCode=1;
}
