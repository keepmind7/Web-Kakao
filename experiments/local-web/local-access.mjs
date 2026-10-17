import { randomBytes,timingSafeEqual } from 'node:crypto';
export const localControlFields=['build','preferences','gapProbe','messaging','outboxRecovery','viewPin','mode','phase','stage','httpStatus','apiStatus','qrIssued','credentialInMemory','actualChatConnected','chatConnectionActive','actualMessageSent','canStart','canProbe','attempts','sessionBlocked'];
export function localControlStatus(snapshot){return Object.fromEntries(localControlFields.filter(key=>Object.hasOwn(snapshot,key)).map(key=>[key,snapshot[key]]));}
export function createLocalAccess({controlToken=randomBytes(32).toString('hex'),now=Date.now}={}) {
  if(typeof controlToken!=='string' || !/^[a-f0-9]{64}$/.test(controlToken))throw new Error('invalid_local_control');
  const tickets=new Map(),cookie=randomBytes(32).toString('hex');
  const equal=(a,b)=>typeof a==='string' && /^[a-f0-9]{64}$/.test(a) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
  const prune=()=>{for(const [ticket,expiry] of tickets)if(expiry<=now())tickets.delete(ticket);};
  return {controlToken,control:value=>equal(value,controlToken),authenticated:value=>(value??'').split(';').some(item=>item.trim()===`local_auth=${cookie}`),
    issue(){prune();if(tickets.size>=8)return null;const ticket=randomBytes(32).toString('hex');tickets.set(ticket,now()+60000);return ticket;},
    exchange(ticket){prune();if(typeof ticket!=='string' || !tickets.has(ticket))return null;tickets.delete(ticket);return `local_auth=${cookie}; HttpOnly; SameSite=Strict; Path=/`;},
  };
}
