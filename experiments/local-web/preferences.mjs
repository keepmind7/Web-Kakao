import { createHmac,randomBytes } from 'node:crypto';
import { existsSync,lstatSync,readdirSync,readFileSync,renameSync,unlinkSync,openSync,fstatSync,writeSync,fsyncSync,closeSync,rmSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { ensurePrivateDirectory,verifyPrivateFile,ensurePrivateDirectoryAsync,verifyPrivateFileAsync } from './private-storage.mjs';

const defaults=()=>({persist:false,notifications:false,readSync:false,roomFilter:'all',rooms:{}});
const plain=value=>value && typeof value==='object' && !Array.isArray(value);
export const preferenceId=(secret,...parts)=>createHmac('sha256',secret).update(JSON.stringify(parts)).digest('hex');
export function validSettings(patch){return plain(patch) && Object.keys(patch).length>0 && Object.entries(patch).every(([key,value])=>['persist','notifications','readSync'].includes(key)?typeof value==='boolean':key==='roomFilter' && ['all','unread','pinned'].includes(value));}
export function validRoomSettings(patch){return plain(patch) && Object.keys(patch).length>0 && Object.entries(patch).every(([key,value])=>key==='title'?(value===null || typeof value==='string' && value.trim() && [...value.trim()].length<=120 && !/[\u0000-\u001f\u007f]/u.test(value)):key==='pinOrder'?(value===null || Number.isSafeInteger(value) && value>=0 && value<=100000):key==='muted' && typeof value==='boolean');}
function regular(path){if(existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()))throw new Error('settings_path');}
export function securePreferenceFolder(folder){
  return ensurePrivateDirectory(folder);
}
// Settings and an installation HMAC key only. No raw account/room identifiers.
const queues=new Map();
const QUEUE_LIMIT=64;
export function createPreferenceStore({folder=null,asyncSecurity=false,secureFolder=asyncSecurity?ensurePrivateDirectoryAsync:securePreferenceFolder,verifyFile=null}={}){
  const base=folder?resolve(folder):null;let secret=randomBytes(32),loaded=false,keyError=false;
  const verifier=verifyFile ?? ([securePreferenceFolder,ensurePrivateDirectoryAsync].includes(secureFolder)?(asyncSecurity?verifyPrivateFileAsync:verifyPrivateFile):null);
  function run(generator){
    if(asyncSecurity)return (async()=>{let step=generator.next();while(!step.done){try{step=generator.next(await step.value);}catch(error){step=generator.throw(error);}}return step.value;})();
    let step=generator.next();while(!step.done){try{if(step.value?.then)throw new Error('async_security_required');step=generator.next(step.value);}catch(error){step=generator.throw(error);}}return step.value;
  }
  function enqueue(operation,onBusy){
    if(!asyncSecurity)return run(operation());
    const name=base ?? operation;
    let queue=queues.get(name);
    if(!queue){queue={pending:0,tail:Promise.resolve()};queues.set(name,queue);}
    // Count running and waiting work together, across stores for this folder.
    // Do not race or skip an admitted security check to recover capacity.
    if(queue.pending>=QUEUE_LIMIT)return onBusy?onBusy():Promise.reject(Object.assign(new Error('settings_busy'),{code:'settings_busy'}));
    queue.pending++;
    const result=queue.tail.then(()=>run(operation())).finally(()=>{
      queue.pending--;
      if(!queue.pending && queues.get(name)===queue)queues.delete(name);
    });
    queue.tail=result.catch(()=>{});return result;
  }
  function* check(path){
    try{
      regular(path);const before=existsSync(path)?lstatSync(path):null;
      if(verifier && (yield verifier(path))===false && before)throw new Error('settings_file_unverified');
      regular(path);const after=existsSync(path)?lstatSync(path):null;
      if(Boolean(before)!==Boolean(after) || before && ['dev','ino','size','mtimeMs','ctimeMs'].some(key=>before[key]!==after[key]))throw new Error('settings_file_changed');
    }catch(cause){const error=new Error('settings_security',{cause});error.code='settings_security';throw error;}
  }
  function* loadKey(){
    if(loaded)return;
    try{
      if(!base || !existsSync(base))return;
      yield secureFolder(base);
      const path=join(base,'identity.key');yield* check(path);
      if(existsSync(path)){const data=readFileSync(path);if(data.length!==32)throw new Error('settings_key');secret=data;}
    }finally{loaded=true;}
  }
  // Check a new file before placing private bytes in it, then verify the finished
  // inode before publishing it. Windows mode0600 alone does not set a private ACL.
  function* write(path,data,current,{createOnly=false}={}){
    regular(path);
    const temp=createOnly?path:`${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,fd=openSync(temp,'wx',0o600);
    let open=true,created;
    const owned=()=>{regular(temp);const info=lstatSync(temp);if(!created || info.dev!==created.dev || info.ino!==created.ino)throw new Error('settings_file_changed');};
    try{
      created=fstatSync(fd);
      yield* check(temp);current();owned();
      const bytes=Buffer.isBuffer(data)?data:Buffer.from(data,'utf8');
      for(let offset=0;offset<bytes.length;){
        const written=writeSync(fd,bytes,offset,bytes.length-offset,null);
        if(!Number.isSafeInteger(written) || written<=0 || written>bytes.length-offset)throw new Error('settings_write');
        offset+=written;
      }
      fsyncSync(fd);closeSync(fd);open=false;
      yield* check(temp);current();owned();
      if(!createOnly)renameSync(temp,path);
    }catch(error){
      try{if(open)closeSync(fd);}finally{
        // Never remove a replacement that did not originate from this operation.
        try{owned();rmSync(temp,{force:true});}catch{}
      }
      throw error;
    }
  }
  // null when absent; throws when the file itself is damaged. A damaged room entry drops only that room.
  function* load(path){
    if(!path || !existsSync(path))return null;
    yield* check(path);if(lstatSync(path).size>1024*1024)throw new Error('settings_size');
    const raw=JSON.parse(readFileSync(path,'utf8'));
    if(raw.version!==1 || !validSettings(raw.settings) || !plain(raw.rooms) || Object.keys(raw.rooms).length>500)throw new Error('settings_shape');
    const rooms=Object.fromEntries(Object.entries(raw.rooms).filter(([key,value])=>/^[a-f0-9]{64}$/.test(key) && validRoomSettings(value)));
    return {state:{...defaults(),...raw.settings,persist:true,rooms},dropped:Object.keys(rooms).length!==Object.keys(raw.rooms).length};
  }
  return {
    account(userId){return enqueue(function*(){
      if(typeof userId!=='string' || !/^[1-9]\d{0,29}$/.test(userId))throw new Error('settings_identity');
      try{yield* loadKey();}catch{keyError=true;}
      const id=preferenceId(secret,'account',userId),path=base?join(base,id+'.json'):null;
      // A damaged file is never overwritten or deleted implicitly: the next persistent write first renames it to
      // .corrupt-<time> in the same private folder (a failed rename keeps writes blocked); only forget() deletes it.
      let state=defaults(),error=keyError,corrupt=false,closed=false;
      if(!keyError)try{const disk=yield* load(path);if(disk){state=disk.state;error=disk.dropped;}}catch{error=corrupt=true;}
      // Each change is applied to the file as it is now, so another store's earlier changes survive.
      // ponytail: no cross-process lock; two servers writing one account within the same instant can still race.
      function commit(change,reset=false,{isCurrent=()=>true}={}){
        if(closed)return false;
        return enqueue(function*(){
        const current=()=>{if(closed || !isCurrent())throw new Error('settings_stale');};
        try{
          // A damaged installation key cannot identify this account's files.
          // Do not report a successful deletion in a random temporary namespace.
          if(reset && keyError)throw new Error('settings_identity_unavailable');
          current();let latest=state;if(!corrupt && !keyError)try{latest=(yield* load(path))?.state ?? state;}catch(failure){if(failure.code==='settings_security')throw failure;corrupt=true;}
          current();const next=change(latest);
          if(next.persist){
            if(!base || keyError)throw new Error('settings_unavailable');
            // Folder inheritance may change while the store remains alive.
            // Recheck before every persistent commit; successful ACLs are not cached.
            yield secureFolder(base);current();
            const keyPath=join(base,'identity.key');yield* check(keyPath);current();
            if(existsSync(keyPath)){if(!readFileSync(keyPath).equals(secret))throw new Error('settings_key_changed');}
            else yield* write(keyPath,secret,current,{createOnly:true});
            if(corrupt && existsSync(path)){yield* check(path);current();renameSync(path,`${path}.corrupt-${Date.now()}`);}corrupt=false;
            const {rooms,...settings}=next;yield* write(path,JSON.stringify({version:1,settings,rooms})+'\n',current);
          }else if(path && existsSync(path) && (!corrupt || reset)){yield* check(path);current();unlinkSync(path);corrupt=false;}
          if(reset && base && existsSync(base)){
            // Only this account's exact backup namespace belongs to forget().
            // Validate each file before unlinking; no recursive deletion or key removal.
            const prefix=id+'.json.corrupt-';
            for(const name of readdirSync(base))if(name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length))){
              const backup=join(base,name);yield* check(backup);current();unlinkSync(backup);
            }
          }
          state=next;error=corrupt;return true;
        }catch{if(!closed)error=true;return false;}
      },()=>{error=true;return false;});}
      return {
        key:()=>Buffer.from(secret),
        snapshot(){const {rooms,...settings}=state;return {...settings,storageAvailable:Boolean(base)&&!keyError,storageError:error};},
        room:key=>({...state.rooms[key]}),
        set(patch,options){if(!validSettings(patch))return false;return commit(current=>({...current,...patch}),false,options);},
        setRoom(key,patch,options){
          if(!/^[a-f0-9]{64}$/.test(key) || !validRoomSettings(patch) || !state.rooms[key] && Object.keys(state.rooms).length>=500)return false;
          return commit(current=>{if(!current.rooms[key] && Object.keys(current.rooms).length>=500)throw new Error('settings_capacity');const value={...current.rooms[key],...patch};if(typeof value.title==='string')value.title=value.title.trim();return {...current,rooms:{...current.rooms,[key]:value}};},false,options);
        },
        forget(options){return commit(defaults,true,options);},
        close(){closed=true;state=defaults();},
      };
    });},
  };
}
