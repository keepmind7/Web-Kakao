import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,readdirSync,readFileSync,writeFileSync,rmSync,chmodSync,realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createPreferenceStore } from '../experiments/local-web/preferences.mjs';

// macOS tmpdir() sits under the /var -> /private/var symlink that private storage rejects by design.
const directories=[],folder=()=>{const path=mkdtempSync(join(realpathSync(tmpdir()),'webkakao-prefs-'));directories.push(path);return path;};
after(()=>{for(const path of directories)rmSync(path,{recursive:true,force:true});});
const synthetic=path=>path,open=directory=>createPreferenceStore({folder:directory,secureFolder:synthetic}).account('111');
const jsonFile=directory=>join(directory,readdirSync(directory).find(name=>name.endsWith('.json')));
const a='a'.repeat(64),b='b'.repeat(64),c='c'.repeat(64);

test('a damaged settings file is preserved instead of being overwritten or deleted',()=>{
  const directory=folder(),one=open(directory);one.set({persist:true,notifications:true});one.setRoom(a,{title:'합성',muted:true});
  const path=jsonFile(directory),damaged=readFileSync(path,'utf8').slice(0,20);writeFileSync(path,damaged);
  const two=open(directory);assert.equal(two.snapshot().storageError,true);
  assert.equal(two.set({readSync:true}),true);assert.equal(readFileSync(path,'utf8'),damaged);assert.equal(two.snapshot().storageError,true);
  assert.equal(two.set({persist:true,roomFilter:'unread'}),true);assert.equal(two.snapshot().storageError,false);
  const copies=readdirSync(directory).filter(name=>/\.json\.corrupt-\d+$/.test(name));assert.equal(copies.length,1);
  assert.equal(readFileSync(join(directory,copies[0]),'utf8'),damaged);assert.equal(open(directory).snapshot().roomFilter,'unread');
});
test('one invalid room entry drops only that room',()=>{
  const directory=folder(),one=open(directory);one.set({persist:true});one.setRoom(a,{muted:true});
  const path=jsonFile(directory),raw=JSON.parse(readFileSync(path,'utf8'));raw.rooms[b]={title:'x\ny'};writeFileSync(path,JSON.stringify(raw));
  const two=open(directory);assert.equal(two.snapshot().persist,true);assert.equal(two.room(a).muted,true);assert.deepEqual(two.room(b),{});
});
test('two stores for one account keep each other\'s room changes',()=>{
  const directory=folder();open(directory).set({persist:true});const one=open(directory),two=open(directory);
  assert.equal(one.setRoom(b,{muted:true}),true);assert.equal(two.setRoom(c,{muted:true}),true);assert.equal(two.set({notifications:true}),true);
  const raw=JSON.parse(readFileSync(jsonFile(directory),'utf8'));assert.deepEqual(Object.keys(raw.rooms).sort(),[b,c]);assert.equal(raw.settings.notifications,true);
});
test('writes use a unique temporary file and leave none behind',()=>{
  const directory=folder(),one=open(directory);one.set({persist:true});mkdirSync(jsonFile(directory)+'.tmp');
  assert.equal(one.setRoom(a,{muted:true}),true);assert.equal(readdirSync(directory).filter(name=>name.endsWith('.tmp')).length,1);
});
// Real private-directory and file-ACL checks; ACLs change only inside a fresh OS temp directory.
test('real file ACL verification accepts private files and refuses widened ones',()=>{
  const directory=join(folder(),'preferences'),one=createPreferenceStore({folder:directory}).account('111');
  assert.equal(one.set({persist:true}),true);assert.equal(one.setRoom(a,{title:'합성'}),true);
  const two=createPreferenceStore({folder:directory}).account('111');assert.equal(two.snapshot().storageError,false);assert.equal(two.room(a).title,'합성');
  const path=jsonFile(directory);
  if(process.platform==='win32')execFileSync('icacls',[path,'/grant','*S-1-1-0:R'],{stdio:'ignore',windowsHide:true});else chmodSync(path,0o644);
  const three=createPreferenceStore({folder:directory}).account('111');assert.equal(three.snapshot().storageError,true);assert.deepEqual(three.room(a),{});
});
