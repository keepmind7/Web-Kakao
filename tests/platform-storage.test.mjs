// Pure and synthetic OS contracts. Native Linux checks are separately marked.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {join,resolve,posix} from 'node:path';
import {tmpdir} from 'node:os';
import {privateDataRoot,ensurePrivateDirectory,verifyPrivateFile} from '../experiments/local-web/private-storage.mjs';
import {checkDirectory,checkFile,ensureDirectory,verifyFile,verifyFileAsync,verifyMissingParent} from '../experiments/local-web/platform/linux.mjs';
import {nativeAsync} from '../experiments/local-web/platform/windows.mjs';
const require=createRequire(import.meta.url),fs=require('node:fs'),cp=require('node:child_process');

function info({mode=0o40700,uid=1000,ino=5,nlink=1,size=12}={}){
  return {dev:1,ino,uid,mode,nlink,size,mtimeMs:1,ctimeMs:1,
    isDirectory(){return (this.mode & 0o170000)===0o040000;},
    isFile(){return (this.mode & 0o170000)===0o100000;},
    isSymbolicLink(){return (this.mode & 0o170000)===0o120000;}};
}
function mocked(entries,body){
  const originals={lstatSync:fs.lstatSync,mkdirSync:fs.mkdirSync,openSync:fs.openSync,fstatSync:fs.fstatSync,closeSync:fs.closeSync,chmodSync:fs.chmodSync,open:fs.promises.open,getuid:process.getuid};
  const descriptors=new Map(),created=[];
  const lookup=path=>{const value=entries.get(String(path));if(!value){const error=new Error('synthetic_absent');error.code='ENOENT';throw error;}return value;};
  process.getuid=()=>1000;
  fs.lstatSync=lookup;
  fs.mkdirSync=(path,options)=>{assert.equal(options.mode,0o700);created.push(path);entries.set(path,info({ino:entries.size+1}));const parent=posix.dirname(path),before=entries.get(parent);if(before)entries.set(parent,{...before,nlink:before.nlink+1});};
  fs.openSync=path=>{const descriptor=descriptors.size+100;lookup(path);descriptors.set(descriptor,path);return descriptor;};
  fs.fstatSync=descriptor=>lookup(descriptors.get(descriptor));
  fs.closeSync=()=>{};
  fs.chmodSync=()=>{throw new Error('chmod_forbidden');};
  syncBuiltinESMExports();
  const restore=()=>{for(const key of ['lstatSync','mkdirSync','openSync','fstatSync','closeSync','chmodSync'])fs[key]=originals[key];fs.promises.open=originals.open;if(originals.getuid===undefined)delete process.getuid;else process.getuid=originals.getuid;syncBuiltinESMExports();};
  try{const result=body({created,lookup});if(result?.then)return result.finally(restore);restore();return result;}catch(error){restore();throw error;}
}
const fileEntries=()=>new Map([['/',info({mode:0o40755,uid:0,ino:1})],['/private',info({ino:2})],['/private/probe',info({mode:0o100600,ino:3})]]);

test('Windows pure path retains lexical case-folded installation identity',()=>{
  const digest=createHash('sha256').update('c:/source/synth~1/설치').digest('hex').slice(0,16);
  assert.equal(privateDataRoot({platform:'win32',projectRoot:'C:\\Source\\SYNTH~1\\설치',localAppData:'C:\\Users\\Fixture\\AppData\\Local'}),`C:\\Users\\Fixture\\AppData\\Local\\WebKakao\\${digest}`);
});
test('explicit legacy localAppData override retains the host path calculation',()=>{
  const root=resolve('SyntheticRoot'),base=resolve('SyntheticAppData');
  const digest=createHash('sha256').update(root.replaceAll('\\','/').toLowerCase()).digest('hex').slice(0,16);
  assert.equal(privateDataRoot({projectRoot:root,localAppData:base}),join(base,'WebKakao',digest));
});
test('Linux default uses HOME and keeps case-sensitive installation identities',()=>{
  const options={platform:'linux',home:'/home/fixture',xdgDataHome:''};
  const lower=privateDataRoot({...options,projectRoot:'/src/web'}),upper=privateDataRoot({...options,projectRoot:'/src/Web'});
  assert.notEqual(lower,upper);assert.ok(lower.startsWith('/home/fixture/.local/share/WebKakao/'));
});
test('Linux absolute XDG value is used and relative XDG is ignored',()=>{
  const options={platform:'linux',projectRoot:'/src/web',home:'/home/fixture'};
  assert.ok(privateDataRoot({...options,xdgDataHome:'/var/data'}).startsWith('/var/data/WebKakao/'));
  assert.ok(privateDataRoot({...options,home:'',xdgDataHome:'/var/data'}).startsWith('/var/data/WebKakao/'));
  assert.equal(privateDataRoot({...options,xdgDataHome:'relative'}),privateDataRoot({...options,xdgDataHome:''}));
});
test('macOS prepares Application Support paths without claiming execution support',()=>{
  assert.ok(privateDataRoot({platform:'darwin',projectRoot:'/src/web',home:'/Users/fixture'}).startsWith('/Users/fixture/Library/Application Support/WebKakao/'));
});
test('missing absolute HOME and unknown platforms fail closed',()=>{
  // Pin both fallback inputs; the verifier deliberately supplies an absolute
  // XDG_DATA_HOME, which legitimately permits a missing HOME in production.
  for(const options of [{platform:'linux',home:'',xdgDataHome:''},{platform:'linux',home:'relative',xdgDataHome:''},{platform:'linux',home:'',xdgDataHome:'relative'},{platform:'unknown'}])assert.throws(()=>privateDataRoot({projectRoot:'/src/web',...options}));
});
test('path computation performs no filesystem writes or subprocess calls',()=>{
  const originalMkdir=fs.mkdirSync,originalExec=cp.execFileSync;
  fs.mkdirSync=()=>{throw new Error('write_forbidden');};cp.execFileSync=()=>{throw new Error('process_forbidden');};syncBuiltinESMExports();
  try{assert.ok(privateDataRoot({platform:'linux',projectRoot:'/synthetic/absent',home:'/home/fixture'}));}finally{fs.mkdirSync=originalMkdir;cp.execFileSync=originalExec;syncBuiltinESMExports();}
});
test('root sticky ancestor is accepted while writable or foreign-owned ancestors fail',()=>{
  checkDirectory(info({mode:0o41777,uid:0}),1000);
  for(const value of [info({mode:0o40775}),info({mode:0o41777}),info({uid:2000}),info({mode:0o120700})])assert.throws(()=>checkDirectory(value,1000));
});
test('private target must have current uid and exactly0700',()=>{
  checkDirectory(info(),1000,{privateTarget:true});
  for(const value of [info({mode:0o40755}),info({mode:0o41700}),info({uid:0})])assert.throws(()=>checkDirectory(value,1000,{privateTarget:true}));
});
test('private file must be regular0600 with current owner and one link',()=>{
  checkFile(info({mode:0o100600}),1000);
  for(const value of [info({mode:0o100644}),info({mode:0o100600,uid:0}),info({mode:0o100600,nlink:2}),info({mode:0o120600}),info()])assert.throws(()=>checkFile(value,1000));
});
test('synthetic directory creation makes only missing0700 components and never chmods',()=>{
  const entries=new Map([['/',info({mode:0o40755,uid:0,ino:1})],['/tmp',info({mode:0o41777,uid:0,ino:2})]]);
  mocked(entries,({created})=>{assert.equal(ensureDirectory('/tmp/synthetic/private'),'/tmp/synthetic/private');assert.deepEqual(created,['/tmp/synthetic','/tmp/synthetic/private']);});
});
test('existing broad private target is rejected without chmod or recreation',()=>{
  const entries=fileEntries();entries.set('/private',info({mode:0o40755,ino:2}));
  mocked(entries,({created})=>{assert.throws(()=>ensureDirectory('/private'),/private_data_acl/);assert.deepEqual(created,[]);assert.equal(entries.get('/private').mode,0o40755);});
});
test('symlink and group-writable ancestor cannot host a new private directory',()=>{
  for(const mode of [0o120777,0o40775]){const entries=fileEntries();entries.set('/private',info({mode,ino:2}));mocked(entries,({created})=>{assert.throws(()=>ensureDirectory('/private/child'));assert.deepEqual(created,[]);});}
});
test('synthetic synchronous verification checks descriptor and ancestor identity',()=>{
  const entries=fileEntries();mocked(entries,()=>assert.equal(verifyFile('/private/probe',entries.get('/private/probe'),1024),true));
});
test('missing leaf still requires a private parent without link or broad mode',()=>{
  const entries=fileEntries();entries.delete('/private/probe');
  mocked(entries,()=>{assert.equal(verifyMissingParent('/private/probe'),false);entries.set('/private',info({mode:0o40755}));assert.throws(()=>verifyMissingParent('/private/probe'),/private_data_acl/);entries.set('/private',info({mode:0o120700}));assert.throws(()=>verifyMissingParent('/private/probe'),/private_data_path/);});
});
for(const mutation of ['file','ancestor','permissions','size','close'])test(`async verification rejects ${mutation} replacement while awaiting descriptor operations`,async()=>{
  const entries=fileEntries(),before=entries.get('/private/probe');
  await mocked(entries,async()=>{
    fs.promises.open=async()=>({
      async stat(){
        if(mutation==='file')entries.set('/private/probe',info({mode:0o100600,ino:4}));
        if(mutation==='ancestor')entries.set('/private',info({ino:4}));
        if(mutation==='permissions')entries.set('/private/probe',info({mode:0o100644,ino:3}));
        if(mutation==='size')entries.set('/private/probe',info({mode:0o100600,ino:3,size:13}));
        return before;
      },
      async close(){if(mutation==='close')entries.set('/private/probe',info({mode:0o100600,ino:4}));},
    });
    await assert.rejects(verifyFileAsync('/private/probe',before,1024),/private_(file|data)_changed/);
  });
});
test('synthetic async verification succeeds only with stable final path and ancestor',async()=>{
  const entries=fileEntries();await mocked(entries,async()=>{fs.promises.open=async()=>({async stat(){return entries.get('/private/probe');},async close(){}});assert.equal(await verifyFileAsync('/private/probe',entries.get('/private/probe'),1024),true);});
});
test('Windows helper retains native Python backend arguments and process options',async()=>{
  const exists=fs.existsSync,exec=cp.execFile,previous=process.env.WEB_KAKAO_PYTHON,calls=[];
  delete process.env.WEB_KAKAO_PYTHON;
  fs.existsSync=()=>false;
  cp.execFile=(command,args,options,done)=>{calls.push({command,args,options});queueMicrotask(()=>done(null,'true'));};syncBuiltinESMExports();
  try{assert.equal(await nativeAsync(resolve('.'),'file',resolve('synthetic'),4096),true);assert.equal(calls.length,1);assert.equal(calls[0].command,'py.exe');assert.deepEqual(calls[0].args.slice(0,5),['-3','-I','-B','-X','utf8']);assert.ok(calls[0].args.some(value=>value.endsWith('windows_security.py')));assert.deepEqual(calls[0].args.slice(-2),['--max-bytes','4096']);assert.equal(calls[0].options.timeout,10000);assert.equal(calls[0].options.windowsHide,true);}
  finally{fs.existsSync=exists;cp.execFile=exec;if(previous===undefined)delete process.env.WEB_KAKAO_PYTHON;else process.env.WEB_KAKAO_PYTHON=previous;syncBuiltinESMExports();}
});
test('native Linux permissions and hardlink rejection',{skip:process.platform!=='linux'?'실제 Linux/WSL에서 실행':false},()=>{
  const folder=fs.mkdtempSync(join(tmpdir(),'webkakao-platform-'));
  try{const privateFolder=join(folder,'private');ensurePrivateDirectory(privateFolder);assert.equal(fs.statSync(privateFolder).mode & 0o777,0o700);const path=join(privateFolder,'probe');fs.writeFileSync(path,'synthetic',{mode:0o600});assert.equal(verifyPrivateFile(path),true);fs.linkSync(path,join(privateFolder,'other'));assert.throws(()=>verifyPrivateFile(path),/private_file_acl/);}
  finally{fs.rmSync(folder,{recursive:true,force:true});}
});
