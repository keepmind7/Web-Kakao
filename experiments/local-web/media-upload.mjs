import { createHash } from 'node:crypto';
import { resolvePublicDestination } from './room-probe.mjs';
import { responseStatus } from './reader-response.mjs';
import { inspectImage } from './message-content.mjs';

// Match the pinned transport's 131,068-byte encrypted block body limit:
// 12-byte nonce + plaintext + 16-byte GCM tag. This is a conservative framing
// bound, not evidence of the live upload server's own negotiated limit.
export const MAX_UPLOAD_CHUNK_BYTES=131068-12-16;

function uploadFault(error){
  const category=['TypeError','RangeError','Error'].includes(error?.name)?error.name:'other';
  const codes=['EPIPE','ECONNRESET','ETIMEDOUT','ERR_STREAM_DESTROYED','ERR_SOCKET_CLOSED'];
  const code=codes.includes(error?.code)?error.code:error?.message==='Carriage not connected'?'not_connected':'other';
  return {category,code}; // Never record a raw error message, stack or address.
}

// Pinned node-kakao uploadMedia / kakao-cli uploadPhotoFromPath: COMPLETE posts
// the photo itself. Never follow this path with WRITE, nor automatically retry.
export async function uploadPhoto(options){
  let posting=false,stage='ship';
  const trace=(next,details={})=>{stage=next;options.observe?.({stage,...details});};
  try{return await performUpload({...options,trace,onPosting:()=>{posting=true;}});}catch(error){trace(stage,{failure:'exception',...uploadFault(error)});return {phase:posting?'unknown':'failed',status:null};}
}
async function performUpload({carriage,createClient,toLong,chatId,userId,messageId,data,signal,resolve=resolvePublicDestination,profile,timeout=20000,onPosting,trace}){
  const image=inspectImage(data);if(!image)throw new Error('invalid_image');
  if(typeof messageId!=='string' || !/^[1-9]\d{0,18}$/.test(messageId) || BigInt(messageId)>9223372036854775807n)throw new Error('invalid_message_id');
  const assertLive=()=>{if(signal?.aborted)throw new Error('upload_cancelled');};
  assertLive();
  trace('ship',{totalBytes:data.length});
  const ship=await carriage.request('SHIP',{c:toLong(chatId),s:data.length,t:2,cs:createHash('sha1').update(data).digest('hex').toUpperCase(),e:image.ext},timeout);
  if(responseStatus(ship)!==0)return {phase:'failed',status:responseStatus(ship)};
  assertLive();
  const token=ship.body?.k,host=ship.body?.vh,port=Number(ship.body?.p);
  if(typeof token!=='string' || !token.length || token.length>4096)throw new Error('invalid_upload_route');
  trace('route');const address=await resolve(host,port);assertLive();
  const client=createClient();let settle,settled=false,posting=false;
  const complete=new Promise(resolve=>{settle=resolve;});
  const finish=value=>{if(!settled){settled=true;settle(value);}};
  const onPush=packet=>{if(packet?.method==='COMPLETE')finish({packet});};
  const onError=error=>{trace('transport',{failure:'closed_or_error',...uploadFault(error)});finish({error:true});};
  const onAbort=()=>{finish({error:true});client.disconnect();};
  client.on('push',onPush);client.on('error',onError);client.on('disconnected',onError);signal?.addEventListener('abort',onAbort,{once:true});
  const timer=setTimeout(()=>{trace('deadline',{failure:'timeout'});finish({error:true});client.disconnect();},timeout+10000);timer.unref?.();
  try{
    trace('connect');
    await client.connect(address,port,timeout);assertLive();
    // POST may already create a message; everything uncertain after this point
    // is reported as unknown. The caller retains its request UUID.
    posting=true;onPosting();trace('post');
    const post=await client.request('POST',{k:token,s:data.length,f:'photo.'+image.ext,t:2,c:toLong(chatId),mid:toLong(messageId),ns:true,u:toLong(userId),os:profile.os,av:profile.appVersion,nt:0,mm:'45005',w:image.width,h:image.height},timeout);
    if(responseStatus(post)!==0)return {phase:responseStatus(post)===null?'unknown':'failed',status:responseStatus(post)};
    const offset=Number(post.body?.o);
    trace('offset',{offset:Number.isSafeInteger(offset)?offset:null,totalBytes:data.length});
    if(!Number.isSafeInteger(offset) || offset<0 || offset>data.length){trace('offset',{failure:'invalid_offset'});return {phase:'unknown',status:null};}
    let sent=offset;
    trace('stream');
    // Each writeEncrypted call makes a complete GCM frame. Preserve the file
    // byte sequence while bounding each frame, including nonce and tag.
    while(sent<data.length){assertLive();const end=Math.min(sent+MAX_UPLOAD_CHUNK_BYTES,data.length);await client.writeEncrypted(data.subarray(sent,end));sent=end;trace('stream',{sentBytes:sent,totalBytes:data.length});}
    trace('await_complete',{sentBytes:sent,totalBytes:data.length});
    const result=await complete;assertLive();
    if(result.error)return {phase:'unknown',status:null};
    const status=responseStatus(result.packet);
    trace('received_complete',{status});
    return {phase:status===0?'accepted':status===null?'unknown':'failed',status,chatLog:status===0?result.packet.body?.chatLog:null};
  }catch(error){trace('exception',uploadFault(error));return {phase:posting?'unknown':'failed',status:null};}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);client.off('push',onPush);client.off('disconnected',onError);client.disconnect();/* Keep the harmless error listener for late socket errors. */}
}
