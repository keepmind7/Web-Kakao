import { checkPinnedSource } from './kakao-auth.mjs';
import { createReaderSession } from './reader-session.mjs';
import { roomKeyValid } from './reader-data.mjs';
import { createReaderDiagnostic } from './reader-diagnostics.mjs';
import { guardReaderClient } from './reader-protocol.mjs';

process.env.KAKAO_DEBUG_LOCO='0';
let session=null,started=false,operationTimer=null,operationBusy=false,diagnostic=null,ending=false;
const stop=(reason='closed')=>{diagnostic?.end(reason);session?.close();process.exit(0);};
process.once('disconnect',()=>stop('parent-disconnected'));
process.once('uncaughtException',error=>{diagnostic?.end('fatal',error);process.exit(4);});
process.once('unhandledRejection',error=>{diagnostic?.end('unhandled-rejection',error);process.exit(5);});
function send(message) {
  if(!process.connected)return;
  if(message.type==='reader-failed'){
    if(ending)return;ending=true;
    diagnostic?.note('failed',{stage:message.stage,status:message.status});diagnostic?.end('session-failed');
    const fallback=setTimeout(()=>stop('send-timeout'),1000);fallback.unref();
    process.send(message,()=>{clearTimeout(fallback);stop('session-failed');});
  }else process.send(message);
}
function bound(ms=20000){clearTimeout(operationTimer);operationTimer=setTimeout(()=>{diagnostic?.end('operation-deadline');process.exit(3);},ms);}
process.on('message',async message=>{
  if(message?.type==='reader-close'){stop();return;}
  if(message?.type==='reader-start' && !started){
    started=true;diagnostic=createReaderDiagnostic();operationBusy=true;bound();
    try {
      const credential=message.credential;
      if(typeof credential?.accessToken!=='string' || typeof credential?.userId!=='string' || typeof credential?.deviceUUID!=='string')throw new Error('credential_shape');
      checkPinnedSource({workingCopy:true});
      const sdk=await import('../../local-only/spikes/modern/src/kakao/forge-protocol.ts');
      const messaging=message.messaging===true;
      const photoTransport=message.photoTransport ?? 'loco';
      if(!['loco','https-experimental'].includes(photoTransport))throw new Error('invalid_photo_transport');
      const guard=Client=>guardReaderClient(Client,diagnostic,{messaging});
      const Booking=guard(sdk.BookingClient),Ticket=guard(sdk.TicketClient),Carriage=guard(sdk.CarriageClient);
      const Media=guardReaderClient(sdk.CarriageClient,diagnostic,{messaging,media:true});
      const sessionSalt=typeof message.sessionSalt==='string' && /^[a-f0-9]{64}$/.test(message.sessionSalt)?Buffer.from(message.sessionSalt,'hex'):undefined;
      const settingsSecret=typeof message.settingsSecret==='string' && /^[a-f0-9]{64}$/.test(message.settingsSecret)?Buffer.from(message.settingsSecret,'hex'):null;
      session=createReaderSession(credential,{booking:()=>new Booking(),ticket:()=>new Ticket(),carriage:()=>new Carriage(),media:()=>new Media(),toLong:sdk.toLong,messaging,photoTransport,sessionSalt,settingsSecret,gapProbe:message.gapProbe===true,readProbe:true,observeRead:details=>diagnostic.note('read-verification',details),observeHistory:details=>diagnostic.note('history-page',details),observeUpload:details=>diagnostic.note('photo-upload',details),observeSend:details=>diagnostic.note('send-stage',details)},event=>{
        send(event);
      });
      await session.start();clearTimeout(operationTimer);operationBusy=false;
    }catch(error){diagnostic?.end('startup-fault',error);send({type:'reader-failed',stage:'worker',status:null});}
    return;
  }
  if(message?.type==='reader-view' && session && roomKeyValid(message.key)){session.view(message.key);return;}
  if(message?.type==='reader-history' && session && roomKeyValid(message.key) && Number.isSafeInteger(message.requestId)){
    if(operationBusy){send({type:'reader-request-rejected',key:message.key,requestId:message.requestId});return;}
    operationBusy=true;bound();
    const accepted=await session.history(message.key,message.requestId);clearTimeout(operationTimer);
    operationBusy=false;
    if(!accepted)send({type:'reader-request-rejected',key:message.key,requestId:message.requestId});
  }
  if(message?.type==='reader-action' && session && roomKeyValid(message.key) && Number.isSafeInteger(message.requestId)){
    if(operationBusy){send({type:'reader-request-rejected',key:message.key,requestId:message.requestId});return;}
    operationBusy=true;bound(message.action==='photo'?70000:24000);
    const accepted=await session.action(message.key,message.requestId,message.action,message.payload);
    clearTimeout(operationTimer);operationBusy=false;
    if(!accepted)send({type:'reader-request-rejected',key:message.key,requestId:message.requestId});
  }
});
send({type:'reader-ready'});
