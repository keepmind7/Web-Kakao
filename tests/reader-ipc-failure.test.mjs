// In-memory IPC failures only. No worker process, socket, account, server or
// preference file is opened; every child and credential below is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createReadOnlyReader } from '../experiments/local-web/reader-manager.mjs';

const credential={userId:'999',deviceUUID:'SYNTHETIC_DEVICE',accessToken:'SYNTHETIC_NO_LOGIN'};
const room='r_'+'a'.repeat(24),other='r_'+'b'.repeat(24);
const clientId='11111111-1111-4111-8111-111111111111';
const nextId='22222222-2222-4222-8222-222222222222';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const row=key=>({key,kind:'DirectChat',title:'Synthetic',canText:true,canPhoto:true,canReply:true,canRead:true,canContext:true});
const preferenceStore={account:()=>({key:()=>Buffer.alloc(32),snapshot:()=>({notifications:false}),room:()=>null,close(){}})};

function fixture(mode='success'){
  const children=[];
  const reader=createReadOnlyReader({messaging:true,preferenceStore,spawn:()=>{
    const child=Object.assign(new EventEmitter(),{
      mode:children.length===0?mode:'success',sent:[],callbacks:[],killed:false,
      send(value,callback){
        this.sent.push(value);
        if(value.type!=='reader-action'){callback?.();return true;}
        this.callbacks.push(callback);
        if(this.mode==='throw')throw new Error('synthetic IPC dispatch failure');
        if(this.mode==='sync-error')callback?.(new Error('synthetic IPC callback failure'));
        else if(this.mode!=='deferred-error')callback?.();
        // Node's false return can be flow control rather than a failed send.
        return this.mode!=='backpressure';
      },
      kill(){this.killed=true;return true;},
    });
    children.push(child);return child;
  }});
  const connect=()=>{
    assert.equal(reader.connect(credential),true);
    const child=children.at(-1);
    child.emit('message',{type:'reader-rooms',source:'loginlist',rooms:[row(room),row(other)],stats:{sourceRoomCount:2}});
    assert.equal(reader.snapshot().phase,'connected');return child;
  };
  const dispatch=(kind,id=clientId,key=room)=>kind==='text'?reader.sendText(key,'Synthetic text',id):reader.sendPhoto(key,png,id);
  const actions=child=>child.sent.filter(value=>value.type==='reader-action');
  const accept=(child,request)=>child.emit('message',{type:'reader-action',key:request.key,requestId:request.requestId,action:request.action,phase:'accepted',status:0,messageKey:'m_'+'e'.repeat(24)});
  const child=connect();return {reader,child,children,connect,dispatch,actions,accept};
}

for(const kind of ['text','photo'])for(const mode of ['throw','sync-error']){
  test(kind+' synchronous '+mode+' releases the operation and exposes unknown instead of permanent sending',()=>{
    const f=fixture(mode);
    try{
      f.dispatch(kind);
      const state=f.reader.snapshot(),entry=f.reader.outbox(clientId);
      assert.deepEqual({connection:state.phase,busy:state.operationBusy,phase:entry?.phase,accepted:state.sendAccepted,attempts:f.actions(f.child).length},
        {connection:'disconnected',busy:false,phase:'unknown',accepted:0,attempts:1});
      assert.equal(f.child.killed,true);
      assert.equal(f.reader.acknowledgeOutbox(clientId),true,'uncertain delivery can be explicitly acknowledged without retransmission');
      assert.equal(f.actions(f.child).length,1);
    }finally{f.reader.close();}
  });

  test(kind+' synchronous '+mode+' preserves uncertain identity across reconnect and duplicate submissions',()=>{
    const f=fixture(mode);
    try{
      f.dispatch(kind);
      assert.equal(f.reader.snapshot().phase,'disconnected');
      const next=f.connect();
      assert.equal(f.actions(next).length,0,'reconnection must not resend an old action');
      assert.equal(f.dispatch(kind),true,'same UUID and same payload refers to the existing operation');
      assert.equal(f.dispatch(kind,clientId,other),false,'UUID cannot be rebound to another room');
      assert.equal(f.reader.sendText(room,'Different synthetic payload',clientId),false,'UUID cannot be rebound to another payload or kind');
      assert.equal(f.actions(next).length,0,'duplicate HTTP submission must not dispatch again');
      assert.equal(f.reader.snapshot().sendRequests,1);
      assert.equal(f.reader.outbox(clientId)?.phase,'unknown','reconnect cannot turn uncertainty into a sending operation without a pending worker');
    }finally{f.reader.close();}
  });
}

for(const kind of ['text','photo']){
  for(const refusal of ['disconnected','capability','busy'])test(kind+' '+refusal+' admission refusal creates no ghost outbox entry',()=>{
    const f=fixture();
    try{
      if(refusal==='disconnected')f.reader.disconnect();
      else if(refusal==='capability')f.child.emit('message',{type:'reader-rooms',source:'push',rooms:[{...row(room),canText:false,canPhoto:false},row(other)]});
      else assert.equal(f.dispatch(kind,clientId),true);
      const before=f.actions(f.child).length,requests=f.reader.snapshot().sendRequests;
      assert.equal(f.dispatch(kind,nextId),false);
      assert.equal(f.reader.outbox(nextId),null);
      assert.equal(f.actions(f.child).length,before);
      assert.equal(f.reader.snapshot().sendRequests,requests);
    }finally{f.reader.close();}
  });

  test(kind+' asynchronous IPC callback failure keeps the same unknown contract',()=>{
    const f=fixture('deferred-error');
    try{
      assert.equal(f.dispatch(kind),true);
      assert.equal(f.reader.outbox(clientId).phase,'sending');
      assert.equal(f.reader.snapshot().operationBusy,true);
      f.child.callbacks[0](new Error('synthetic delayed IPC failure'));
      assert.equal(f.reader.snapshot().phase,'disconnected');
      assert.equal(f.reader.snapshot().operationBusy,false);
      assert.equal(f.reader.outbox(clientId).phase,'unknown');
      assert.equal(f.reader.snapshot().sendAccepted,0);
      assert.equal(f.actions(f.child).length,1);
    }finally{f.reader.close();}
  });

  test(kind+' late IPC error and result from a retired child cannot close or complete a newer request',()=>{
    const f=fixture('deferred-error');
    try{
      f.dispatch(kind);const old=f.actions(f.child)[0],late=f.child.callbacks[0];
      f.reader.disconnect();
      assert.equal(f.reader.outbox(clientId).phase,'unknown');
      const next=f.connect();assert.equal(f.dispatch(kind,nextId),true);
      const current=f.actions(next)[0];
      late(new Error('synthetic retired child callback'));
      f.accept(f.child,old);
      assert.equal(f.reader.snapshot().phase,'connected');
      assert.equal(f.reader.snapshot().operationBusy,true);
      assert.equal(f.reader.outbox(clientId).phase,'unknown');
      assert.equal(f.reader.outbox(nextId).phase,'sending');
      f.accept(next,current);
      assert.equal(f.reader.snapshot().operationBusy,false);
      assert.equal(f.reader.outbox(nextId).phase,'accepted');
      assert.equal(f.reader.snapshot().sendAccepted,1);
      assert.equal(f.actions(next).length,1);
    }finally{f.reader.close();}
  });

  test(kind+' healthy dispatch accepts once and repeated submissions and ACKs do not increment success',()=>{
    const f=fixture();
    try{
      assert.equal(f.dispatch(kind),true);const request=f.actions(f.child)[0];
      assert.equal(f.dispatch(kind),true);assert.equal(f.actions(f.child).length,1);
      f.accept(f.child,request);f.accept(f.child,request);
      assert.equal(f.reader.outbox(clientId).phase,'accepted');
      assert.equal(f.reader.snapshot().sendAccepted,1);
      assert.equal(f.reader.snapshot().operationBusy,false);
      assert.equal(f.dispatch(kind),true);assert.equal(f.actions(f.child).length,1);
    }finally{f.reader.close();}
  });

  test(kind+' IPC backpressure without an error remains pending until a matching response',()=>{
    const f=fixture('backpressure');
    try{
      assert.equal(f.dispatch(kind),true);
      assert.equal(f.reader.snapshot().phase,'connected');
      assert.equal(f.reader.snapshot().operationBusy,true);
      assert.equal(f.reader.outbox(clientId).phase,'sending');
      f.accept(f.child,f.actions(f.child)[0]);
      assert.equal(f.reader.outbox(clientId).phase,'accepted');
      assert.equal(f.reader.snapshot().operationBusy,false);
    }finally{f.reader.close();}
  });
}
