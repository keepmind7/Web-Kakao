// Deliberate legacy-derived experiment. Current endpoint/PHOTO compatibility is
// unverified. An uploaded asset or WRITE ACK is not recipient delivery.
import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {createHash,randomBytes} from 'node:crypto';
import {inspectImage,attachmentObject,IMAGE_LIMIT} from './message-content.mjs';
import {serverId} from './reader-data.mjs';
import {responseStatus} from './reader-response.mjs';
import {safeDestination} from './room-probe.mjs';

const TARGET=new URL('https://up-m.talk.kakao.com/upload');
const RESPONSE_LIMIT=4096;
const safeCode=error=>{try{return ['EPIPE','ECONNRESET','ETIMEDOUT','ERR_STREAM_DESTROYED','ERR_SOCKET_CLOSED'].includes(error?.code)?error.code:'other';}catch{return 'other';}};
function validPath(value){
  // A conservative experimental policy, not the service's established grammar.
  return typeof value==='string' && value.length<=2048 && /^\/?[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
    && !value.split('/').some(part=>part==='.' || part==='..') && !value.includes('//');
}
function matchingAck(body,{chatId,userId,messageId,asset,requireLog}){
  if(!body || typeof body!=='object' || Array.isArray(body))return false;
  const rows=[body,body.chatLog,body.log].filter(row=>row && typeof row==='object' && !Array.isArray(row));
  const values=keys=>rows.flatMap(row=>keys.filter(key=>Object.hasOwn(row,key)).map(key=>row[key]));
  const logIds=values(['logId']);if(requireLog && !logIds.length || logIds.some(id=>!serverId(id)) || new Set(logIds.map(serverId)).size>1)return false;
  const rooms=values(['chatId','roomId','chatRoomId','c']);
  // Preserve the store's photo rule: a response needs actual room evidence.
  if(requireLog && !rooms.length || rooms.some(id=>serverId(id)!==chatId))return false;
  const authors=[...values(['authorId','senderId','userId','writerId']),...rows.filter(row=>row.sender && Object.hasOwn(row.sender,'userId')).map(row=>row.sender.userId)];
  if(authors.some(id=>serverId(id)!==userId) || values(['msgId','mid']).some(id=>serverId(id)!==messageId) || values(['type','msgType','t']).some(type=>type!==2))return false;
  for(const row of rows)for(const key of ['attachment','extra'])if(Object.hasOwn(row,key)){
    const attachment=attachmentObject(row[key]);if(!attachment)return false;
    for(const field of ['path','s','w','h','cs','mt'])if(Object.hasOwn(attachment,field) && attachment[field]!==asset[field])return false;
  }
  return true;
}

export async function uploadPhotoHttps({carriage,toLong,chatId,userId,messageId,data,signal,isCurrent=()=>true,readOnSend=false,observe,timeout=20000,resolve=lookup,request=https.request}={}){
  const trace=(stage,details={})=>{try{observe?.({stage,...details});}catch{/* An observer cannot change send behavior. */}};
  const failed=(reason)=>({phase:'failed',status:null,...(reason?{reason}:{})});
  if(!Buffer.isBuffer(data) || data.length>IMAGE_LIMIT)return failed();
  const bytes=Buffer.from(data),image=inspectImage(bytes);
  if(!image)return failed();
  trace('https_start',{totalBytes:bytes.length});
  if(image.mime!=='image/jpeg')return failed('photo_jpeg_required');
  chatId=serverId(chatId);userId=serverId(userId);messageId=serverId(messageId);
  if(!chatId || !userId || !messageId || typeof toLong!=='function' || typeof carriage?.request!=='function' || typeof readOnSend!=='boolean'
    || !Number.isFinite(timeout) || timeout<=0 || timeout>22500 || typeof resolve!=='function' || typeof request!=='function')return failed();
  const controller=new AbortController(),uploadSignal=controller.signal,deadline=Date.now()+timeout;
  let attempted=false,finalized=false,req=null,res=null,timer=null;
  const externalAbort=()=>controller.abort();
  const live=()=>{let current=false;try{current=isCurrent()===true;}catch{}if(uploadSignal.aborted || !current)throw new Error('photo_cancelled');};
  const remaining=()=>{live();const ms=deadline-Date.now();if(ms<=0)throw new Error('photo_deadline');return Math.max(1,ms);};
  const wait=operation=>new Promise((accept,reject)=>{
    let done=false;
    const finish=(callback,value)=>{if(done)return;done=true;uploadSignal.removeEventListener('abort',abort);callback(value);};
    const abort=()=>finish(reject,new Error('photo_cancelled'));
    uploadSignal.addEventListener('abort',abort,{once:true});
    try{live();Promise.resolve(operation()).then(value=>{try{live();finish(accept,value);}catch(error){finish(reject,error);}},error=>finish(reject,error));}
    catch(error){finish(reject,error);}
  });
  const destroy=()=>{try{res?.destroy();}catch{}try{req?.destroy();}catch{}};
  uploadSignal.addEventListener('abort',destroy);
  signal?.addEventListener('abort',externalAbort,{once:true});
  if(signal?.aborted)externalAbort();
  timer=setTimeout(()=>{trace('https_deadline',{failure:'timeout'});controller.abort();},timeout);
  try{
    live();
    trace('https_route');
    const addresses=await wait(()=>resolve(TARGET.hostname,{all:true,verbatim:true}));
    if(!Array.isArray(addresses) || !addresses.length || addresses.some(row=>!row || !isIP(row.address) || !safeDestination(row.address,443)
      || row.family!==isIP(row.address)))throw new Error('unsafe_upload_address');
    const address={address:addresses[0].address,family:addresses[0].family};
    const boundary='web-kakao-'+randomBytes(18).toString('hex');
    const field=(name,value)=>Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
    const body=Buffer.concat([field('user_id','0'),field('attachment_type','image/jpeg'),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
    trace('https_upload',{totalBytes:bytes.length});
    const path=await wait(()=>new Promise((accept,reject)=>{
      let settled=false;
      const finish=(error,value)=>{if(settled)return;settled=true;error?reject(error):accept(value);};
      const fail=()=>finish(new Error('upload_response_invalid'));
      const options={method:'POST',agent:false,autoSelectFamily:false,family:address.family,servername:TARGET.hostname,rejectUnauthorized:true,signal:uploadSignal,
        lookup:(host,_options,callback)=>host===TARGET.hostname?callback(null,address.address,address.family):callback(new Error('invalid_upload_host')),
        headers:{Accept:'text/plain','User-Agent':'Web-Kakao/https-photo-experiment','Content-Type':`multipart/form-data; boundary=${boundary}`,'Content-Length':body.length}};
      try{
        req=request(new URL(TARGET.href),options,response=>{
          res=response;
          response.on('error',fail);response.once('aborted',fail);
          if(finalized || uploadSignal.aborted){fail();response.destroy();return;}
          if(response.statusCode!==200 || !/^text\/plain(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(response.headers?.['content-type'] ?? '')
            || !['', 'identity'].includes(response.headers?.['content-encoding'] ?? '')){fail();response.destroy();return;}
          const length=response.headers?.['content-length'];
          if(length!==undefined && (!/^\d+$/.test(String(length)) || Number(length)>RESPONSE_LIMIT)){fail();response.destroy();return;}
          let size=0;const chunks=[];
          response.on('data',chunk=>{if(settled)return;const part=Buffer.from(chunk);size+=part.length;if(size>RESPONSE_LIMIT){fail();response.destroy();return;}chunks.push(part);});
          response.once('end',()=>{if(settled)return;try{if(length!==undefined && size!==Number(length)){fail();return;}const path=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks));if(!validPath(path)){fail();return;}finish(null,path);}catch{fail();}});
          response.once('close',()=>{if(!settled)fail();});
        });
        req.on('error',error=>finish(error));req.end(body);
      }catch(error){finish(error);}
    }));
    trace('https_uploaded',{totalBytes:bytes.length});live();
    const asset=Object.freeze({path,s:bytes.length,w:image.width,h:image.height,cs:createHash('sha1').update(bytes).digest('hex'),mt:'image/jpeg'});
    // Construct exact request-local values before the uncertainty boundary.
    const write={chatId:toLong(chatId),msgId:toLong(messageId),type:2,msg:'[사진]',noSeen:!readOnSend,scope:1,silence:false,extra:JSON.stringify(asset)};
    const bound=remaining();trace('https_write');
    const ack=await wait(()=>{live();attempted=true;return carriage.request('WRITE',write,bound,{signal:uploadSignal});});
    live();const status=responseStatus(ack);trace('https_ack',{status});
    if(!matchingAck(ack?.body,{chatId,userId,messageId,asset,requireLog:status===0}))return {phase:'unknown',status};
    if(status!==0)return {phase:status===null?'unknown':'failed',status};
    return {phase:'accepted',status:0,chatLog:ack.body.chatLog ?? ack.body.log ?? {logId:ack.body.logId},completeBody:ack.body,attachment:JSON.stringify(asset)};
  }catch(error){trace('https_exception',{failure:'exception',code:safeCode(error)});return {phase:attempted?'unknown':'failed',status:null};}
  finally{finalized=true;clearTimeout(timer);signal?.removeEventListener('abort',externalAbort);controller.abort();uploadSignal.removeEventListener('abort',destroy);destroy();}
}
