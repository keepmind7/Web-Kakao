import { createHmac,randomBytes } from 'node:crypto';
import { existsSync,lstatSync,mkdirSync,readFileSync,writeFileSync,renameSync,unlinkSync,chmodSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { execFileSync } from 'node:child_process';

const defaults=()=>({persist:false,notifications:false,readSync:false,roomFilter:'all',rooms:{}});
const plain=value=>value && typeof value==='object' && !Array.isArray(value);
export const preferenceId=(secret,...parts)=>createHmac('sha256',secret).update(JSON.stringify(parts)).digest('hex');
export function validSettings(patch){return plain(patch) && Object.keys(patch).length>0 && Object.entries(patch).every(([key,value])=>['persist','notifications','readSync'].includes(key)?typeof value==='boolean':key==='roomFilter' && ['all','unread','pinned'].includes(value));}
export function validRoomSettings(patch){return plain(patch) && Object.keys(patch).length>0 && Object.entries(patch).every(([key,value])=>key==='title'?(value===null || typeof value==='string' && value.trim() && [...value.trim()].length<=120 && !/[\u0000-\u001f\u007f]/u.test(value)):key==='pinOrder'?(value===null || Number.isSafeInteger(value) && value>=0 && value<=100000):key==='muted' && typeof value==='boolean');}
function regular(path){if(existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()))throw new Error('settings_path');}
export function securePreferenceFolder(folder){
  if(existsSync(folder) && (!lstatSync(folder).isDirectory() || lstatSync(folder).isSymbolicLink()))throw new Error('settings_path');
  mkdirSync(folder,{recursive:true,mode:0o700});
  if(process.platform==='win32'){
    const output=execFileSync('whoami.exe',['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true,timeout:3000});
    const sid=output.match(/S-1-(?:\d+-)*\d+/)?.[0];if(!sid)throw new Error('settings_acl');
    execFileSync('icacls.exe',[folder,'/inheritance:r','/grant:r','*'+sid+':(OI)(CI)F'],{stdio:'ignore',windowsHide:true,timeout:3000});
  }else chmodSync(folder,0o700);
}
// Settings and an installation HMAC key only. No raw account/room identifiers.
export function createPreferenceStore({folder=null,secureFolder=securePreferenceFolder}={}){
  const base=folder?resolve(folder):null;let secret=randomBytes(32),loaded=false,secured=false,keyError=false;
  function loadKey(){
    if(loaded)return;loaded=true;
    if(!base || !existsSync(base))return;
    secureFolder(base);secured=true;
    const path=join(base,'identity.key');regular(path);
    if(existsSync(path)){const data=readFileSync(path);if(data.length!==32)throw new Error('settings_key');secret=data;}
  }
  function write(path,data){
    regular(path);const temp=path+'.tmp';regular(temp);
    writeFileSync(temp,data,{mode:0o600});renameSync(temp,path);
  }
  return {
    account(userId){
      if(typeof userId!=='string' || !/^[1-9]\d{0,29}$/.test(userId))throw new Error('settings_identity');
      try{loadKey();}catch{keyError=true;}
      const id=preferenceId(secret,'account',userId),path=base?join(base,id+'.json'):null;
      let state=defaults(),error=keyError;
      try{
        if(!keyError && path && existsSync(path)){
          regular(path);if(lstatSync(path).size>1024*1024)throw new Error('settings_size');
          const raw=JSON.parse(readFileSync(path,'utf8'));
          if(raw.version!==1 || !validSettings(raw.settings) || !plain(raw.rooms) || Object.keys(raw.rooms).length>500)throw new Error('settings_shape');
          for(const [key,value] of Object.entries(raw.rooms))if(!/^[a-f0-9]{64}$/.test(key) || !validRoomSettings(value))throw new Error('settings_room');
          state={...defaults(),...raw.settings,persist:true,rooms:raw.rooms};
        }
      }catch{error=true;}
      function commit(next){
        try{
          if(next.persist){
            if(!base || keyError)throw new Error('settings_unavailable');
            if(!secured){secureFolder(base);secured=true;}
            const keyPath=join(base,'identity.key');regular(keyPath);
            if(existsSync(keyPath)){if(!readFileSync(keyPath).equals(secret))throw new Error('settings_key_changed');}
            else writeFileSync(keyPath,secret,{mode:0o600,flag:'wx'});
            const {rooms,...settings}=next;write(path,JSON.stringify({version:1,settings,rooms})+'\n');
          }else if(path && existsSync(path)){regular(path);unlinkSync(path);}
          state=next;error=false;return true;
        }catch{error=true;return false;}
      }
      return {
        key:()=>Buffer.from(secret),
        snapshot(){const {rooms,...settings}=state;return {...settings,storageAvailable:Boolean(base)&&!keyError,storageError:error};},
        room:key=>({...state.rooms[key]}),
        set(patch){if(!validSettings(patch))return false;return commit({...state,...patch});},
        setRoom(key,patch){
          if(!/^[a-f0-9]{64}$/.test(key) || !validRoomSettings(patch) || !state.rooms[key] && Object.keys(state.rooms).length>=500)return false;
          const value={...state.rooms[key],...patch};if(typeof value.title==='string')value.title=value.title.trim();
          return commit({...state,rooms:{...state.rooms,[key]:value}});
        },
        forget(){return commit(defaults());},
        close(){state=defaults();},
      };
    },
  };
}
