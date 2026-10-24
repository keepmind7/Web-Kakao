import {existsSync} from 'node:fs';
import {join,resolve,isAbsolute} from 'node:path';
import {execFileSync,execFile} from 'node:child_process';

function helper(project,action,path,maxBytes){
  const bundled=join(project,'local-only/runtime/python/cpython-3.13.7-windows-x86_64-none/python.exe');
  const hinted=process.env.WEB_KAKAO_PYTHON || null;
  if(hinted && (!isAbsolute(hinted) || !existsSync(hinted)))throw new Error('private_python_path');
  const command=hinted ?? (existsSync(bundled)?bundled:'py.exe');
  // Keep the established Windows backend and launcher-selected Python intact.
  const args=[...(command==='py.exe'?['-3']:[]),'-I','-B','-X','utf8',join(project,'tools/windows_security.py'),action,resolve(path)];
  if(maxBytes!==undefined)args.push('--max-bytes',String(maxBytes));
  return {command,args};
}
const options={encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:4096};
function result(value){const parsed=JSON.parse(value);if(typeof parsed!=='boolean')throw new Error('private_acl');return parsed;}
export function nativeSync(project,action,path,maxBytes){
  const {command,args}=helper(project,action,path,maxBytes);
  return result(execFileSync(command,args,{...options,stdio:['ignore','pipe','pipe']}));
}
export function nativeAsync(project,action,path,maxBytes){
  const {command,args}=helper(project,action,path,maxBytes);
  return new Promise((resolvePromise,reject)=>execFile(command,args,options,(error,stdout)=>{if(error)return reject(new Error('private_acl'));try{resolvePromise(result(stdout));}catch{reject(new Error('private_acl'));}}));
}
