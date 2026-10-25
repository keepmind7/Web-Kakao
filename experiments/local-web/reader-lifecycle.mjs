import {constants,openSync,closeSync,writeFileSync,fsyncSync,renameSync,rmSync,promises as fs} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {privateDataRoot,ensurePrivateDirectory,verifyPrivateFile,ensurePrivateDirectoryAsync,verifyPrivateFileAsync} from './private-storage.mjs';

const MAX_BYTES=1024*1024,MAX_ATTEMPTS=8,MAX_EVENTS=16;
const FILES=new Set(['reader-lifecycle.json','reader-diagnostic.json','reader-send-diagnostic.json']);
const EVENTS=new Set(['start','spawn','ready','connected','failure','termination','exit','worker-error']);
const REASONS=new Set(['failure','manual','cancelled','closed','parent-disconnected','fatal','unhandled-rejection','operation-deadline','startup-fault','session-failed','send-timeout']);
const STAGES=new Set(['booking','getconf','checkin','loginlist','history','ping','push','transport','decode','disconnected','worker','send','photo','context','read','discovery','settings','deadline','ipc']);
const SIGNALS=new Set(['SIGABRT','SIGTERM','SIGKILL','SIGINT','SIGHUP','SIGSEGV','SIGILL','SIGBUS','SIGTRAP','SIGPIPE','SIGQUIT']);
const METHODS=new Set(['GETCONF','CHECKIN','LOGINLIST','SYNCMSG','MCHATLOGS','PING','MSG','KICKOUT','CHANGESVR','BLSYNC','CHATINFO','WRITE','CHATONROOM','NOTIREAD','DECUNREAD','SHIP','POST','COMPLETE','SYNCLINK','INFOLINK','MEMBER','startup']);
const NOTES=new Set(['request','response','push','failed','history-page','read-verification','photo-upload','send-stage']);
const FAULTS=new Set(['Error','TypeError','RangeError','SyntaxError','BSONError','BSONRuntimeError']);
const FRAMES=new Set(['onData','decrypt','fromBuffer','deserialize','syncMsg','history','request','photoAttachments','merge','onPush']);
const CODES=new Set(['ENOENT','EACCES','EPERM','EPIPE','ECONNRESET','ETIMEDOUT','ERR_IPC_CHANNEL_CLOSED','ERR_CHILD_PROCESS_IPC_REQUIRED']);
// Read data properties only. IPC payloads and injected objects may contain
// accessors/toJSON hooks; none are called or passed into JSON.stringify.
const value=(object,key)=>{try{const descriptor=Object.getOwnPropertyDescriptor(object??{},key);return descriptor&&Object.hasOwn(descriptor,'value')?descriptor.value:undefined;}catch{return undefined;}};
const number=(item,min=0,max=2147483647)=>Number.isSafeInteger(item)&&item>=min&&item<=max?item:null;
const member=(set,item)=>typeof item==='string'&&set.has(item)?item:'other';
function tail(array,count){try{if(!Array.isArray(array))return [];}catch{return [];}const length=number(value(array,'length'),0,1000000);if(length===null)return [];const result=[];for(let i=Math.max(0,length-count);i<length;i++)result.push(value(array,String(i)));return result;}
const timestamp=item=>number(item,0,4102444800000);
const idValid=id=>typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
function fault(input){if(!input||typeof input!=='object')return undefined;return {category:member(FAULTS,value(input,'category')),frames:tail(value(input,'frames'),8).filter(frame=>typeof frame==='string'&&FRAMES.has(frame))};}
function note(input){
  const event=value(input,'event');if(!NOTES.has(event))return null;
  const row={event};for(const key of ['elapsedMs','page','receivedCount','acceptedCount','rejectedCount']){const item=number(value(input,key));if(item!==null)row[key]=item;}
  for(const key of ['status','bodyStatus']){const item=number(value(input,key),-2147483648);if(item!==null)row[key]=item;}
  const method=value(input,'method');if(typeof method==='string')row.method=member(METHODS,method);
  const stage=value(input,'stage');if(typeof stage==='string')row.stage=member(STAGES,stage);
  for(const key of ['isOK','hasMore','cursorAdvanced','reachedBound','fieldPresent']){const item=value(input,key);if(typeof item==='boolean')row[key]=item;}
  return row;
}
export function safeReaderDiagnostic(input){
  const result={rawValuesRecorded:false,events:tail(value(input,'events'),12).map(note).filter(Boolean)};
  const startedAt=timestamp(value(input,'startedAt'));if(startedAt!==null)result.startedAt=startedAt;
  const method=value(input,'lastOperation');if(typeof method==='string')result.lastOperation=member(METHODS,method);
  const reason=value(input,'exitReason');if(typeof reason==='string')result.exitReason=member(REASONS,reason);
  const error=fault(value(input,'fault'));if(error)result.fault=error;
  const counts=value(input,'readSync');if(counts){result.readSync={};for(const key of ['requests','responses','accepted','rejected','unknown'])result.readSync[key]=number(value(counts,key))??0;}
  return result;
}

export function atomicReaderFile(name,data,{folder=join(privateDataRoot(),'web-auth')}={}){
  if(!FILES.has(name)||typeof data!=='string'||Buffer.byteLength(data)>MAX_BYTES)throw new Error('reader_diagnostic_size');
  ensurePrivateDirectory(folder);const path=join(folder,name);verifyPrivateFile(path,{maxBytes:MAX_BYTES});
  const temp=join(folder,`${name}.${randomUUID()}.tmp`);let fd;
  try{
    fd=openSync(temp,'wx',0o600);writeFileSync(fd,data);fsyncSync(fd);closeSync(fd);fd=undefined;
    verifyPrivateFile(temp,{maxBytes:MAX_BYTES});renameSync(temp,path);
  }finally{if(fd!==undefined)closeSync(fd);rmSync(temp,{force:true});}
}
async function atomicReaderFileAsync(name,data,{folder}){
  if(!FILES.has(name)||typeof data!=='string'||Buffer.byteLength(data)>MAX_BYTES)throw new Error('reader_diagnostic_size');
  await ensurePrivateDirectoryAsync(folder);const path=join(folder,name);await verifyPrivateFileAsync(path,{maxBytes:MAX_BYTES});
  const temp=join(folder,`${name}.${randomUUID()}.tmp`);let handle;
  try{
    handle=await fs.open(temp,'wx',0o600);await handle.writeFile(data);await handle.sync();await handle.close();handle=null;
    await verifyPrivateFileAsync(temp,{maxBytes:MAX_BYTES});await verifyPrivateFileAsync(path,{maxBytes:MAX_BYTES});await fs.rename(temp,path);
  }finally{try{if(handle)await handle.close();}finally{await fs.rm(temp,{force:true});}}
}
async function readPrivate(folder){
  await ensurePrivateDirectoryAsync(folder);const path=join(folder,'reader-lifecycle.json');if(!await verifyPrivateFileAsync(path,{maxBytes:MAX_BYTES}))return null;
  const handle=await fs.open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
  try{const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>MAX_BYTES)throw new Error('reader_diagnostic_size');
    const buffer=Buffer.alloc(MAX_BYTES+1);let count=0;while(count<buffer.length){const {bytesRead}=await handle.read(buffer,count,buffer.length-count,null);if(!bytesRead)break;count+=bytesRead;}if(count>MAX_BYTES)throw new Error('reader_diagnostic_size');
    await verifyPrivateFileAsync(path,{maxBytes:MAX_BYTES});const current=await fs.lstat(path);if(['dev','ino','size','mtimeMs','ctimeMs'].some(key=>stat[key]!==current[key]))throw new Error('reader_diagnostic_changed');
    return buffer.subarray(0,count).toString('utf8');
  }finally{await handle.close();}
}
function lifecycleEvent(event,details,at){
  const result={event,at};
  if(event==='failure'){result.stage=member(STAGES,value(details,'stage'));result.status=number(value(details,'status'),-2147483648);}
  if(event==='termination')result.reason=member(REASONS,value(details,'reason'));
  if(event==='exit'){result.code=number(value(details,'code'),0,4294967295);const signal=value(details,'signal');result.signal=signal===null||signal===undefined?null:member(SIGNALS,signal);}
  if(event==='worker-error')result.code=member(CODES,value(details,'code'));
  return result;
}
export function createReaderLifecycle({writeSnapshot=null,readSnapshot=null,folder=null,now=Date.now}={}){
  const state={version:1,rawValuesRecorded:false,attempts:[]};let loaded=false,ready=false,blocked=false,dirty=false,loading=null,running=null,busy=false,pending=null;
  const at=()=>{try{return timestamp(now())??0;}catch{return 0;}};
  const storageFolder=()=>folder??join(privateDataRoot(),'web-auth');
  const restore=raw=>{
      if(raw===null||raw===undefined)return;
      if(typeof raw!=='string'||Buffer.byteLength(raw)>MAX_BYTES)throw new Error('reader_diagnostic_size');
      const source=JSON.parse(raw);if(value(source,'version')!==1||!Array.isArray(value(source,'attempts')))throw new Error('reader_diagnostic_format');
      const restored=[];
      for(const input of tail(value(source,'attempts'),MAX_ATTEMPTS)){
        const id=value(input,'id'),startedAt=timestamp(value(input,'startedAt'));if(!idValid(id)||startedAt===null)continue;
        const attempt={id,startedAt,events:[]};
        for(const row of tail(value(input,'events'),MAX_EVENTS)){const event=value(row,'event'),time=timestamp(value(row,'at'));if(!EVENTS.has(event)||time===null)continue;const safe=lifecycleEvent(event,row,time);attempt.events.push(safe);apply(attempt,safe);}
        const failure=value(input,'failure');if(failure)apply(attempt,lifecycleEvent('failure',failure,startedAt));
        const reason=value(input,'terminationReason');if(typeof reason==='string')attempt.terminationReason=member(REASONS,reason);
        const exit=value(input,'exit');if(exit)apply(attempt,lifecycleEvent('exit',exit,timestamp(value(input,'endedAt'))??startedAt));
        const diagnostic=value(input,'diagnostic');if(diagnostic)attempt.diagnostic=safeReaderDiagnostic(diagnostic);restored.push(attempt);
      }
      // Attempts created during the read are newer than the previous process's
      // history, even when the wall clock moved backwards between processes.
      const current=new Set(state.attempts.map(attempt=>attempt.id));state.attempts=[...restored.filter(attempt=>!current.has(attempt.id)),...state.attempts].slice(-MAX_ATTEMPTS);
  };
  const readFailed=()=>{blocked=true;dirty=false;pending=null;state.storageError=true;};
  const initialize=()=>{
    if(loaded)return;loaded=true;
    try{
      const raw=readSnapshot?readSnapshot():writeSnapshot?null:readPrivate(storageFolder());
      if(raw&&typeof raw.then==='function'){
        loading=Promise.resolve(raw).then(restore).catch(readFailed).then(()=>{ready=true;loading=null;if(dirty)persist();});
      }else{restore(raw);ready=true;}
    }catch{readFailed();ready=true;}
  };
  function writeFailed(){state.storageError=true;if(pending!==null)persist();}
  function drain(){
    if(busy||blocked||pending===null)return;
    const data=pending;pending=null;busy=true;
    try{
      const result=writeSnapshot?writeSnapshot(data):atomicReaderFileAsync('reader-lifecycle.json',data,{folder:storageFolder()});
      if(result&&typeof result.then==='function'){
        running=Promise.resolve(result).catch(writeFailed).then(()=>{busy=false;running=null;drain();});return;
      }
    }catch{writeFailed();}
    busy=false;drain();
  }
  function persist(){
    if(blocked)return;dirty=true;if(!ready)return;
    try{const data=JSON.stringify(state)+'\n';if(Buffer.byteLength(data)>MAX_BYTES)throw new Error('reader_diagnostic_size');pending=data;dirty=false;drain();}catch{dirty=false;state.storageError=true;}
  }
  function apply(attempt,row){if(row.event==='failure')attempt.failure={stage:row.stage,status:row.status};if(row.event==='termination')attempt.terminationReason=row.reason;if(row.event==='exit'){attempt.exit={code:row.code,signal:row.signal};attempt.endedAt=row.at;}}
  return {
    start(){initialize();const id=randomUUID(),startedAt=at();state.attempts.push({id,startedAt,events:[{event:'start',at:startedAt}]});state.attempts=state.attempts.slice(-MAX_ATTEMPTS);persist();return id;},
    record(id,event,details={}){initialize();const attempt=state.attempts.find(row=>row.id===id);if(!attempt||!EVENTS.has(event)||event==='exit'&&attempt.exit)return;const row=lifecycleEvent(event,details,at());attempt.events.push(row);attempt.events=attempt.events.slice(-MAX_EVENTS);apply(attempt,row);persist();},
    diagnostic(id,input){initialize();const attempt=state.attempts.find(row=>row.id===id);if(!attempt)return;attempt.diagnostic=safeReaderDiagnostic(input);persist();},
    snapshot(){initialize();return JSON.parse(JSON.stringify(state));},
    async flush(){initialize();for(;;){if(loading){await loading;continue;}if(running){await running;continue;}if(pending!==null){drain();continue;}return;}},
  };
}
