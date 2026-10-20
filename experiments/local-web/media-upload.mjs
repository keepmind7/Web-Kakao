import { createHash } from 'node:crypto';
import { resolvePublicDestination } from './room-probe.mjs';
import { responseStatus } from './reader-response.mjs';
import { inspectImage } from './message-content.mjs';
import { serverId } from './reader-data.mjs';

// Match modern 8dbbd4f7ed6b42542982252250622fa351af00e9's
// src/kakao/media-upload.ts streamEncryptedFile highWaterMark: 64 * 1024.
// This is the reference's outbound policy, not a confirmed live-server limit.
export const MAX_UPLOAD_CHUNK_BYTES=64*1024;

const metadataValue=(value,key)=>{try{return value?.[key];}catch{return undefined;}};
const duration=started=>Math.max(0,Math.min(2147483647,Date.now()-started));
const counter=value=>Number.isSafeInteger(value) && value>=0?value:null;
function socketSnapshot(client,baseline){
  const socket=metadataValue(client,'socket');
  if(!socket || typeof socket!=='object')return {available:false};
  const snapshot={available:true};
  for(const key of ['destroyed','writable','writableEnded','writableNeedDrain']){const value=metadataValue(socket,key);if(typeof value==='boolean')snapshot[key]=value;}
  for(const key of ['writableLength','writableHighWaterMark']){const value=counter(metadataValue(socket,key));if(value!==null && value<=2147483647)snapshot[key]=value;}
  for(const [key,name] of [['bytesWritten','writtenBytesDelta'],['bytesRead','readBytesDelta']]){
    const value=counter(metadataValue(socket,key)),start=baseline[key];
    if(value!==null && start!==null && value>=start && value-start<=2147483647)snapshot[name]=value-start;
  }
  return snapshot;
}

function uploadFault(error){
  const category=['TypeError','RangeError','Error'].includes(error?.name)?error.name:'other';
  const codes=['EPIPE','ECONNRESET','ETIMEDOUT','ERR_STREAM_DESTROYED','ERR_SOCKET_CLOSED'];
  const code=codes.includes(error?.code)?error.code:error?.message==='Carriage not connected'?'not_connected':'other';
  return {category,code}; // Never record a raw error message, stack or address.
}

const signedId=serverId; // serverId enforces the positive signed int64 range.
function completeMatches(body,{chatId,userId,messageId,requireLog}){
  const log=body?.chatLog;
  if(requireLog && (!log || Array.isArray(log) || !signedId(log.logId)))return false;
  const rows=[body,log].filter(value=>value && typeof value==='object' && !Array.isArray(value));
  const values=names=>rows.flatMap(row=>names.filter(name=>Object.hasOwn(row,name)).map(name=>row[name]));
  const rooms=values(['chatId','roomId','c']);
  if(requireLog && !rooms.length || rooms.some(value=>signedId(value)!==chatId))return false;
  const authors=[...values(['authorId','senderId','userId','writerId']),...rows.filter(row=>row.sender && Object.hasOwn(row.sender,'userId')).map(row=>row.sender.userId)];
  if(authors.some(value=>signedId(value)!==userId))return false;
  if(values(['type','msgType','t']).some(value=>Number(value)!==2))return false;
  // Client mid/msgId and the server's new logId are different identifiers.
  return values(['mid','msgId']).every(value=>signedId(value)===messageId);
}

// Pinned node-kakao uploadMedia / kakao-cli uploadPhotoFromPath: COMPLETE posts
// the photo itself. Never follow this path with WRITE, nor automatically retry.
export async function uploadPhoto(options){
  let posting=false,stage='ship';
  const trace=(next,details={})=>{stage=next;try{options.observe?.({stage,...details});}catch{/* Observation cannot change an upload outcome. */}};
  try{return await performUpload({...options,trace,onPosting:()=>{posting=true;}});}catch(error){trace(stage==='deadline'?'exception':stage,{failure:'exception',...uploadFault(error)});return {phase:posting?'unknown':'failed',status:null};}
}
async function performUpload({carriage,createClient,toLong,chatId,userId,messageId,data,signal,isCurrent=()=>true,readOnSend=false,resolve=resolvePublicDestination,profile,timeout=20000,onPosting,trace}){
  if(typeof readOnSend!=='boolean')throw new TypeError('invalid_read_on_send');
  const image=inspectImage(data);if(!image)throw new Error('invalid_image');
  if(typeof messageId!=='string' || !/^[1-9]\d{0,18}$/.test(messageId) || BigInt(messageId)>9223372036854775807n)throw new Error('invalid_message_id');
  chatId=signedId(chatId);userId=signedId(userId);
  if(!chatId || !userId)throw new Error('invalid_upload_identity');
  if(!Number.isFinite(timeout) || timeout<=0 || timeout>2147473647)throw new Error('invalid_upload_timeout');
  const lifetime=new AbortController(),uploadSignal=signal?AbortSignal.any([signal,lifetime.signal]):lifetime.signal;
  const assertLive=()=>{if(uploadSignal.aborted || isCurrent()!==true)throw new Error('upload_cancelled');};
  // Retain the existing timeout+10s policy, measured once from SHIP onward.
  // DNS and metadata cannot defer the start or replenish the upload budget.
  const deadline=Date.now()+timeout+10000;
  let captureDeadline=()=>{},deadlineDetails=()=>({});
  const expire=()=>{if(uploadSignal.aborted)return;captureDeadline();trace('deadline',{failure:'timeout',...deadlineDetails()});lifetime.abort();};
  const remaining=()=>{assertLive();const ms=deadline-Date.now();if(ms<=0){expire();assertLive();}return Math.max(1,Math.min(timeout,ms));};
  const timer=setTimeout(expire,timeout+10000);timer.unref?.();
  // Every wait, including raw writes, shares cancellation independently of
  // whether the transport settles its own promises after disconnect.
  const awaitLive=async operation=>{
    assertLive();
    return await new Promise((resolve,reject)=>{
      let settled=false;
      const finish=(callback,value)=>{if(settled)return;settled=true;uploadSignal.removeEventListener('abort',onAbort);callback(value);};
      const onAbort=()=>finish(reject,new Error('upload_cancelled'));
      uploadSignal.addEventListener('abort',onAbort,{once:true});
      if(uploadSignal.aborted){onAbort();return;}
      try{
        Promise.resolve(operation()).then(value=>{try{assertLive();finish(resolve,value);}catch(error){finish(reject,error);}},error=>finish(reject,error));
      }catch(error){finish(reject,error);}
    });
  };
  try{
  assertLive();
  trace('ship',{totalBytes:data.length});
  const ship=await awaitLive(()=>carriage.request('SHIP',{c:toLong(chatId),s:toLong(String(data.length)),t:2,cs:createHash('sha1').update(data).digest('hex').toUpperCase(),e:image.ext},remaining(),{recoverable:true}));
  if(responseStatus(ship)!==0)return {phase:'failed',status:responseStatus(ship)};
  assertLive();
  const token=ship.body?.k,host=ship.body?.vh,port=Number(ship.body?.p);
  if(typeof token!=='string' || !token.length || token.length>4096)throw new Error('invalid_upload_route');
  trace('route');const address=await awaitLive(()=>resolve(host,port));assertLive();
  const client=createClient();let settle,settled=false,posting=false,finalized=false,disconnected=false,sent=null,frames=0,streamRecorded=false,completeObserved=false;
  let write=null,writeStarted=0,writeFrozen=false,baseline=null;
  const captureTerminal=()=>{if(write && !writeFrozen){writeFrozen=true;write.elapsedMs=duration(writeStarted);write.terminal=socketSnapshot(client,baseline);}};
  const writeDetails=()=>write?{write}:{};
  captureDeadline=captureTerminal;deadlineDetails=writeDetails;
  const writeChunk=async chunk=>{
    if(!baseline){const socket=metadataValue(client,'socket');baseline={bytesWritten:counter(metadataValue(socket,'bytesWritten')),bytesRead:counter(metadataValue(socket,'bytesRead'))};}
    writeStarted=Date.now();writeFrozen=false;
    const current=write={index:frames+1,inputBytes:chunk.length,phase:'calling',elapsedMs:0,before:socketSnapshot(client,baseline)};
    try{
      await awaitLive(()=>{
        const called=Date.now();let waiting;
        try{waiting=client.writeEncrypted(chunk);}catch(error){if(!writeFrozen){current.phase='threw';current.callMs=duration(called);captureTerminal();}throw error;}
        if(!writeFrozen){current.phase='waiting';current.callMs=duration(called);current.returned=socketSnapshot(client,baseline);}
        return waiting;
      });
      if(!writeFrozen){current.phase='fulfilled';current.elapsedMs=duration(writeStarted);}
    }catch(error){if(!writeFrozen){current.phase='rejected';captureTerminal();}throw error;}
  };
  const disconnect=()=>{if(disconnected)return;disconnected=true;try{client.disconnect();}catch{/* Cancellation already releases our waits. */}};
  const recordStream=()=>{if(sent!==null && !streamRecorded){streamRecorded=true;captureTerminal();trace('stream',{sentBytes:sent,totalBytes:data.length,frames,...writeDetails()});}};
  const complete=new Promise(resolve=>{settle=resolve;});
  const finish=value=>{if(!settled){settled=true;settle(value);}};
  const onPush=packet=>{
    if(!finalized && !uploadSignal.aborted && posting && packet?.method==='COMPLETE'){
      if(!completeObserved){completeObserved=true;let status=null;try{const value=responseStatus(packet);if(Number.isInteger(value) && value>=-2147483648 && value<=2147483647)status=value;}catch{/* Missing observation status is not an outcome. */}trace('complete_observed',{status,beforeStreamEnd:sent===null || sent<data.length});}
      finish({packet});
    }
  };
  const onError=error=>{if(finalized || uploadSignal.aborted)return;captureTerminal();trace('transport',{failure:'closed_or_error',...uploadFault(error),...writeDetails()});lifetime.abort();};
  const onAbort=()=>{captureTerminal();finish({error:true});disconnect();};
  client.on('push',onPush);client.on('error',onError);client.on('disconnected',onError);uploadSignal.addEventListener('abort',onAbort,{once:true});
  try{
    trace('connect');
    await awaitLive(()=>client.connect(address,port,remaining()));assertLive();
    // POST may already create a message; everything uncertain after this point
    // is reported as unknown. The caller retains its request UUID.
    trace('post');
    // APK25.11.2 distinguishes int64 size, explicit BSON null and plain-photo
    // metadata. Scope/silence are the options this UI actually offers. dt follows
    // the declared companion role, not a guess based on screen size/model.
    const post=await awaitLive(()=>{
      const postTimeout=remaining();
      posting=true;onPosting();
      return client.request('POST',{k:token,s:toLong(String(data.length)),f:'photo.'+image.ext,t:2,c:toLong(chatId),mid:toLong(messageId),ns:!readOnSend,u:toLong(userId),os:profile.os,av:profile.appVersion,nt:0,mm:'45005',ex:'{}',sp:null,scp:1,silence:false,...(typeof profile.subDeviceMode==='boolean'?{dt:profile.subDeviceMode?4:1}:{}),w:image.width,h:image.height},postTimeout);
    });
    if(responseStatus(post)!==0)return {phase:responseStatus(post)===null?'unknown':'failed',status:responseStatus(post)};
    const offset=Number(post.body?.o);
    trace('offset',{offset:Number.isSafeInteger(offset)?offset:null,totalBytes:data.length});
    if(!Number.isSafeInteger(offset) || offset<0 || offset>data.length){trace('offset',{failure:'invalid_offset'});return {phase:'unknown',status:null};}
    sent=offset;
    trace('stream');
    // Each writeEncrypted call makes a complete GCM frame. Preserve the file
    // byte sequence while bounding each frame, including nonce and tag.
    // One collapsed stream event keeps earlier stage timings in the rolling log.
    while(sent<data.length){assertLive();const end=Math.min(sent+MAX_UPLOAD_CHUNK_BYTES,data.length);await writeChunk(data.subarray(sent,end));sent=end;frames++;}
    recordStream();
    trace('await_complete',{sentBytes:sent,totalBytes:data.length});
    const result=await awaitLive(()=>complete);assertLive();
    if(result.error)return {phase:'unknown',status:null};
    const status=responseStatus(result.packet);
    trace('received_complete',{status});
    if(!completeMatches(result.packet.body,{chatId,userId,messageId,requireLog:status===0}))return {phase:'unknown',status:null};
    // Preserve verified outer identity as evidence for the session/store boundary.
    return {phase:status===0?'accepted':status===null?'unknown':'failed',status,chatLog:status===0?result.packet.body?.chatLog:null,...(status===0?{completeBody:result.packet.body}:{})};
  }catch(error){captureTerminal();trace('exception',{...uploadFault(error),...writeDetails()});return {phase:posting?'unknown':'failed',status:null};}
  finally{captureTerminal();finalized=true;uploadSignal.removeEventListener('abort',onAbort);client.off('push',onPush);client.off('disconnected',onError);lifetime.abort();recordStream();disconnect();/* Keep the inert error listener for late socket errors. */}
  }finally{clearTimeout(timer);lifetime.abort();}
}
