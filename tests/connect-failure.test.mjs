import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { guardReaderClient } from '../experiments/local-web/reader-protocol.mjs';

process.env.KAKAO_DEBUG_LOCO='0';
await import('../local-only/spikes/modern/node_modules/tsx/dist/loader.mjs');
const {CarriageClient}=await import('../local-only/spikes/modern/src/kakao/forge-protocol.ts');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('a refused pinned carriage connection settles immediately and leaves no delayed connection rejection',async()=>{
  const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
  const port=reservation.address().port;assert.notEqual(port,8787);await new Promise(resolve=>reservation.close(resolve));
  const client=new (guardReaderClient(CarriageClient,null,{messaging:true}))();let settled=false,errors=0,closed=0;
  client.on('error',()=>{errors++;client.disconnect();});client.on('disconnected',()=>closed++);
  try{
    const waiting=client.connect('127.0.0.1',port,350).then(()=>({accepted:true}),()=>({accepted:false})).finally(()=>{settled=true;});
    while(!errors)await sleep(2);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(settled,true,'socket error must settle before the configured 350ms deadline');
    assert.deepEqual(await waiting,{accepted:false});await sleep(370);
    assert.equal(errors,1);assert.equal(closed,1);assert.equal(client.pending.size,0);
  }finally{client.disconnect();}
});

async function listeningPeer(){
  const sockets=new Set(),server=net.createServer(socket=>{sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));});
  server.listen(0,'127.0.0.1');await once(server,'listening');assert.notEqual(server.address().port,8787);
  return {port:server.address().port,async close(){for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));assert.equal(server.listening,false);}};
}

test('explicit disconnect cancels an in-flight connect and its own deadline',async()=>{
  const peer=await listeningPeer(),client=new (guardReaderClient(CarriageClient,null,{messaging:true}))();client.on('error',()=>{});
  try{
    const waiting=client.connect('127.0.0.1',peer.port,60);client.disconnect();
    await assert.rejects(waiting,/disconnected/);assert.equal(client.connecting,null);
    await sleep(80);assert.equal(client.pending.size,0);
  }finally{client.disconnect();await peer.close();}
});

test('handshake construction failure rejects and closes its socket without waiting for the deadline',async()=>{
  class BrokenHandshake extends CarriageClient{constructor(){super();this.crypto.buildHandshake=()=>{throw new Error('synthetic_handshake_failure');};}}
  const peer=await listeningPeer(),client=new (guardReaderClient(BrokenHandshake,null,{messaging:true}))();client.on('error',()=>{});
  try{
    await assert.rejects(client.connect('127.0.0.1',peer.port,350),/synthetic_handshake_failure/);
    assert.equal(client.socket.destroyed,true);assert.equal(client.connecting,null);assert.equal(client.pending.size,0);
  }finally{client.disconnect();await peer.close();}
});

test('a second connect cannot replace the first active carriage socket',async()=>{
  const peer=await listeningPeer(),client=new (guardReaderClient(CarriageClient,null,{messaging:true}))();client.on('error',()=>{});
  try{
    await client.connect('127.0.0.1',peer.port,350);const socket=client.socket;
    await assert.rejects(client.connect('127.0.0.1',peer.port,350),/already_active/);
    assert.equal(client.socket,socket);assert.equal(socket.destroyed,false);
  }finally{client.disconnect();await peer.close();}
});
