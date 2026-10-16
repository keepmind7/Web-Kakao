import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { createCipheriv,createDecipheriv,randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import { uploadPhoto } from '../experiments/local-web/media-upload.mjs';
import { guardReaderClient } from '../experiments/local-web/reader-protocol.mjs';

// This suite never loads the running app, real credentials, media or clipboard.
// It uses the pinned production transport against a loopback-only test peer.
process.env.KAKAO_DEBUG_LOCO='0';
await import('../local-only/spikes/modern/node_modules/tsx/dist/loader.mjs');
const {CarriageClient,toLong}=await import('../local-only/spikes/modern/src/kakao/forge-protocol.ts');
const {BSON}=createRequire(new URL('../local-only/spikes/modern/package.json',import.meta.url))('bson');
const MAX_FRAME_BODY=131068;
function png(width,height){
  const chunk=(type,body)=>{
    const label=Buffer.from(type),size=Buffer.alloc(4),crc=Buffer.alloc(4);size.writeUInt32BE(body.length);
    let value=0xffffffff;
    for(const byte of Buffer.concat([label,body])){value^=byte;for(let n=0;n<8;n++)value=(value>>>1)^((value&1)?0xedb88320:0);}
    crc.writeUInt32BE((value^0xffffffff)>>>0);return Buffer.concat([size,label,body,crc]);
  };
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc(height*(1+width*3)),{level:0})),chunk('IEND',Buffer.alloc(0))]);
}
function packet(id,method,body){
  const encoded=BSON.serialize(body),header=Buffer.alloc(22);header.writeInt32LE(id);header.write(method,6,11,'ascii');header.writeInt32LE(encoded.length,18);return Buffer.concat([header,encoded]);
}
function encrypt(key,plain){
  const nonce=randomBytes(12),cipher=createCipheriv('aes-128-gcm',key,nonce),data=Buffer.concat([cipher.update(plain),cipher.final(),cipher.getAuthTag()]);
  const length=Buffer.alloc(4);length.writeUInt32LE(12+data.length);return Buffer.concat([length,nonce,data]);
}
function decrypt(key,frame){
  const cipher=createDecipheriv('aes-128-gcm',key,frame.subarray(0,12));cipher.setAuthTag(frame.subarray(-16));return Buffer.concat([cipher.update(frame.subarray(12,-16)),cipher.final()]);
}
async function exercise(data,{offset=0,frameLimit=MAX_FRAME_BODY,abort=false}={}){
  const Media=guardReaderClient(CarriageClient,null,{messaging:true,media:true}),client=new Media();
  // The sole key inspected belongs to this new synthetic client. It is shared
  // with this test peer only in memory; neither key nor wire bytes are logged.
  const key=client.crypto.aesKey,observed={handshakes:0,posts:0,frames:[],received:[],oversized:false,errors:[]};
  const sockets=new Set(),controller=new AbortController(),steps=[];
  let peerDone;
  const disconnected=new Promise(resolve=>{peerDone=resolve;});
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>{sockets.delete(socket);peerDone();});socket.on('error',()=>{});
    let buffer=Buffer.alloc(0),handshaked=false,posted=false,received=offset;
    const complete=()=>{
      // COMPLETE is split over two encrypted frames, and the first frame's
      // size prefix itself is split over TCP writes.
      const raw=packet(1,'COMPLETE',{status:0,chatLog:{logId:toLong('42'),chatId:toLong('123')}});
      const first=encrypt(key,raw.subarray(0,13)),second=encrypt(key,raw.subarray(13));
      socket.write(first.subarray(0,2));setImmediate(()=>{if(!socket.destroyed)socket.write(Buffer.concat([first.subarray(2),second]));});
    };
    socket.on('data',chunk=>{
      try{
        buffer=Buffer.concat([buffer,chunk]);
        if(!handshaked){
          if(buffer.length<12)return;const size=buffer.readUInt32LE(0);assert.equal(size,256);assert.equal(buffer.readUInt32LE(4),16);assert.equal(buffer.readUInt32LE(8),3);
          if(buffer.length<12+size)return;buffer=buffer.subarray(12+size);handshaked=true;observed.handshakes++;
        }
        while(buffer.length>=4){
          const length=buffer.readUInt32LE(0);
          if(length>frameLimit){observed.oversized=true;socket.destroy();return;}
          if(buffer.length<length+4)return;
          const plain=decrypt(key,buffer.subarray(4,4+length));buffer=buffer.subarray(4+length);
          if(!posted){
            const method=plain.subarray(6,17).toString('ascii').replace(/\0.*$/,'');assert.equal(method,'POST');
            const body=BSON.deserialize(plain.subarray(22));assert.equal(body.s,data.length);assert.equal(String(body.c),'123');assert.equal(String(body.mid),'345');
            observed.posts++;posted=true;socket.write(encrypt(key,packet(plain.readInt32LE(0),'POST',{status:0,o:offset})));
            if(abort){controller.abort();return;}
            if(offset===data.length)complete();
          }else{
            observed.frames.push(length);observed.received.push(plain);received+=plain.length;
            assert.ok(received<=data.length);if(received===data.length)complete();
          }
        }
      }catch(error){observed.errors.push(error);socket.destroy();}
    });
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const result=await uploadPhoto({carriage:{async request(method){assert.equal(method,'SHIP');return {status:0,body:{k:'SYNTHETIC',vh:'unused.invalid',p:server.address().port}};}},
      createClient:()=>client,toLong,chatId:'123',userId:'999',messageId:'345',data,signal:controller.signal,
      resolve:async()=> '127.0.0.1',profile:{os:'android',appVersion:'26.1.2'},timeout:1000,observe:e=>steps.push(e)});
    await disconnected;assert.deepEqual(observed.errors,[]);
    return {result,observed,steps};
  }finally{client.disconnect();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}
}

test('real media transport preserves a small PNG and reassembles fragmented COMPLETE',async()=>{
  const data=png(1,1),{result,observed,steps}=await exercise(data);
  assert.equal(result.phase,'accepted');assert.equal(observed.handshakes,1);assert.equal(observed.posts,1);assert.equal(observed.oversized,false);
  assert.deepEqual(Buffer.concat(observed.received),data);assert.equal(steps.at(-1).stage,'received_complete');
});
test('a large PNG fits bounded GCM frames and preserves every file byte',async()=>{
  const data=png(512,512),{result,observed}=await exercise(data);
  assert.equal(observed.oversized,false);assert.equal(result.phase,'accepted');assert.ok(observed.frames.length>1);
  assert.ok(observed.frames.every(size=>size<=MAX_FRAME_BODY));assert.deepEqual(Buffer.concat(observed.received),data);
});
test('resumed media starts at a non-frame-aligned offset without gaps or duplicates',async()=>{
  const data=png(512,512),offset=65539,{result,observed}=await exercise(data,{offset});
  assert.equal(result.phase,'accepted');assert.deepEqual(Buffer.concat(observed.received),data.subarray(offset));
});
test('transport cancellation after POST ends without a second connection or request',async()=>{
  const {result,observed}=await exercise(png(1,1),{abort:true});
  assert.equal(result.phase,'unknown');assert.equal(observed.posts,1);assert.equal(observed.handshakes,1);assert.equal(observed.received.length,0);
});
