import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { safeDestination } from './room-probe.mjs';

export function photoUrl(value){
  try{
    if(typeof value!=='string' || value.length>4096)return null;
    const url=new URL(value),host=url.hostname.toLowerCase();
    if(!['http:','https:'].includes(url.protocol) || url.username || url.password || url.port || url.hash || isIP(host))return null;
    if(!(host.endsWith('.kakaocdn.net') || host==='talkv.kakao.com' || /^[a-z0-9-]+\.talk\.kakao\.com$/.test(host)))return null;
    url.protocol='https:';return url.href;
  }catch{return null;}
}
export function photoAttachments(log){
  const kind=Number(log?.type ?? log?.msgType ?? log?.t);if(![2,27].includes(kind))return [];
  let data=log?.attachment;if(typeof data==='string'){if(data.length>65536)return [];try{data=JSON.parse(data);}catch{return [];}}
  if(!data || typeof data!=='object' || Array.isArray(data))return [];
  const urls=kind===27?(Array.isArray(data.imageUrls)?data.imageUrls:data.thumbnailUrls):[data.url ?? data.thumbnailUrl];
  if(!Array.isArray(urls))return [];
  return urls.slice(0,30).map((url,index)=>({url:photoUrl(url),width:Number(kind===27?data.wl?.[index]:data.w),height:Number(kind===27?data.hl?.[index]:data.h)})).filter(photo=>photo.url).map(photo=>({...photo,width:Number.isInteger(photo.width)&&photo.width>0&&photo.width<=20000?photo.width:null,height:Number.isInteger(photo.height)&&photo.height>0&&photo.height<=20000?photo.height:null}));
}
export function imageType(data){
  if(data.length<12)return null;
  if(data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(data[0]===255 && data[1]===216 && data[2]===255)return 'image/jpeg';
  if(['GIF87a','GIF89a'].includes(data.toString('ascii',0,6)))return 'image/gif';
  if(data.toString('ascii',0,4)==='RIFF' && data.toString('ascii',8,12)==='WEBP')return 'image/webp';
  return null;
}
// Header-declared pixel size only (PNG IHDR, JPEG SOF, GIF screen, WebP VP8/VP8L/VP8X).
export function imageDimensions(data){
  const type=imageType(data);
  if(type==='image/png')return data.length>=24 && data.toString('ascii',12,16)==='IHDR'?{width:data.readUInt32BE(16),height:data.readUInt32BE(20)}:null;
  if(type==='image/gif')return {width:data.readUInt16LE(6),height:data.readUInt16LE(8)};
  if(type==='image/webp'){
    const chunk=data.toString('ascii',12,16);
    if(chunk==='VP8 ' && data.length>=30)return {width:data.readUInt16LE(26)&0x3fff,height:data.readUInt16LE(28)&0x3fff};
    if(chunk==='VP8L' && data.length>=25){const bits=data.readUInt32LE(21);return {width:(bits&0x3fff)+1,height:((bits>>>14)&0x3fff)+1};}
    if(chunk==='VP8X' && data.length>=30)return {width:data.readUIntLE(24,3)+1,height:data.readUIntLE(27,3)+1};
    return null;
  }
  if(type!=='image/jpeg')return null;
  let offset=2;
  while(offset+4<=data.length){
    if(data[offset++]!==255)return null;
    while(data[offset]===255)offset++;
    const marker=data[offset++];if(marker===217 || marker===218)return null;
    if(marker===1 || marker>=208 && marker<=215)continue;
    if(offset+2>data.length)return null;const size=data.readUInt16BE(offset);
    if(size<2 || offset+size>data.length)return null;
    if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && size>=8)return {width:data.readUInt16BE(offset+5),height:data.readUInt16BE(offset+3)};
    offset+=size;
  }
  return null;
}
// Decompression-bomb bound for fetched photos; unknown sizes are refused.
const displayable=data=>{const size=imageDimensions(data);return Boolean(size && size.width>0 && size.height>0 && size.width<=8192 && size.height<=8192 && size.width*size.height<=40000000);};
export async function fetchPhoto(value,{signal,resolve=lookup,request=https.request,redirects=0,deadlineMs=8000}={}){
  if(!Number.isFinite(deadlineMs) || deadlineMs<=0 || deadlineMs>2147483647)throw new Error('photo_unavailable');
  const controller=new AbortController(),requests=new Set();
  const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();
  const timer=setTimeout(abort,deadlineMs);
  const raced=operation=>new Promise((accept,reject)=>{
    let settled=false;
    const finish=(callback,value)=>{if(settled)return;settled=true;controller.signal.removeEventListener('abort',onAbort);callback(value);};
    const onAbort=()=>finish(reject,new Error('photo_unavailable'));
    controller.signal.addEventListener('abort',onAbort,{once:true});
    if(controller.signal.aborted){onAbort();return;}
    Promise.resolve().then(()=>{if(controller.signal.aborted)throw new Error('photo_unavailable');return operation();}).then(value=>finish(accept,value),error=>finish(reject,error));
  });
  const fetch=async(value,count)=>{
    const target=photoUrl(value);if(!target || count>2 || controller.signal.aborted)throw new Error('photo_unavailable');
    const url=new URL(target),addresses=await raced(()=>resolve(url.hostname,{all:true,verbatim:true}));
    const address=addresses.find(item=>isIP(item.address) && safeDestination(item.address,443));
    if(!address || controller.signal.aborted)throw new Error('photo_unavailable');
    const result=await raced(()=>new Promise((accept,reject)=>{
      const fail=()=>reject(new Error('photo_unavailable'));
      const req=request(url,{agent:false,autoSelectFamily:false,signal:controller.signal,servername:url.hostname,lookup:(_host,_options,callback)=>callback(null,address.address,address.family),headers:{Accept:'image/jpeg,image/png,image/webp,image/gif'}},response=>{
        if([301,302,303,307,308].includes(response.statusCode)){
          response.resume();let next;try{next=new URL(response.headers.location,url).href;}catch{fail();return;}
          requests.delete(req);req.destroy();accept({redirect:next});return;
        }
        if(response.statusCode!==200 || Number(response.headers['content-length'])>10*1024*1024){response.destroy();fail();return;}
        const chunks=[];let size=0;
        response.on('data',chunk=>{size+=chunk.length;if(size>10*1024*1024){req.destroy();fail();}else chunks.push(chunk);});
        response.on('error',fail);response.on('aborted',fail);
        response.on('end',()=>{const data=Buffer.concat(chunks),type=imageType(data);if(!type || !displayable(data)){fail();return;}requests.delete(req);accept({data,type});});
      });
      requests.add(req);req.on('error',fail);req.end();
    }));
    return result.redirect?fetch(result.redirect,count+1):result;
  };
  try{return await fetch(value,redirects);}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();for(const req of requests)req.destroy();requests.clear();}
}
export function createPhotoCache({fetcher=fetchPhoto}={}){
  const entries=new Map(),pending=new Map();let bytes=0,epoch=0,active=0;const controllers=new Set(),waiting=[];
  return {
    async get(url){
      if(entries.has(url)){const item=entries.get(url);entries.delete(url);entries.set(url,item);return item;}
      if(pending.has(url))return pending.get(url);
      if(pending.size>=40)throw new Error('photo_busy');
      const current=epoch,controller=new AbortController();controllers.add(controller);
      const promise=(async()=>{try{
        if(active>=4)await new Promise(resolve=>waiting.push(resolve));else active++;
        if(current!==epoch)throw new Error('photo_unavailable');
        const item=await fetcher(url,{signal:controller.signal});if(!Buffer.isBuffer(item?.data) || item.data.length>10*1024*1024)throw new Error('photo_unavailable');if(current!==epoch)throw new Error('photo_unavailable');
        while(entries.size && bytes+item.data.length>30*1024*1024){const [key,value]=entries.entries().next().value;bytes-=value.data.length;entries.delete(key);}
        entries.set(url,item);bytes+=item.data.length;return item;
      }finally{controllers.delete(controller);if(current===epoch){pending.delete(url);const next=waiting.shift();if(next)next();else active--;}}})();pending.set(url,promise);return promise;
    },
    clear(){epoch++;for(const controller of controllers)controller.abort();controllers.clear();entries.clear();pending.clear();bytes=0;active=0;for(const resume of waiting.splice(0))resume();},
  };
}
