// Actual fork/IPC/exit with production worker body; synthetic session/bootstrap,
// memory diagnostic writers and no sockets/accounts/private storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {fork} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';
import {createReadOnlyReader} from '../experiments/local-web/reader-manager.mjs';
import {createReaderDiagnostic} from '../experiments/local-web/reader-diagnostics.mjs';
import {DEFAULT_PHOTO_TRANSPORT,normalizePhotoTransport} from '../experiments/local-web/photo-transport.mjs';

const room={key:'r_'+'a'.repeat(24),kind:'DirectChat',title:'Synthetic'};
if(process.argv[2]==='--synthetic-reader'){
  const original=readFileSync(new URL('../experiments/local-web/reader-worker.mjs',import.meta.url),'utf8');
  const dynamic=/const sdk=await import\('[^']+forge-protocol\.ts'\);/;assert.match(original,dynamic);
  const source=original.replace(/^import .*;\r?\n/gm,'').replace(dynamic,'const sdk=__sdk;');
  class Client{}
  runInNewContext(source,{process,Buffer,setTimeout,clearTimeout,DEFAULT_PHOTO_TRANSPORT,normalizePhotoTransport,
    checkPinnedSource(){},roomKeyValid:()=>true,guardReaderClient:Base=>Base,__sdk:{BookingClient:Client,TicketClient:Client,CarriageClient:Client,toLong:String},
    createReaderDiagnostic:options=>createReaderDiagnostic({...options,writeSnapshot(){},writeSendSnapshot(){}}),
    createReaderSession:(_credential,_factory,emit)=>({async start(){emit({type:'reader-rooms',source:'loginlist',rooms:[room],stats:{sourceRoomCount:1}});return {ok:true};},close(){}}),
  },{filename:'synthetic-production-reader-worker.mjs'});
  process.on('message',message=>{if(message?.type==='synthetic-fatal'){
    const backlog=Number(process.argv[3]??0);if(backlog)process.send({type:'synthetic-backpressure',text:'x'.repeat(backlog)});
    setImmediate(()=>{const error=new RangeError('PRIVATE_FATAL_MESSAGE');error.stack='RangeError PRIVATE_FATAL_MESSAGE\n at onData (PRIVATE_URL:1)';throw error;});
  }});
}else{
  const until=async check=>{const end=Date.now()+5000;while(!check()){assert.ok(Date.now()<end,'synthetic worker deadline');await new Promise(resolve=>setTimeout(resolve,5));}};
  for(const backlog of [0,1024*1024])test(`actual worker fatal code and subsequent manual signal survive reconnect with ${backlog} IPC backlog bytes`,async t=>{
    const children=[];let journal;
    const profile={key:()=>Buffer.alloc(32),snapshot:()=>({notifications:false}),room:()=>null,close(){}};
    const reader=createReadOnlyReader({preferenceStore:{account:()=>profile},lifecycleOptions:{writeSnapshot:raw=>{journal=JSON.parse(raw);}},spawn:(_file,_args,options)=>{const child=fork(fileURLToPath(import.meta.url),['--synthetic-reader',String(backlog)],options);children.push(child);return child;}});
    try{
      const credential={userId:'999',deviceUUID:'SYNTHETIC',accessToken:'SYNTHETIC_NO_ACCOUNT'};
      assert.equal(reader.connect(credential),true);await until(()=>reader.snapshot().phase==='connected');children[0].send({type:'synthetic-fatal'});
      await until(()=>journal.attempts[0].exit?.code===4);assert.equal(reader.snapshot().phase,'disconnected');
      assert.equal(journal.attempts[0].diagnostic?.exitReason,'fatal','terminal diagnostic must survive queued IPC');assert.deepEqual(journal.attempts[0].diagnostic.fault,{category:'RangeError',frames:['onData']});
      assert.equal(reader.connect(credential),true);await until(()=>reader.snapshot().phase==='connected');reader.disconnect();
      await until(()=>journal.attempts[1].exit?.signal==='SIGTERM');assert.equal(journal.attempts[1].terminationReason,'manual');assert.equal(journal.attempts[0].exit.code,4);assert.equal(JSON.stringify(journal).includes('PRIVATE'),false);
    }finally{reader.close();await until(()=>children.every(child=>child.exitCode!==null||child.signalCode!==null));}
    t.diagnostic(JSON.stringify({childrenExited:children.length,privateWriters:'injected-memory-only',realSockets:0,actualAccounts:0}));
  });
}
