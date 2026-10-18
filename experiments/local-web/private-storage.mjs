import { createHash } from 'node:crypto';
import { mkdirSync,lstatSync,chmodSync,existsSync } from 'node:fs';
import { resolve,join,dirname,isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync,execFile } from 'node:child_process';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'../..');

// Path computation is deliberately free of filesystem and process operations.
export function privateDataRoot({projectRoot=project,localAppData=process.env.LOCALAPPDATA}={}) {
  if(!localAppData)throw new Error('private_data_location');
  const install=createHash('sha256').update(resolve(projectRoot).replaceAll('\\','/').toLowerCase(),'utf8').digest('hex').slice(0,16);
  return join(resolve(localAppData),'WebKakao',install);
}
function ancestors(target){
  for(let current=target;;current=dirname(current)){
    try{const info=lstatSync(current);if(info.isSymbolicLink() || !info.isDirectory())throw new Error('private_data_path');}catch(error){if(error.code!=='ENOENT')throw error;}
    if(dirname(current)===current)break;
  }
}
function fileInfo(path,maxBytes){
  let info;try{info=lstatSync(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(!info.isFile() || info.isSymbolicLink() || info.size>maxBytes)throw new Error('private_file_path');
  ancestors(dirname(resolve(path)));return info;
}
function helper(action,path,maxBytes){
  const bundled=join(project,'local-only/runtime/python/cpython-3.13.7-windows-x86_64-none/python.exe');
  const hinted=process.env.WEB_KAKAO_PYTHON || null;
  if(hinted && (!isAbsolute(hinted) || !existsSync(hinted)))throw new Error('private_python_path');
  const command=hinted ?? (existsSync(bundled)?bundled:'py.exe');
  // The launcher supplies its >=3.11 interpreter. Direct Node usage can select
  // an installed Python3; the helper itself refuses versions below3.11.
  const args=[...(command==='py.exe'?['-3']:[]),'-I','-B','-X','utf8',join(project,'tools/windows_security.py'),action,resolve(path)];
  if(maxBytes!==undefined)args.push('--max-bytes',String(maxBytes));
  return {command,args};
}
const options={encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:4096};
function result(value){const parsed=JSON.parse(value);if(typeof parsed!=='boolean')throw new Error('private_acl');return parsed;}
function nativeSync(action,path,maxBytes){const {command,args}=helper(action,path,maxBytes);return result(execFileSync(command,args,{...options,stdio:['ignore','pipe','pipe']}));}
function nativeAsync(action,path,maxBytes){
  const {command,args}=helper(action,path,maxBytes);
  return new Promise((resolvePromise,reject)=>execFile(command,args,options,(error,stdout)=>{if(error)return reject(new Error('private_acl'));try{resolvePromise(result(stdout));}catch{reject(new Error('private_acl'));}}));
}
export function ensurePrivateDirectory(folder) {
  const target=resolve(folder);ancestors(target);
  if(process.platform==='win32')nativeSync('directory',target);
  else{mkdirSync(target,{recursive:true,mode:0o700});chmodSync(target,0o700);}
  return target;
}
export async function ensurePrivateDirectoryAsync(folder) {
  const target=resolve(folder);ancestors(target);
  if(process.platform==='win32')await nativeAsync('directory',target);
  else{mkdirSync(target,{recursive:true,mode:0o700});chmodSync(target,0o700);}
  ancestors(target);return target;
}
// No successful permission result is cached, including for files we wrote.
export function verifyPrivateFile(path,{maxBytes=1024*1024}={}) {
  const info=fileInfo(path,maxBytes);if(!info)return false;
  if(process.platform==='win32')return nativeSync('file',path,maxBytes);
  if(info.mode & 0o077)throw new Error('private_file_acl');return true;
}
export async function verifyPrivateFileAsync(path,{maxBytes=1024*1024}={}) {
  const before=fileInfo(path,maxBytes);if(!before)return false;
  if(process.platform==='win32'){
    if(!await nativeAsync('file',path,maxBytes))throw new Error('private_file_changed');
    const after=fileInfo(path,maxBytes);
    if(!after || ['dev','ino','size','mtimeMs','ctimeMs'].some(key=>after[key]!==before[key]))throw new Error('private_file_changed');
  }else if(before.mode & 0o077)throw new Error('private_file_acl');
  return true;
}
