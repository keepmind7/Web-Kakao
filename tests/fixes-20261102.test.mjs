// Reset generations and title admission. Inject every account/transport boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,statSync} from 'node:fs';
import {dirname,join,resolve,sep} from 'node:path';
import {createLocalServer} from '../experiments/local-web/server.mjs';
import {createReadOnlyReader} from '../experiments/local-web/reader-manager.mjs';
import {createPreferenceStore} from '../experiments/local-web/preferences.mjs';
import {createReaderStore} from '../experiments/local-web/reader-data.mjs';
import {createReaderSession} from '../experiments/local-web/reader-session.mjs';

const room='r_'+'1'.repeat(24),credential={userId:'999',deviceUUID:'SYNTHETIC',accessToken:'SYNTHETIC_NO_ACCOUNT'};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function gate(){let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release};}
async function within(promise,label,ms=5000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('synthetic checkpoint: '+label)),ms);})]);}finally{clearTimeout(timer);}}
async function until(predicate,label){const end=performance.now()+5000;while(!predicate()){assert.ok(performance.now()<end,'synthetic deadline: '+label);await sleep(10);}}

async function managerFixture({disk=false,failForget=false}={}){
  const children=[],workerMessages=[],gates=[],settingCalls=[],forgetEntered=gate();let checkpoint=null,directory=null,base=null;
  if(disk){base=resolve(process.env.WEB_KAKAO_QA_OUTPUT_ROOT || 'local-only/qa-fixes-20261102','regression-fixtures');mkdirSync(base,{recursive:true});directory=mkdtempSync(join(base,'reset-'));}
  const store=createPreferenceStore({...(disk?{folder:directory,asyncSecurity:true,secureFolder:path=>path,verifyFile:async path=>{
    if(checkpoint?.matches(path)){checkpoint.entered.release();await checkpoint.release.promise;}return true;
  }}:{})});
  const profile=await store.account('999');
  if(disk)assert.equal(await profile.set({persist:true}),true);
  const wrapped={...profile,set(patch,options){settingCalls.push({...patch});return profile.set(patch,options);},forget(options){forgetEntered.release();return failForget?false:profile.forget(options);}};
  const reader=createReadOnlyReader({messaging:true,preferenceStore:{account:()=>wrapped},spawn:()=>{
    const child=Object.assign(new EventEmitter(),{send(value,callback){workerMessages.push(value);callback?.();},kill(){queueMicrotask(()=>child.emit('exit',0,null));}});children.push(child);return child;
  }});
  function connect(){assert.equal(reader.connect(credential),true);const child=children.at(-1);child.emit('message',{type:'reader-ready'});child.emit('message',{type:'reader-rooms',source:'loginlist',rooms:[{key:room,title:'Synthetic',titleKnown:true,kind:'DirectChat',canSend:true,preferenceKey:'a'.repeat(64)}]});assert.equal(reader.snapshot().phase,'connected');}
  connect();
  return {reader,profile,workerMessages,connect,directory,settingCalls,forgetEntered:forgetEntered.promise,
    hold(matches=path=>path.includes('.json.') && path.endsWith('.tmp') && statSync(path).size>0){const entered=gate(),released=gate();checkpoint={matches,entered,release:released};gates.push(released);return {entered:entered.promise,release:()=>{checkpoint=null;released.release();}};},
    files:()=>directory?readdirSync(directory).filter(name=>name.endsWith('.json')):[],
    diskState:()=>{const name=readdirSync(directory).find(name=>name.endsWith('.json'));return name?JSON.parse(readFileSync(join(directory,name),'utf8')):null;},
    async close(){checkpoint=null;for(const held of gates)held.release();reader.close();if(directory){assert.equal(dirname(realpathSync(directory)),realpathSync(base));assert.ok(directory.startsWith(base+sep));rmSync(directory,{recursive:true,force:true});}},
  };
}

async function httpFixture(manager){
  let selected=manager;const sockets=new Set(),socketCloses=[],held=new Set(),results=[];
  const app=createLocalServer({mode:'live',messaging:true,controlToken:'f'.repeat(64),preferenceStore:{close(){}},encode:()=>[[true]],readerFactory:()=>selected.reader,
    transport:async operation=>({httpStatus:200,body:operation==='allowlist'?{allowlisted:true}:operation==='generate'?{status:0,url:'SYNTHETIC_NO_LOGIN',remainingSeconds:60}:{status:0,user:{userId:'999'},accessToken:'SYNTHETIC_NO_ACCOUNT'}})});
  app.server.on('connection',socket=>{sockets.add(socket);socketCloses.push(new Promise(resolve=>socket.once('close',()=>{sockets.delete(socket);resolve();})));});
  const url=await app.listen(0);assert.notEqual(app.server.address().port,8787);
  function request(path,body,extra={}){return new Promise((accept,reject)=>{
    const req=http.request(url+path,{method:'POST',agent:false,headers:{Origin:url,'Content-Type':'application/json',...extra}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.once('end',()=>{try{accept({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}catch(error){reject(error);}});
    });req.setTimeout(5000,()=>req.destroy(Error('synthetic HTTP timeout')));req.once('error',reject);req.end(JSON.stringify(body));
  });}
  const issue=await request('/api/local/launch',{}, {'X-Local-Control':app.controlToken});assert.equal(issue.status,200);
  const exchange=await request('/api/local/session',{ticket:issue.body.ticket});assert.equal(exchange.status,200);
  const auth={'X-Local-Session':exchange.body.session};await app.lab.start();
  await until(()=>app.lab.snapshot().credentialInMemory,'synthetic auth');
  const state=await(await fetch(url+'/api/status',{headers:auth})).json();
  const headers={...auth,'X-CSRF-Token':state.csrf,'X-Reader-Instance':manager.reader.snapshot().instanceId};
  function partial(body,{instance=true}={}){
    const text=JSON.stringify(body),entered=gate();let req;
    const listener=request=>{if(request.url==='/api/preferences'){app.server.off('request',listener);entered.release();}};app.server.on('request',listener);
    const extra={...headers};if(!instance)delete extra['X-Reader-Instance'];
    const result=new Promise((accept,reject)=>{
      req=http.request(url+'/api/preferences',{method:'POST',agent:false,headers:{Origin:url,'Content-Type':'application/json',...extra}},res=>{
        const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.once('end',()=>{try{accept({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}catch(error){reject(error);}});
      });held.add(req);req.once('close',()=>held.delete(req));req.once('error',reject);req.setTimeout(5000,()=>req.destroy(Error('synthetic partial timeout')));req.write(text.slice(0,8));
    });results.push(result);result.catch(()=>{});
    return {entered:entered.promise,result,finish:()=>req.end(text.slice(8))};
  }
  return {app,headers,request,partial,post:(body,extra={})=>request('/api/preferences',body,{...headers,...extra}),forget:(body={},extra={})=>request('/api/preferences/forget',body,{...headers,...extra}),
    async replace(next){assert.equal((await request('/api/cancel',{},headers)).status,200);selected=next;assert.equal((await request('/api/start',{},headers)).status,202);await until(()=>app.lab.snapshot().credentialInMemory,'replacement auth');},
    async close(){for(const req of held)req.destroy();app.server.closeAllConnections();await new Promise(resolve=>app.close(resolve));await Promise.all(socketCloses);await Promise.allSettled(results);assert.equal(app.server.listening,false);assert.equal(sockets.size,0);assert.equal(app.lab.snapshot().credentialInMemory,false);},
  };
}

for(const patch of [{readSync:true},{persist:true}])test('D1 partial pre-reset '+Object.keys(patch)[0]+' body cannot revive old settings',async()=>{
  const m=await managerFixture(),f=await httpFixture(m);
  try{
    const old=f.partial(patch);await within(old.entered,'partial admitted');assert.equal((await f.forget()).status,200);
    assert.equal(m.reader.settingsSnapshot()[Object.keys(patch)[0]],false);old.finish();assert.equal((await old.result).status,409);
    assert.equal(m.reader.settingsSnapshot()[Object.keys(patch)[0]],false);assert.equal(m.workerMessages.some(row=>row.type==='reader-action'),false);
  }finally{await f.close();await m.close();}
});

test('D1 HTTP reset admission prevents an old real-file publish and manager memory application',async()=>{
  const m=await managerFixture({disk:true}),f=await httpFixture(m),hold=m.hold();let old,reset;
  try{
    old=f.post({readSync:true});await within(hold.entered,'old durable checkpoint');
    reset=f.forget();await within(m.forgetEntered,'validated manager forget admission');hold.release();
    const [a,b]=await Promise.all([old,reset]);assert.equal(a.status,409);assert.equal(b.status,200);
    assert.equal(m.reader.settingsSnapshot().readSync,false);assert.equal(m.reader.settingsSnapshot().persist,false);assert.deepEqual(m.files(),[]);
  }finally{hold.release();await Promise.allSettled([old,reset]);await f.close();await m.close();}
});

test('D1 failed direct manager forget still invalidates an older pending persistent setting',async()=>{
  const m=await managerFixture({disk:true,failForget:true}),before=m.diskState(),hold=m.hold();let old;
  try{
    old=m.reader.updateSettings({readSync:true});await within(hold.entered,'direct manager publication');
    assert.equal(await m.reader.forgetSettings(),false);hold.release();assert.equal(await old,false);
    assert.equal(m.reader.settingsSnapshot().readSync,false);assert.deepEqual(m.diskState(),before);
  }finally{hold.release();await Promise.allSettled([old]);await m.close();}
});

test('D1 direct preference-store forget fences an already running write before file publication',async()=>{
  const m=await managerFixture({disk:true}),hold=m.hold();let old,reset;
  try{
    old=m.profile.set({readSync:true});await within(hold.entered,'direct store publication');reset=m.profile.forget();hold.release();
    assert.equal(await old,false);assert.equal(await reset,true);assert.equal(m.profile.snapshot().readSync,false);assert.deepEqual(m.files(),[]);
  }finally{hold.release();await Promise.allSettled([old,reset]);await m.close();}
});

test('D1 a new explicit setting admitted during reset survives reset completion and persists',async()=>{
  const m=await managerFixture({disk:true}),f=await httpFixture(m),hold=m.hold(path=>path.endsWith('.json'));let reset,current;
  try{
    reset=f.forget();await within(hold.entered,'held reset deletion');current=f.post({persist:true,readSync:true});await until(()=>m.settingCalls.length===1,'new settings entered store while reset is held');hold.release();
    assert.equal((await reset).status,200);assert.equal((await current).status,200);
    assert.equal(m.reader.settingsSnapshot().readSync,true);assert.equal(m.reader.settingsSnapshot().persist,true);
    assert.equal(m.diskState().settings.readSync,true);assert.equal(m.files().length,1);
  }finally{hold.release();await Promise.allSettled([reset,current]);await f.close();await m.close();}
});

test('D1 invalid reset body and rejected CSRF do not supersede a valid earlier partial setting',async()=>{
  const m=await managerFixture(),f=await httpFixture(m);
  try{
    const old=f.partial({readSync:true});await within(old.entered,'valid setting before invalid reset');
    assert.equal((await f.forget({unknown:true})).status,400);assert.equal((await f.forget({}, {'X-CSRF-Token':'0'.repeat(64)})).status,403);
    old.finish();assert.equal((await old.result).status,200);assert.equal(m.reader.settingsSnapshot().readSync,true);
  }finally{await f.close();await m.close();}
});

test('D1 failed HTTP reset still rejects an earlier incomplete setting body',async()=>{
  const m=await managerFixture({failForget:true}),f=await httpFixture(m);
  try{
    const old=f.partial({readSync:true});await within(old.entered,'partial before failed reset');assert.equal((await f.forget()).status,409);
    old.finish();assert.equal((await old.result).status,409);assert.equal(m.reader.settingsSnapshot().readSync,false);
  }finally{await f.close();await m.close();}
});

test('D1 manager external current predicate reaches the real publication boundary',async()=>{
  const m=await managerFixture({disk:true}),before=m.diskState(),hold=m.hold();let current=true,old;
  try{
    old=m.reader.updateSettings({notifications:true},{isCurrent:()=>current});await within(hold.entered,'external settings predicate');current=false;hold.release();
    assert.equal(await old,false);assert.equal(m.reader.settingsSnapshot().notifications,false);assert.deepEqual(m.diskState(),before);
  }finally{hold.release();await Promise.allSettled([old]);await m.close();}
});

test('D1 reconnect attempt rejects a partial old setting even when its optional instance header is absent',async()=>{
  const m=await managerFixture(),f=await httpFixture(m);
  try{
    const old=f.partial({readSync:true},{instance:false});await within(old.entered,'old attempt partial');m.reader.disconnect();m.connect();old.finish();
    assert.equal((await old.result).status,409);assert.equal(m.reader.settingsSnapshot().readSync,false);
    assert.equal((await f.post({notifications:true})).status,200);assert.equal(m.reader.settingsSnapshot().notifications,true);
  }finally{await f.close();await m.close();}
});

test('D1 reader replacement rejects a pre-body setting and cannot alter the replacement account profile',async()=>{
  const m=await managerFixture(),next=await managerFixture(),f=await httpFixture(m);
  try{
    const old=f.partial({readSync:true},{instance:false});await within(old.entered,'old reader partial');await f.replace(next);old.finish();
    assert.equal((await old.result).status,409);assert.equal(next.reader.settingsSnapshot().readSync,false);
  }finally{await f.close();await m.close();await next.close();}
});

function titleFixture({selectedReply,toLong=String}={}){
  const rows=Array.from({length:10},(_,n)=>({c:String(n+1),t:'MultiChat',title:'',ll:null,lastLog:null,updatedAt:1800000000+n}));
  const salt=Buffer.alloc(32,9),seed=createReaderStore({chatDatas:rows},'999',salt),keys=new Map(seed.rooms().map(row=>[seed.serverRoomId(row.key),row.key]));seed.clear();
  const calls=[],events=[];let closed=false;
  const carriage=Object.assign(new EventEmitter(),{async connect(){},disconnect(){closed=true;},stopPing(){},async loginList(){return {status:0,body:{chatDatas:rows}};},async request(method,body){
    calls.push({method,body});if(method==='CHATINFO'){
      const custom=String(body.chatId)==='1'?selectedReply?.():undefined;if(custom!==undefined)return custom;
      return {status:0,body:{chatInfo:{c:String(body.chatId),t:'MultiChat',title:'Synthetic recovered '+body.chatId}}};
    }return {status:0,body:{}};
  }});
  const bootstrap=()=>Object.assign(new EventEmitter(),{async connect(){},disconnect(){},async request(){return {status:0,body:{ticket:{lsl:['synthetic.kakao.com']},wifi:{ports:[443]}}};},async checkin(){return {status:0,host:'synthetic.kakao.com',port:443};}});
  const session=createReaderSession(credential,{messaging:true,booking:bootstrap,ticket:bootstrap,carriage:()=>carriage,toLong,resolve:async host=>host,every:()=>0,delay:async()=>{},sessionSalt:salt,now:()=>0},event=>events.push(event));
  const key=id=>keys.get(id),count=id=>calls.filter(row=>row.method==='CHATINFO' && String(row.body.chatId)===id).length;
  return {session,calls,events,key,count,title:id=>events.findLast(event=>event.type==='reader-rooms')?.rooms.find(row=>row.key===key(id))?.title,
    async start(){assert.equal((await session.start()).ok,true);await until(()=>['3','4','5','6','7','8','9','10'].every(id=>events.findLast(event=>event.type==='reader-rooms')?.rooms.some(row=>row.key===key(id)&&row.title==='Synthetic recovered '+id)),'eight bootstrap titles');assert.equal(calls.filter(row=>row.method==='CHATINFO').length,8);},
    close(){session.close();assert.equal(closed,true);assert.equal(calls.some(row=>['WRITE','NOTIREAD','SHIP','POST','JOINLINK'].includes(row.method)),false);},
  };
}

test('D2 a title reservation canceled before send can be used by a later explicit reselection',async()=>{
  const f=titleFixture();
  try{
    await f.start();assert.equal(f.session.view(f.key('1')),true);assert.equal(f.session.view(f.key('2')),true);
    await until(()=>f.count('2')===1,'replacement selected title');await sleep(160);assert.equal(f.count('1'),0);
    assert.equal(f.session.view(f.key('1')),true);await until(()=>f.count('1')===1,'explicit title retry after unsent reservation');
    await until(()=>f.title('1')==='Synthetic recovered 1','recovered title');for(let i=0;i<3;i++)f.session.view(f.key('1'));await sleep(160);assert.equal(f.count('1'),1);
  }finally{f.close();}
});

test('D2 refusal after a real CHATINFO attempt is not automatically or explicitly retried',async()=>{
  const f=titleFixture({selectedReply:()=>({status:-203,body:{status:-203}})});
  try{
    await f.start();const generic=f.title('1');f.session.view(f.key('1'));await until(()=>f.count('1')===1,'refused title attempt');await sleep(160);
    for(let i=0;i<3;i++){f.session.view(f.key('2'));f.session.view(f.key('1'));}await sleep(160);assert.equal(f.count('1'),1);assert.equal(f.title('1'),generic);
  }finally{f.close();}
});

test('D2 a late title reply for an obsolete selected scope does not cause another wire attempt',async()=>{
  const held=gate(),f=titleFixture({selectedReply:()=>held.promise});
  try{
    await f.start();const generic=f.title('1');f.session.view(f.key('1'));await until(()=>f.count('1')===1,'held real title attempt');
    f.session.view(f.key('2'));held.release({status:0,body:{chatInfo:{c:'1',t:'MultiChat',title:'Obsolete synthetic title'}}});
    await until(()=>f.count('2')===1,'next selected title after late reply');f.session.view(f.key('1'));await sleep(160);
    assert.equal(f.count('1'),1);assert.equal(f.title('1'),generic);
  }finally{held.release({status:0,body:{}});f.close();}
});

test('D2 selected optional wait expiry consumes its sent attempt without automatic resend',async()=>{
  const held=gate(),f=titleFixture({selectedReply:()=>held.promise});
  try{
    await f.start();const generic=f.title('1');f.session.view(f.key('1'));await until(()=>f.count('1')===1,'expiring selected title');f.session.view(f.key('2'));
    await until(()=>f.count('2')===1,'optional title deadline releases scheduler');f.session.view(f.key('1'));await sleep(160);assert.equal(f.count('1'),1);
    held.release({status:0,body:{chatInfo:{c:'1',t:'MultiChat',title:'Late after expiry'}}});await sleep(160);assert.equal(f.title('1'),generic);assert.equal(f.count('1'),1);
  }finally{held.release({status:0,body:{}});f.close();}
});

test('D2 conversion failure before CHATINFO invocation does not consume a wire attempt',async()=>{
  let conversionFails=true,conversionCalls=0,conversionThrows=0;const f=titleFixture({toLong:value=>{
    if(String(value)==='1'){conversionCalls++;if(conversionFails){conversionThrows++;throw Error('synthetic conversion before wire');}}return String(value);
  }});
  try{
    await f.start();f.session.view(f.key('1'));await until(()=>conversionThrows===1,'actual conversion throw before wire');assert.equal(conversionCalls,1);assert.equal(f.count('1'),0);conversionFails=false;
    f.session.view(f.key('1'));await until(()=>f.count('1')===1,'explicit retry after unsent conversion failure');await until(()=>f.title('1')==='Synthetic recovered 1','conversion retry title');
    assert.equal(conversionCalls,2);assert.equal(conversionThrows,1);
  }finally{f.close();}
});
