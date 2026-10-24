import {createHash} from 'node:crypto';
import {win32,posix,dirname} from 'node:path';
import {lstatSync} from 'node:fs';

export function privateDataPath({projectRoot,localAppData=process.env.LOCALAPPDATA,platform=process.platform,home=process.env.HOME,xdgDataHome=process.env.XDG_DATA_HOME}={}){
  const windows=platform==='win32' || platform==='Windows',linux=platform==='linux' || platform==='Linux',mac=platform==='darwin' || platform==='Darwin';
  if(!windows && !linux && !mac)throw new Error('private_data_platform');
  const path=windows?win32:posix;
  const root=windows?path.resolve(projectRoot).replaceAll('\\','/').toLowerCase():path.resolve(projectRoot);
  let base;
  if(windows){if(!localAppData)throw new Error('private_data_location');base=path.resolve(localAppData);}
  else{
    if((mac || !xdgDataHome || !posix.isAbsolute(xdgDataHome)) && (!home || !posix.isAbsolute(home)))throw new Error('private_data_location');
    base=mac?posix.join(home,'Library','Application Support'):xdgDataHome && posix.isAbsolute(xdgDataHome)?xdgDataHome:posix.join(home,'.local','share');
  }
  const install=createHash('sha256').update(root,'utf8').digest('hex').slice(0,16);
  return path.join(base,'WebKakao',install);
}

export function ancestors(target){
  for(let current=target;;current=dirname(current)){
    try{const info=lstatSync(current);if(info.isSymbolicLink() || !info.isDirectory())throw new Error('private_data_path');}catch(error){if(error.code!=='ENOENT')throw error;}
    if(dirname(current)===current)break;
  }
}

export function fileInfo(path,maxBytes){
  let info;try{info=lstatSync(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(!info.isFile() || info.isSymbolicLink() || !Number.isSafeInteger(maxBytes) || maxBytes<0 || info.size>maxBytes)throw new Error('private_file_path');
  ancestors(dirname(path));return info;
}

export const sameEntry=(left,right,keys=['dev','ino','uid','mode'])=>Boolean(left && right) && keys.every(key=>left[key]===right[key]);
