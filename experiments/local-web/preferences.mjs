import { createHmac,randomBytes } from 'node:crypto';
import { existsSync,lstatSync,readFileSync,writeFileSync,renameSync,unlinkSync,openSync,writeSync,fsyncSync,closeSync,rmSync } from 'node:fs';
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
export function createPreferenceStore({folder=null,asyncSecurity=false,secureFolder=asyncSecurity?ensurePrivateDirectoryAsync:securePreferenceFolder,verifyFile=null}={}){
  const base=folder?resolve(folder):null;let secret=randomBytes(32),loaded=false,secured=false,keyError=false;
  const verifier=verifyFile ?? ([securePreferenceFolder,ensurePrivateDirectoryAsync].includes(secureFolder)?(asyncSecurity?verifyPrivateFileAsync:verifyPrivateFile):null);
  function run(generator){
    if(asyncSecurity)return (async()=>{let step=generator.next();while(!step.done){try{step=generator.next(await step.value);}catch(error){step=generator.throw(error);}}return step.value;})();
    let step=generator.next();while(!step.done){try{if(step.value?.then)throw new Error('async_security_required');step=generator.next(step.value);}catch(error){step=generator.throw(error);}}return step.value;
  }
  function enqueue(operation){
    if(!asyncSecurity)return run(operation());
    const name=base ?? operation,previous=queues.get(name) ?? Promise.resolve();
    const result=previous.then(()=>run(operation())),tail=result.catch(()=>{});queues.set(name,tail);
    void tail.then(()=>{if(queues.get(name)===tail)queues.delete(name);});return result;
  }
  function* check(path){
    try{
      regular(path);const before=existsSync(path)?lstatSync(path):null;
      if(verifier)yield verifier(path);
      regular(path);const after=existsSync(path)?lstatSync(path):null;
      if(Boolean(before)!==Boolean(after) || before && ['dev','ino','size','mtimeMs','ctimeMs'].some(key=>before[key]!==after[key]))throw new Error('settings_file_changed');
    }catch(cause){const error=new Error('settings_security',{cause});error.code='settings_security';throw error;}
  }
  function* loadKey(){
    if(loaded)return;
    try{
      if(!base || !existsSync(base))return;
      yield secureFolder(base);secured=true;
      const path=join(base,'identity.key');yield* check(path);
      if(existsSync(path)){const data=readFileSync(path);if(data.length!==32)throw new Error('settings_key');secret=data;}
    }finally{loaded=true;}
  }
  // The target was verified by load() in the same commit; rename replaces it with a new file from the private folder.
  function write(path,data){
    regular(path);const temp=`${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,fd=openSync(temp,'wx',0o600);
    try{try{writeSync(fd,data);fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,path);}catch(error){rmSync(temp,{force:true});throw error;}
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
      function commit(change,reset=false,{isCurrent=()=>true}={}){return enqueue(function*(){
        const current=()=>{if(closed || !isCurrent())throw new Error('settings_stale');};
        try{
          current();let latest=state;if(!corrupt && !keyError)try{latest=(yield* load(path))?.state ?? state;}catch(failure){if(failure.code==='settings_security')throw failure;corrupt=true;}
          current();const next=change(latest);
          if(next.persist){
            if(!base || keyError)throw new Error('settings_unavailable');
            if(!secured){yield secureFolder(base);current();secured=true;}
            const keyPath=join(base,'identity.key');yield* check(keyPath);current();
            if(existsSync(keyPath)){if(!readFileSync(keyPath).equals(secret))throw new Error('settings_key_changed');}
            else writeFileSync(keyPath,secret,{mode:0o600,flag:'wx'});
            if(corrupt && existsSync(path)){yield* check(path);current();renameSync(path,`${path}.corrupt-${Date.now()}`);}corrupt=false;
            const {rooms,...settings}=next;write(path,JSON.stringify({version:1,settings,rooms})+'\n');
          }else if(path && existsSync(path) && (!corrupt || reset)){yield* check(path);current();unlinkSync(path);corrupt=false;}
          state=next;error=corrupt;return true;
        }catch{if(!closed)error=true;return false;}
      });}
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
