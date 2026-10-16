import { imageType } from './photos.mjs';

export const IMAGE_LIMIT=10*1024*1024;
export const messageKeyValid=value=>typeof value==='string' && /^m_[a-f0-9]{24}$/.test(value);
export const clientIdValid=value=>typeof value==='string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export function attachmentObject(value){
  if(typeof value==='string'){if(value.length>65536)return null;try{value=JSON.parse(value);}catch{return null;}}
  return value && typeof value==='object' && !Array.isArray(value)?value:null;
}
export function replyExtra(target){
  if(!target || !/^[1-9]\d{0,18}$/.test(target.id) || !/^[1-9]\d{0,18}$/.test(target.authorId) || ![1,2,26,27].includes(target.type))return null;
  if(BigInt(target.id)>9223372036854775807n || BigInt(target.authorId)>9223372036854775807n)return null;
  // Decimal IDs must be JSON numbers without an intermediate Number rounding.
  return '{"src_logId":'+target.id+',"src_userId":'+target.authorId+','+JSON.stringify({src_type:target.type,src_message:target.text,src_mentions:[],attach_only:false}).slice(1);
}
export function inspectImage(data){
  if(!Buffer.isBuffer(data) || data.length>IMAGE_LIMIT || data.length<24)return null;
  const mime=imageType(data);let width=0,height=0;
  if(mime==='image/png' && data.toString('ascii',12,16)==='IHDR'){width=data.readUInt32BE(16);height=data.readUInt32BE(20);}
  else if(mime==='image/jpeg'){
    let offset=2;
    while(offset+4<=data.length){
      if(data[offset++]!==255)return null;
      while(data[offset]===255)offset++;
      const marker=data[offset++];if(marker===217 || marker===218)break;
      if(marker===1 || marker>=208 && marker<=215)continue;
      if(offset+2>data.length)break;const size=data.readUInt16BE(offset);
      if(size<2 || offset+size>data.length)break;
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && size>=8){height=data.readUInt16BE(offset+3);width=data.readUInt16BE(offset+5);break;}
      offset+=size;
    }
  }
  if(!width || !height || width>4096 || height>4096 || width*height>16777216)return null;
  return {mime,width,height,ext:mime==='image/png'?'png':'jpg'};
}
export function decodeImage(value){
  if(typeof value!=='string' || value.length>Math.ceil(IMAGE_LIMIT/3)*4 || !value.length || value.length%4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))return null;
  const data=Buffer.from(value,'base64');if(data.toString('base64')!==value)return null;
  const image=inspectImage(data);return image?{...image,data}:null;
}
