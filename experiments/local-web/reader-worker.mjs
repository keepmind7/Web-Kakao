import { checkPinnedSource } from './kakao-auth.mjs';
import { createReaderSession } from './reader-session.mjs';
import { roomKeyValid } from './reader-data.mjs';
import { createReaderDiagnostic } from './reader-diagnostics.mjs';
import { guardReaderClient } from './reader-protocol.mjs';

process.env.KAKAO_DEBUG_LOCO='0';
let session=null,started=false,operationTimer=null,operationBusy=false,diagnostic=null,ending=false;
const lifetime=setTimeout(()=>{diagnostic?.end('lifetime');process.exit(2);},60*60*1000);lifetime.unref();
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
function bound(){clearTimeout(operationTimer);operationTimer=setTimeout(()=>{diagnostic?.end('operation-deadline');process.exit(3);},20000);}
process.on('message',async message=>{
  if(message?.type==='reader-close'){stop();return;}
  if(message?.type==='reader-start' && !started){
    started=true;diagnostic=createReaderDiagnostic();operationBusy=true;bound();
    try {
      const credential=message.credential;
      if(typeof credential?.accessToken!=='string' || typeof credential?.userId!=='string' || typeof credential?.deviceUUID!=='string')throw new Error('credential_shape');
      checkPinnedSource({workingCopy:true});
      const sdk=await import('../../local-only/spikes/modern/src/kakao/forge-protocol.ts');
      const guard=Client=>guardReaderClient(Client,diagnostic);
      const Booking=guard(sdk.BookingClient),Ticket=guard(sdk.TicketClient),Carriage=guard(sdk.CarriageClient);
      session=createReaderSession(credential,{booking:()=>new Booking(),ticket:()=>new Ticket(),carriage:()=>new Carriage(),toLong:sdk.toLong,gapProbe:message.gapProbe===true,observeHistory:details=>diagnostic.note('history-page',details)},event=>{
        send(event);
      });
      await session.start();clearTimeout(operationTimer);operationBusy=false;
    }catch(error){diagnostic?.end('startup-fault',error);send({type:'reader-failed',stage:'worker',status:null});}
    return;
  }
  if(message?.type==='reader-history' && session && roomKeyValid(message.key) && Number.isSafeInteger(message.requestId)){
    if(operationBusy){send({type:'reader-request-rejected',requestId:message.requestId});return;}
    operationBusy=true;bound();
    const accepted=await session.history(message.key,message.requestId);clearTimeout(operationTimer);
    operationBusy=false;
    if(!accepted)send({type:'reader-request-rejected',requestId:message.requestId});
  }
});
send({type:'reader-ready'});
