import {resolve,dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {privateDataPath,ancestors,fileInfo,sameEntry} from './platform/common.mjs';
import {nativeSync,nativeAsync} from './platform/windows.mjs';
import {ensureDirectory,verifyFile,verifyFileAsync,verifyMissingParent} from './platform/linux.mjs';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'../..');

// Pure path computation; importing this module never creates private storage.
export function privateDataRoot(options={}){
  const {projectRoot=project,...rest}=options;
  if(options.localAppData!==undefined && options.platform===undefined){
    if(!options.localAppData)throw new Error('private_data_location');
    const install=createHash('sha256').update(resolve(projectRoot).replaceAll('\\','/').toLowerCase(),'utf8').digest('hex').slice(0,16);
    return join(resolve(options.localAppData),'WebKakao',install);
  }
  return privateDataPath({projectRoot,...rest});
}
// linux.mjs holds the POSIX checks shared by Linux and macOS.
function supported(){if(!['win32','linux','darwin'].includes(process.platform))throw new Error('private_data_platform');}
export function ensurePrivateDirectory(folder){
  supported();const target=resolve(folder);ancestors(target);
  if(process.platform==='win32')nativeSync(project,'directory',target);
  else ensureDirectory(target);
  return target;
}
export async function ensurePrivateDirectoryAsync(folder){
  supported();const target=resolve(folder);ancestors(target);
  if(process.platform==='win32')await nativeAsync(project,'directory',target);
  else ensureDirectory(target);
  ancestors(target);return target;
}
// No successful permission result is cached, including for files we wrote.
export function verifyPrivateFile(path,{maxBytes=1024*1024}={}){
  supported();path=resolve(path);const info=fileInfo(path,maxBytes);if(!info)return process.platform!=='win32'?verifyMissingParent(path):false;
  return process.platform==='win32'?nativeSync(project,'file',path,maxBytes):verifyFile(path,info,maxBytes);
}
export async function verifyPrivateFileAsync(path,{maxBytes=1024*1024}={}){
  supported();path=resolve(path);const before=fileInfo(path,maxBytes);if(!before)return process.platform!=='win32'?verifyMissingParent(path):false;
  if(process.platform==='win32'){
    if(!await nativeAsync(project,'file',path,maxBytes))throw new Error('private_file_changed');
    const after=fileInfo(path,maxBytes);
    if(!sameEntry(before,after,['dev','ino','size','mtimeMs','ctimeMs']))throw new Error('private_file_changed');
    return true;
  }
  return verifyFileAsync(path,before,maxBytes);
}
