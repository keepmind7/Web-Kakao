import {lstatSync,mkdirSync,openSync,fstatSync,closeSync,constants,promises as fs} from 'node:fs';
import {posix} from 'node:path';
import {sameEntry} from './common.mjs';
const {dirname,parse,join}=posix;

export function checkDirectory(info,uid,{privateTarget=false}={}){
  if(!info.isDirectory() || info.isSymbolicLink() || ![0,uid].includes(info.uid))throw new Error('private_data_path');
  const mode=info.mode & 0o7777;
  if(privateTarget){if(info.uid!==uid || mode!==0o700)throw new Error('private_data_acl');}
  else if(mode & 0o022 && !(info.uid===0 && mode & 0o1000))throw new Error('private_data_ancestor');
}
export function checkFile(info,uid){
  if(!info.isFile() || info.isSymbolicLink())throw new Error('private_file_path');
  if(info.uid!==uid || (info.mode & 0o7777)!==0o600 || info.nlink!==1)throw new Error('private_file_acl');
}

function snapshots(target,{privateTarget=true}={}){
  if(typeof process.getuid!=='function')throw new Error('private_data_platform');
  const uid=process.getuid(),result=[];
  for(let path=target;;path=dirname(path)){
    const info=lstatSync(path);checkDirectory(info,uid,{privateTarget:privateTarget && path===target});result.push({path,info});
    if(dirname(path)===path)break;
  }
  return result;
}
function unchanged(entries){
  for(const {path,info} of entries)if(!sameEntry(info,lstatSync(path)))throw new Error('private_data_changed');
}

// Existing directories are verified, never chmodded. New components start0700.
export function ensureDirectory(target){
  if(typeof process.getuid!=='function')throw new Error('private_data_platform');
  const uid=process.getuid(),root=parse(target).root,components=target.slice(root.length).split('/').filter(Boolean);
  let current=root;
  checkDirectory(lstatSync(root),uid,{privateTarget:target===root});
  for(const component of components){
    const parents=snapshots(current,{privateTarget:false});
    current=join(current,component);
    let info;
    try{info=lstatSync(current);}catch(error){
      if(error.code!=='ENOENT')throw error;
      unchanged(parents);
      try{mkdirSync(current,{mode:0o700});}catch(failure){if(failure.code!=='EEXIST')throw failure;}
      info=lstatSync(current);
    }
    checkDirectory(info,uid,{privateTarget:current===target});unchanged(parents);
    const fd=openSync(current,constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try{if(!sameEntry(info,fstatSync(fd)))throw new Error('private_data_changed');}finally{closeSync(fd);}
  }
  const entries=snapshots(target);unchanged(entries);return target;
}

function beforeFile(path,info){
  checkFile(info,process.getuid());
  return snapshots(dirname(path));
}
export function verifyMissingParent(path){
  const entries=snapshots(dirname(path));unchanged(entries);return false;
}
function afterFile(path,before,opened,entries,maxBytes){
  if(!sameEntry(before,opened,['dev','ino','uid','mode','nlink','size','mtimeMs','ctimeMs']) || opened.size>maxBytes)throw new Error('private_file_changed');
  unchanged(entries);
  const after=lstatSync(path);
  if(!sameEntry(before,after,['dev','ino','uid','mode','nlink','size','mtimeMs','ctimeMs']))throw new Error('private_file_changed');
}
export function verifyFile(path,info,maxBytes){
  const entries=beforeFile(path,info),fd=openSync(path,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try{afterFile(path,info,fstatSync(fd),entries,maxBytes);}finally{closeSync(fd);}return true;
}
export async function verifyFileAsync(path,info,maxBytes){
  const entries=beforeFile(path,info),handle=await fs.open(path,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try{afterFile(path,info,await handle.stat(),entries,maxBytes);}finally{await handle.close();}
  unchanged(entries);
  if(!sameEntry(info,lstatSync(path),['dev','ino','uid','mode','nlink','size','mtimeMs','ctimeMs']))throw new Error('private_file_changed');
  return true;
}
