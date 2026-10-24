// Runtime selection only; every helper process is intercepted, no tool runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ensurePrivateDirectoryAsync} from '../experiments/local-web/private-storage.mjs';
const require=createRequire(import.meta.url),fs=require('node:fs'),cp=require('node:child_process');
for(const hint of ['C:\\SyntheticPython313\\python.exe',null])test(hint?'uses the launcher Python when the bundle is absent':'standalone fallback accepts a compatible Python3 instead of pinning3.11',{skip:process.platform!=='win32'},async()=>{
 const directory=fs.mkdtempSync(join(tmpdir(),'p-')),originalExists=fs.existsSync,originalExec=cp.execFile,previous=process.env.WEB_KAKAO_PYTHON,calls=[];
 if(hint)process.env.WEB_KAKAO_PYTHON=hint;else delete process.env.WEB_KAKAO_PYTHON;
 fs.existsSync=path=>String(path).includes('cpython-3.13.7-windows-x86_64-none')?false:String(path)===hint?true:originalExists(path);
 cp.execFile=(command,args,_options,done)=>{calls.push({command,args});queueMicrotask(()=>done(null,'true'));};syncBuiltinESMExports();
 try{
  await ensurePrivateDirectoryAsync(directory);assert.equal(calls.length,1);
  assert.equal(calls[0].command,hint??'py.exe');
  if(!hint){assert.equal(calls[0].args[0],'-3');assert.equal(calls[0].args.includes('-3.11'),false);}
  assert.ok(calls[0].args.includes('-I'));assert.ok(calls[0].args.some(value=>value.endsWith('windows_security.py')));
 }finally{fs.existsSync=originalExists;cp.execFile=originalExec;syncBuiltinESMExports();if(previous===undefined)delete process.env.WEB_KAKAO_PYTHON;else process.env.WEB_KAKAO_PYTHON=previous;fs.rmSync(directory,{recursive:true,force:true});}
});
