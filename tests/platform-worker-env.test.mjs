// In-memory child only. No worker, socket, account or private settings are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createReadOnlyReader} from '../experiments/local-web/reader-manager.mjs';

test('worker receives required Linux paths while secret and runtime override variables remain excluded',()=>{
  const values={HOME:'SYNTHETIC_HOME',XDG_DATA_HOME:'SYNTHETIC_DATA',XDG_STATE_HOME:'SYNTHETIC_STATE',XDG_RUNTIME_DIR:'SYNTHETIC_RUNTIME',TMPDIR:'SYNTHETIC_TMP',NODE_OPTIONS:'SYNTHETIC_OVERRIDE',NODE_TLS_REJECT_UNAUTHORIZED:'0',NODE_EXTRA_CA_CERTS:'SYNTHETIC_CA',HTTPS_PROXY:'SYNTHETIC_PROXY',KAKAO_TOKEN:'SYNTHETIC_TOKEN'};
  const previous=new Map(Object.keys(values).map(key=>[key,process.env[key]]));
  let environment;
  const profile={key:()=>Buffer.alloc(32,5),snapshot:()=>({persist:false,readSync:false}),room:()=>null,close(){}};
  const reader=createReadOnlyReader({preferenceStore:{account:()=>profile},spawn:(_path,_args,options)=>{
    environment=options.env;
    return Object.assign(new EventEmitter(),{send(){},kill(){return true;}});
  }});
  try{
    Object.assign(process.env,values);
    assert.equal(reader.connect({userId:'999',deviceUUID:'SYNTHETIC_DEVICE',accessToken:'SYNTHETIC_NO_ACCOUNT'}),true);
    assert.ok(environment);
    for(const key of ['HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_RUNTIME_DIR','TMPDIR'])assert.equal(environment[key],values[key]);
    for(const key of ['NODE_OPTIONS','NODE_TLS_REJECT_UNAUTHORIZED','NODE_EXTRA_CA_CERTS','HTTPS_PROXY','KAKAO_TOKEN'])assert.equal(Object.hasOwn(environment,key),false);
  }finally{
    reader.close();
    for(const [key,value] of previous)if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
});
