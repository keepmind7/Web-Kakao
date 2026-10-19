import { createHmac,randomBytes,timingSafeEqual } from 'node:crypto';
export const localControlFields=['build','preferences','gapProbe','messaging','photoTransport','outboxRecovery','viewPin','mode','phase','stage','httpStatus','apiStatus','qrIssued','credentialInMemory','actualChatConnected','chatConnectionActive','actualMessageSent','canStart','canProbe','attempts','sessionBlocked'];
export function localControlStatus(snapshot){return Object.fromEntries(localControlFields.filter(key=>Object.hasOwn(snapshot,key)).map(key=>[key,snapshot[key]]));}
export function createLocalAccess({controlToken=randomBytes(32).toString('hex'),now=Date.now}={}) {
  if(typeof controlToken!=='string' || !/^[a-f0-9]{64}$/.test(controlToken))throw new Error('invalid_local_control');
  // Browser session travels only in a same-origin header; cookies are not port-scoped.
  const tickets=new Map(),session=randomBytes(32).toString('hex');
  const equal=(a,b)=>typeof a==='string' && /^[a-f0-9]{64}$/.test(a) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
  const mac=(key,label,value)=>createHmac('sha256',key).update(label+'\0'+value).digest('hex');
  const prune=()=>{for(const [ticket,expiry] of tickets)if(expiry<=now())tickets.delete(ticket);};
  return {controlToken,control:value=>equal(value,controlToken),authenticated:value=>equal(value,session),
    // Launcher challenge: proves knowledge of the control token without the launcher sending it first.
    prove:nonce=>typeof nonce==='string' && /^[a-f0-9]{64}$/.test(nonce)?mac(controlToken,'web-kakao-launcher-challenge',nonce):null,
    // <img> cannot send headers; a per-photo capability bound to this session replaces the cookie.
    photoCapability:(room,message,index)=>mac(session,'web-kakao-photo',room+':'+message+':'+index),
    photoAuthorized(cap,room,message,index){return equal(cap,this.photoCapability(room,message,index));},
    issue(){prune();if(tickets.size>=8)return null;const ticket=randomBytes(32).toString('hex');tickets.set(ticket,now()+60000);return ticket;},
    exchange(ticket){prune();if(typeof ticket!=='string' || !tickets.has(ticket))return null;tickets.delete(ticket);return session;},
  };
}
