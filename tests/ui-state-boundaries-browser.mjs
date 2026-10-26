// Isolated real Chrome + synthetic local server. No real account or external transport.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {createLocalServer} from '../experiments/local-web/server.mjs';
import {testBrowser} from './browser-platform.mjs';
const output=resolve(process.env.WEB_KAKAO_QA_OUTPUT_ROOT || 'local-only/ui-state-boundaries-browser');mkdirSync(output,{recursive:true});
const temporary=mkdtempSync(join(tmpdir(),'wk-ui-boundary-')),profile=resolve(temporary,'p'),chrome=testBrowser();assert.ok(chrome);
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),defer=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const first='r_'+'a'.repeat(24),second='r_'+'b'.repeat(24),rows=[first,second].map((key,n)=>({key,title:'Synthetic '+n,kind:'DirectChat',historyAvailable:false,canContext:false,canRead:false,canText:false}));
let revision=1,settings={persist:false,notifications:false,readSync:false,roomFilter:'all',storageAvailable:true,storageError:false},settingGate=null,renameGate=null,renameResult=true,rejectSetting=false;
const writes=[],renames=[],checks=[],pending=new Map();let browser,socket,sequence=0,fatal=null,chromeExitObserved=false;
const app=createLocalServer({mode:'live',messaging:true,encode:()=>[[true]],
  transport:async op=>op==='allowlist'?{httpStatus:200,body:{allowlisted:true}}:op==='generate'?{httpStatus:200,body:{status:0,url:'SYNTHETIC_NO_LOGIN',remainingSeconds:180}}:{httpStatus:200,body:{status:0,user:{userId:'999'},accessToken:'SYNTHETIC_NO_ACCOUNT'}},
  readerFactory:()=>({snapshot:()=>({instanceId:'a'.repeat(24),phase:'connected',attempts:1,canConnect:false,roomCount:2,revision,settingsRevision:revision,historyBusy:false,operationBusy:false}),
    rooms:()=>({rooms:rows}),messages:key=>({key,messages:[{key:'m_'+'c'.repeat(24),text:'Synthetic body '+(key===first?'A':'B'),sender:'Synthetic'}],latestVisible:true,history:{phase:'loaded'}}),settingsSnapshot:()=>settings,
    async updateSettings(patch){writes.push(patch);if(settingGate)await settingGate.promise;if(rejectSetting)return false;settings={...settings,...patch};revision++;return true;},
    async roomPreferences(key,patch,{isCurrent=()=>true}={}){renames.push({key,patch});const gate=renameGate,result=renameResult;if(gate)await gate.promise;if(!isCurrent())return false;if(result){const row=rows.find(r=>r.key===key);row.localTitle=patch.title;revision++;}return result;},close(){}})});
function command(method,params={}){return new Promise((accept,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},10000);pending.set(id,{accept,reject,timer});socket.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const r=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description || 'evaluation failed');return r.result?.value;}
async function until(expression){const end=Date.now()+10000;while(!await evaluate(expression)){if(Date.now()>end)throw Error('UI deadline '+expression);await sleep(25);}}
async function check(name,fn){try{checks.push({name,status:'passed',evidence:await fn()});}catch(error){checks.push({name,status:'failed',error:String(error.message).slice(0,1000)});}}
async function select(key){await evaluate('selectRoom('+JSON.stringify(key)+')');await until('currentPage?.key==='+JSON.stringify(key)+'&&!busy&&!refreshing&&!pendingSelection');}
try{
  const url=await app.listen(0);assert.notEqual(app.server.address().port,8787);await app.lab.start();
  const authEnd=Date.now()+5000;while(!app.lab.snapshot().credentialInMemory){if(Date.now()>authEnd)throw Error('synthetic auth deadline');await sleep(20);}
  browser=spawn(chrome,['--headless=new','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--disable-background-timer-throttling','--disable-renderer-backgrounding','--no-proxy-server','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,'--window-size=1100,900','about:blank'],{windowsHide:true,stdio:'ignore'});
  const file=resolve(profile,'DevToolsActivePort'),end=Date.now()+15000;while(!existsSync(file)){if(Date.now()>end)throw Error('Chrome startup deadline');await sleep(40);}
  const port=Number(readFileSync(file,'utf8').split(/\r?\n/)[0]);assert.notEqual(port,8787);
  const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
  await new Promise((a,b)=>{socket.addEventListener('open',a,{once:true});socket.addEventListener('error',b,{once:true});});
  socket.addEventListener('message',event=>{const r=JSON.parse(event.data),entry=pending.get(r.id);if(!entry)return;pending.delete(r.id);clearTimeout(entry.timer);r.error?entry.reject(Error(r.error.message)):entry.accept(r.result);});
  const issue=await fetch(url+'/api/local/launch',{method:'POST',headers:{Origin:url,'Content-Type':'application/json','X-Local-Control':app.controlToken},body:'{}'});assert.equal(issue.status,200);
  await command('Page.navigate',{url:url+'/launch#launch='+(await issue.json()).ticket});
  await until("typeof roomsCache!=='undefined'&&roomsCache.length===2&&personalSettings!==null&&!busy&&!refreshing");
  await evaluate("clearTimeout(pollTimer);pollTimer=null;document.hasFocus=()=>true;Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});showAccount(true)");
  await check('real UI retains last OFF and commits it after held ON',async()=>{
    settingGate=defer();await evaluate("el('read-sync').click()");
    const end=Date.now()+3000;while(!writes.length){if(Date.now()>end)throw Error('ON not received');await sleep(10);}
    assert.equal(writes[0].readSync,true);await evaluate("el('read-sync').click()");assert.equal(await evaluate("el('read-sync').checked"),false);
    settingGate.resolve();settingGate=null;await until("!settingsBusy&&personalSettings?.readSync===false&&readSyncIntent===null");
    assert.deepEqual(writes.map(v=>v.readSync),[true,false]);return {writes:2,checked:await evaluate("el('read-sync').checked")};
  });
  await check('a failed read OFF stays off through an unrelated persistent-setting save without retry',async()=>{
    const before=writes.length;settings={...settings,readSync:true};revision++;await evaluate('settingsRevision=-1;refresh()');
    rejectSetting=true;await evaluate('saveSettings({readSync:false})');rejectSetting=false;
    assert.equal(await evaluate("el('read-sync').checked"),false);await evaluate('saveSettings({persist:true})');
    assert.deepEqual(writes.slice(before),[{readSync:false},{persist:true}]);assert.equal(await evaluate("el('read-sync').checked"),false);
    assert.match(await evaluate("el('preferences-status').textContent"),/읽음.*확인하지 못/);
    await evaluate('saveSettings({readSync:false})');assert.equal(await evaluate('readSyncIntent'),null);return {noImplicitRetry:true,explicitRetry:true};
  });
  await evaluate('showAccount(false)');
  for(const accepted of [true,false])await check('late '+(accepted?'accepted':'denied')+' rename preserves replacement B dialog',async()=>{
    await select(first);renameGate=defer();renameResult=accepted;const previous=renames.length;
    await evaluate("el('rename-room').click();el('room-title-input').value='Synthetic edited';el('rename-form').requestSubmit()");
    const end=Date.now()+3000;while(renames.length===previous){if(Date.now()>end)throw Error('rename not received');await sleep(10);}
    await evaluate("el('rename-cancel').click()");await select(second);await evaluate("el('rename-room').click();el('room-title-input').value='B draft'");
    renameGate.resolve();renameGate=null;await sleep(100);
    const r=await evaluate("({open:el('rename-dialog').open,key:renameTarget?.key,value:el('room-title-input').value,error:el('rename-error').textContent})");
    assert.equal(r.open,true);assert.equal(r.key,second);assert.equal(r.value,'B draft');assert.equal(r.error,'');assert.equal(renames.at(-1).key,first);
    await evaluate("el('rename-cancel').click()");return {open:r.open,rightTarget:true};
  });
  await check('cancelled same-room alias cannot overwrite a newer saved alias through local HTTP',async()=>{
    await select(first);const held=defer();renameGate=held;renameResult=true;const previous=renames.length;
    await evaluate(`globalThis.aliasResponses=[];globalThis.nativeAliasFetch=window.fetch.bind(window);window.fetch=async(path,options={})=>{
      const response=await nativeAliasFetch(path,options);if(path==='/api/preferences/room')aliasResponses.push({title:JSON.parse(options.body).title,status:response.status});return response;};`);
    try{
      await evaluate("el('rename-room').click();el('room-title-input').value='Synthetic old same-room';el('rename-form').requestSubmit()");
      const end=Date.now()+3000;while(renames.length===previous){if(Date.now()>end)throw Error('old same-room rename not received');await sleep(10);}
      await evaluate("el('rename-cancel').click()");renameGate=null;
      await evaluate("el('rename-room').click();el('room-title-input').value='Synthetic latest same-room';el('rename-form').requestSubmit()");
      await until("aliasResponses.some(r=>r.title==='Synthetic latest same-room')&&!el('rename-dialog').open&&!refreshing");
      assert.equal(rows[0].localTitle,'Synthetic latest same-room');held.resolve();
      await until('aliasResponses.length===2');await evaluate('refresh()');
      const responses=await evaluate('aliasResponses');
      assert.deepEqual(responses,[{title:'Synthetic latest same-room',status:202},{title:'Synthetic old same-room',status:409}]);
      assert.equal(rows[0].localTitle,'Synthetic latest same-room');
      assert.equal(await evaluate(`roomsCache.find(r=>r.key===${JSON.stringify(first)}).localTitle`),'Synthetic latest same-room');
      assert.equal(renames.length,previous+2);return {latestStatus:202,lateStatus:409,latestAliasPreserved:true};
    }finally{held.resolve();renameGate=null;await evaluate('window.fetch=nativeAliasFetch');}
  });
  await check('obsolete message GET is aborted while new room text renders without an unavailable state',async()=>{
    await evaluate(`globalThis.nativeFetch=window.fetch.bind(window);globalThis.heldGet=false;globalThis.getAborted=false;window.fetch=(path,options={})=>{
      if(String(path).startsWith('/api/reader/messages?room=${first}')){heldGet=true;return new Promise((_a,reject)=>{options.signal.addEventListener('abort',()=>{getAborted=true;reject(new DOMException('obsolete','AbortError'));},{once:true});});}return nativeFetch(path,options);};void selectRoom(${JSON.stringify(first)});`);
    await until('heldGet');await select(second);await until('getAborted');
    const r=await evaluate("({fresh:freshness,key:currentPage.key,text:el('message-list').textContent,reads:messageReads.size})");
    assert.equal(r.fresh,'fresh');assert.equal(r.key,second);assert.match(r.text,/Synthetic body B/);assert.equal(r.reads,0);await evaluate('window.fetch=nativeFetch');return {aborted:true,fresh:true,rightBody:true};
  });
}catch(error){fatal=String(error.stack);}
finally{
  settingGate?.resolve();renameGate?.resolve();for(const entry of pending.values())clearTimeout(entry.timer);pending.clear();socket?.close();
  chromeExitObserved=Boolean(browser&&(browser.exitCode!==null||browser.signalCode!==null));if(browser&&!chromeExitObserved){const exit=new Promise(r=>browser.once('exit',()=>{chromeExitObserved=true;r();}));browser.kill();await Promise.race([exit,sleep(3000)]);}
  app.lab.cancel();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));
  const result={actualAccountUsed:false,actual8787Used:false,checks,fatal,cleanup:{chromeExitObserved,serverListening:app.server.listening,pending:pending.size},temporary};
  writeFileSync(resolve(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({output,checks:checks.length,passed:checks.filter(c=>c.status==='passed').length,fatal,cleanup:result.cleanup}));
  if(fatal||checks.some(c=>c.status!=='passed'))process.exitCode=1;
}
