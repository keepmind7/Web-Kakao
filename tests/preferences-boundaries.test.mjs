import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join,basename,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createPreferenceStore} from '../experiments/local-web/preferences.mjs';
import {ensurePrivateDirectoryAsync,verifyPrivateFileAsync} from '../experiments/local-web/private-storage.mjs';

const directories=[];
const folder=()=>{const directory=fs.mkdtempSync(join(fs.realpathSync(tmpdir()),'webkakao-prefs-boundary-'));directories.push(directory);return directory;};
after(()=>{for(const directory of directories){assert.equal(dirname(fs.realpathSync(directory)),fs.realpathSync(tmpdir()));assert.ok(basename(directory).startsWith('webkakao-prefs-boundary-'));fs.rmSync(directory,{recursive:true,force:true});}});
const synthetic=path=>path;
const jsonPath=directory=>join(directory,fs.readdirSync(directory).find(name=>name.endsWith('.json')));
const open=directory=>createPreferenceStore({folder:directory,secureFolder:synthetic}).account('111');
function interceptWrites(intercept,operation){
  const original=fs.writeSync;
  try{fs.writeSync=(...args)=>intercept(original,...args);syncBuiltinESMExports();return operation();}
  finally{fs.writeSync=original;syncBuiltinESMExports();}
}
function limitedWrite(original,fd,data,offset=0,length,position){
  if(typeof data==='string')return original(fd,Buffer.from(data),0,7,null);
  return original(fd,data,offset,Math.min(length ?? data.length-offset,7),position);
}

test('short writes complete every UTF-8 byte before replacing valid settings',()=>{
  const directory=folder(),profile=open(directory);assert.equal(profile.set({persist:true}),true);
  let target,calls=0;
  const accepted=interceptWrites((original,fd,data,...rest)=>{
    if(target===undefined && (Buffer.isBuffer(data)?data.toString('utf8'):data).startsWith('{"version":1,'))target=fd;
    if(fd!==target)return original(fd,data,...rest);
    calls++;return limitedWrite(original,fd,data,...rest);
  },()=>profile.setRoom('a'.repeat(64),{title:'합성 이름 · byte boundary'}));
  assert.equal(accepted,true);assert.ok(calls>1);
  assert.equal(JSON.parse(fs.readFileSync(jsonPath(directory),'utf8')).rooms['a'.repeat(64)].title,'합성 이름 · byte boundary');
  assert.equal(open(directory).snapshot().storageError,false);
});

for(const partial of [false,true])test(`${partial?'partial then zero':'zero'} write fails without replacing the previous settings`,()=>{
  const directory=folder(),profile=open(directory);assert.equal(profile.set({persist:true}),true);
  const path=jsonPath(directory),before=fs.readFileSync(path);let target,calls=0;
  const accepted=interceptWrites((original,fd,data,...rest)=>{
    if(target===undefined && (Buffer.isBuffer(data)?data.toString('utf8'):data).startsWith('{"version":1,'))target=fd;
    if(fd!==target)return original(fd,data,...rest);
    calls++;return partial && calls===1?limitedWrite(original,fd,data,...rest):0;
  },()=>profile.set({notifications:true}));
  assert.equal(accepted,false);assert.equal(profile.snapshot().storageError,true);
  assert.deepEqual(fs.readFileSync(path),before);assert.equal(open(directory).snapshot().notifications,false);
  assert.equal(fs.readdirSync(directory).some(name=>name.endsWith('.tmp')),false);
});

test('new files are verified while empty and again after writing for sync and async stores',async()=>{
  for(const asyncSecurity of [false,true]){
    const directory=folder(),observed=[];
    const store=createPreferenceStore({folder:directory,asyncSecurity,secureFolder:synthetic,verifyFile:path=>{
      if(fs.existsSync(path))observed.push({path,size:fs.statSync(path).size});return true;
    }}),profile=await store.account('111');
    assert.equal(await profile.set({persist:true}),true);
    const key=join(directory,'identity.key'),written=observed.filter(row=>row.path.endsWith('.tmp'));
    assert.ok(observed.some(row=>row.path===key && row.size===0));
    assert.ok(observed.some(row=>row.path===key && row.size===32));
    assert.ok(written.some(row=>row.size===0));assert.ok(written.some(row=>row.size>0));
  }
});

test('a rejected empty new-file permission check prevents writing and preserves old settings',async()=>{
  const directory=folder(),first=open(directory);assert.equal(first.set({persist:true}),true);first.close();
  const path=jsonPath(directory),before=fs.readFileSync(path);let refused=0;
  const profile=await createPreferenceStore({folder:directory,asyncSecurity:true,secureFolder:synthetic,verifyFile:file=>{
    if(file.endsWith('.tmp') && fs.statSync(file).size===0){refused++;return false;}return true;
  }}).account('111');
  assert.equal(await profile.set({notifications:true}),false);assert.equal(refused,1);
  assert.deepEqual(fs.readFileSync(path),before);assert.equal(fs.readdirSync(directory).some(name=>name.endsWith('.tmp')),false);
});

test('an unverified new identity stays empty and is removed without publishing settings',async()=>{
  const directory=folder();let refused=0;
  const profile=await createPreferenceStore({folder:directory,asyncSecurity:true,secureFolder:synthetic,verifyFile:file=>{
    if(file.endsWith('identity.key') && fs.existsSync(file)){assert.equal(fs.statSync(file).size,0);refused++;return false;}return true;
  }}).account('111');
  assert.equal(await profile.set({persist:true}),false);assert.equal(refused,1);
  assert.equal(fs.existsSync(join(directory,'identity.key')),false);assert.equal(fs.readdirSync(directory).length,0);
});

test('a zero-byte identity write fails cleanly and a later attempt can create a valid key',()=>{
  const directory=folder(),profile=open(directory);let injected=0;
  const accepted=interceptWrites((original,fd,data,...rest)=>{
    if(Buffer.isBuffer(data) && data.length===32){injected++;return 0;}return original(fd,data,...rest);
  },()=>profile.set({persist:true}));
  assert.equal(injected,1);assert.equal(accepted,false);assert.equal(fs.readdirSync(directory).length,0);
  assert.equal(profile.set({persist:true}),true);assert.equal(fs.readFileSync(join(directory,'identity.key')).length,32);
  assert.equal(open(directory).snapshot().storageError,false);
});

test('closing or invalidating the intent during new-file verification prevents publication',async()=>{
  for(const action of ['close','stale']){
    const directory=folder(),first=open(directory);assert.equal(first.set({persist:true}),true);first.close();
    const path=jsonPath(directory),before=fs.readFileSync(path);let release,entered;
    const held=new Promise(resolve=>{release=resolve;}),reached=new Promise(resolve=>{entered=resolve;});
    let block=true,current=true;
    const profile=await createPreferenceStore({folder:directory,asyncSecurity:true,secureFolder:synthetic,verifyFile:async file=>{
      if(block && file.endsWith('.tmp')){entered();await held;}return true;
    }}).account('111');
    const pending=profile.set({notifications:true},{isCurrent:()=>current});
    await reached;if(action==='close')profile.close();else current=false;
    block=false;release();assert.equal(await pending,false);assert.deepEqual(fs.readFileSync(path),before);
    assert.equal(fs.readdirSync(directory).some(name=>name.endsWith('.tmp')),false);
  }
});

test('explicit forget deletes only this account current file and strict corrupt backups',()=>{
  const directory=folder(),first=open(directory);assert.equal(first.set({persist:true}),true);
  const path=jsonPath(directory),keyBefore=fs.readFileSync(join(directory,'identity.key'));
  fs.writeFileSync(path,'{"unfinished":');first.close();
  const recovered=open(directory);assert.equal(recovered.set({persist:true}),true);
  const other=createPreferenceStore({folder:directory,secureFolder:synthetic}).account('222');assert.equal(other.set({persist:true,notifications:true}),true);
  const otherPath=fs.readdirSync(directory).find(name=>name.endsWith('.json') && join(directory,name)!==path);
  const otherBackup=join(directory,otherPath+'.corrupt-123');fs.writeFileSync(otherBackup,'SYNTHETIC_OTHER_BACKUP');
  const unrelated=path+'.corrupt-not-a-timestamp';fs.writeFileSync(unrelated,'SYNTHETIC_UNRELATED');
  const backups=fs.readdirSync(directory).filter(name=>name.startsWith(basename(path)+'.corrupt-') && /^\d+$/.test(name.slice((basename(path)+'.corrupt-').length)));
  assert.equal(backups.length,1);
  assert.equal(recovered.forget(),true);assert.equal(fs.existsSync(path),false);
  for(const backup of backups)assert.equal(fs.existsSync(join(directory,backup)),false);
  assert.equal(fs.existsSync(join(directory,otherPath)),true);assert.equal(fs.existsSync(otherBackup),true);assert.equal(fs.existsSync(unrelated),true);
  assert.deepEqual(fs.readFileSync(join(directory,'identity.key')),keyBefore);
});

test('forget refuses an untrusted account namespace after identity-key corruption',()=>{
  const directory=folder(),profile=open(directory);assert.equal(profile.set({persist:true}),true);profile.close();
  const path=jsonPath(directory),backup=path+'.corrupt-123';fs.writeFileSync(backup,'SYNTHETIC_BACKUP');
  const before=fs.readFileSync(path);fs.writeFileSync(join(directory,'identity.key'),'SYNTHETIC_DAMAGED_KEY');
  const damaged=open(directory);assert.equal(damaged.snapshot().storageError,true);
  assert.equal(damaged.forget(),false,'an unknown HMAC namespace cannot report deletion success');
  assert.equal(damaged.snapshot().storageError,true);assert.deepEqual(fs.readFileSync(path),before);assert.equal(fs.existsSync(backup),true);
});

test('Windows persistent writes protect newly created files after parent inheritance changes',{skip:process.platform!=='win32'},async()=>{
  const directory=join(folder(),'preferences'),store=createPreferenceStore({folder:directory,asyncSecurity:true}),profile=await store.account('111');
  assert.equal(await profile.set({persist:true}),true);
  const key=join(directory,'identity.key'),path=jsonPath(directory);
  // ACL mutations stay inside this fresh synthetic directory. Keep old files private
  // while making only future children inherit the deliberately broad parent ACE.
  for(const file of [key,path])execFileSync('icacls',[file,'/inheritance:d'],{stdio:'ignore',windowsHide:true});
  try{
    execFileSync('icacls',[directory,'/grant','*S-1-1-0:(OI)(CI)R'],{stdio:'ignore',windowsHide:true});
    assert.equal(await verifyPrivateFileAsync(path),true);
    const accepted=await profile.set({notifications:true});
    if(accepted)assert.equal(await verifyPrivateFileAsync(path),true);
    else assert.equal(profile.snapshot().storageError,true);
    assert.equal(await verifyPrivateFileAsync(key),true);
  }finally{await ensurePrivateDirectoryAsync(directory);profile.close();}
});

test('Windows first persistence protects the new identity after the prepared parent changes',{skip:process.platform!=='win32'},async()=>{
  const directory=join(folder(),'preferences');await ensurePrivateDirectoryAsync(directory);
  const profile=await createPreferenceStore({folder:directory,asyncSecurity:true}).account('111');
  try{
    execFileSync('icacls',[directory,'/grant','*S-1-1-0:(OI)(CI)R'],{stdio:'ignore',windowsHide:true});
    const accepted=await profile.set({persist:true});
    if(accepted){assert.equal(await verifyPrivateFileAsync(join(directory,'identity.key')),true);assert.equal(await verifyPrivateFileAsync(jsonPath(directory)),true);}
    else assert.equal(profile.snapshot().storageError,true);
  }finally{await ensurePrivateDirectoryAsync(directory);profile.close();}
});
