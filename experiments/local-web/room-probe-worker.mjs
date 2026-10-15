import { allowedReadOnlyMethod, probeRoomCount } from './room-probe.mjs';
import { checkPinnedSource } from './kakao-auth.mjs';
import { normalizedResponse } from './reader-response.mjs';

process.env.KAKAO_DEBUG_LOCO = '0';
if (process.argv.includes('--self-check')) {
  // Import and method-shape check only: no credentials, client instances or
  // sockets. Exercise the exact TypeScript loader used by the real worker.
  checkPinnedSource({workingCopy:true});
  const sdk = await import('../../local-only/spikes/modern/src/kakao/forge-protocol.ts');
  const shapes = [typeof sdk.BookingClient, typeof sdk.TicketClient, typeof sdk.CarriageClient,
    typeof sdk.toLong, typeof sdk.CarriageClient.prototype.loginList];
  if (shapes.some(shape => shape !== 'function')) process.exit(1);
  console.log('room-probe worker: pinned SDK import and method shapes verified; network not invoked');
  process.exit(0);
}
// Independent bound even if the parent crashes or can no longer run its timer.
const lifetime = setTimeout(() => process.exit(2),20000);
lifetime.unref();
process.once('disconnect',() => process.exit(0));
let used = false;
process.on('message', async message => {
  if (used) return; used = true;
  if (message?.type !== 'read-only-room-count' || typeof message.credential?.accessToken !== 'string') {
    process.send?.({type:'room-probe-result',ok:false,stage:'worker'}); return;
  }
  try {
    checkPinnedSource({workingCopy:true});
    const sdk = await import('../../local-only/spikes/modern/src/kakao/forge-protocol.ts');
    const guard = Client => class extends Client {
      async request(method,...args) {
        if (!allowedReadOnlyMethod(method)) return Promise.reject(new Error('read_only_operation_required'));
        return normalizedResponse(await super.request(method,...args));
      }
    };
    const Booking = guard(sdk.BookingClient), Ticket = guard(sdk.TicketClient), Carriage = guard(sdk.CarriageClient);
    const result = await probeRoomCount(message.credential, {booking:()=>new Booking(),ticket:()=>new Ticket(),carriage:()=>new Carriage(),toLong:sdk.toLong});
    process.send?.({type:'room-probe-result',...result},()=>process.disconnect());
  } catch { process.send?.({type:'room-probe-result',ok:false,stage:'worker'},()=>process.disconnect()); }
});
process.send?.({type:'room-probe-ready'});
