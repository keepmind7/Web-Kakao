import test from 'node:test';
import assert from 'node:assert/strict';
import {browserDebugPort,browserCleanupPassed,testBrowser} from './browser-platform.mjs';
import {photoWorkPeak,photoCanceled,observePhotoReply} from './photo-assertions.mjs';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';

test('DevTools reads retry EBUSY and incomplete writes within one deadline',async()=>{
  let reads=0;
  assert.equal(await browserDebugPort('synthetic',{timeout:1000,read:()=>{
    reads++;if(reads===1)throw Object.assign(Error('synthetic busy'),{code:'EBUSY'});
    return reads===2?'':'34567\n/devtools/browser/synthetic';
  }}),34567);assert.equal(reads,3);
});

test('DevTools deadline and nontransient filesystem failure remain failures',async()=>{
  await assert.rejects(browserDebugPort('synthetic',{timeout:1,read:()=>''}),/deadline/);
  await assert.rejects(browserDebugPort('synthetic',{read:()=>{throw Object.assign(Error('denied'),{code:'EACCES'});}}),/denied/);
});

test('cleanup cannot pass with a live browser, server, pending work or cleanup error',()=>{
  const closed={chromeExitObserved:true,serverListening:false,pending:0};assert.equal(browserCleanupPassed(closed),true);
  for(const patch of [{chromeExitObserved:false},{serverListening:true},{serverClosed:false},{pending:1},{error:{code:'EBUSY'}},{profileProcessCount:1},{servers:[{listening:true}]}])assert.equal(browserCleanupPassed({...closed,...patch}),false);
});

test('user-scoped Chrome discovery uses the original environment',()=>{
  const base=resolve('local-only/qa-ocr-remediation');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'browser-discovery-'));
  try{
    const file=join(root,'original','Google/Chrome/Application/chrome.exe');mkdirSync(resolve(file,'..'),{recursive:true});writeFileSync(file,'synthetic, never executed');
    assert.equal(testBrowser({platform:'win32',env:{LOCALAPPDATA:join(root,'isolated')}}),null);
    assert.equal(testBrowser({platform:'win32',env:{LOCALAPPDATA:join(root,'original')}}),file);
    for(const key of ['PROGRAMFILES','programfiles','ProgramFiles','ProgramW6432','ProgramFiles(x86)']){
      assert.equal(testBrowser({platform:'win32',env:{[key]:join(root,'original')}}),file,'copied Windows environment key: '+key);
    }
  }finally{assert.equal(resolve(root,'..'),base);rmSync(root,{recursive:true,force:true});}
});

test('photo work excludes only completed 409 retries and retains active or unknown responses',()=>{
  const trace=[{path:'/api/photo',startOrder:1,endOrder:6},{path:'/api/photo',startOrder:2,endOrder:7},
    {path:'/api/photo',startOrder:3,endOrder:4,responseStatus:409,responseFinished:true,responseError:'photo_request_retired'}];
  assert.equal(photoWorkPeak(trace),2);trace[2].responseFinished=false;assert.equal(photoWorkPeak(trace),3);
  trace[2].responseFinished=true;trace[2].responseError='authentication_required';assert.equal(photoWorkPeak(trace),3);
});

test('only the exact retired error is retained while the original response is preserved',()=>{
  for(const error of ['photo_request_retired','authentication_required']){
    const row={path:'/api/photo'},response={statusCode:409,end(value){assert.equal(this,response);return value;}};
    observePhotoReply(response,row);const body=JSON.stringify({error});assert.equal(response.end(body),body);
    assert.equal(row.responseError,error==='photo_request_retired'?error:undefined);
  }
});

test('non-CDP cancellation needs a matching acknowledged cancel and closed server request',()=>{
  const row={doneMs:3,canceled:false,syntheticRequestId:'synthetic-photo-1',endMethod:'Network.loadingFailed',errorText:'net::ERR_EMPTY_RESPONSE'};
  const trace=[{path:'/api/photo',syntheticRequestId:row.syntheticRequestId,closeMs:2},{path:'/api/photo/cancel',syntheticRequestId:row.syntheticRequestId,responseFinished:true,responseStatus:200}];
  assert.equal(photoCanceled(row,trace),true);assert.equal(photoCanceled(row,trace.slice(0,1)),false);
  assert.equal(photoCanceled({...row,syntheticRequestId:'other'},trace),false);
  assert.equal(photoCanceled({...row,errorText:'net::ERR_FAILED'},trace),false);
  assert.equal(photoCanceled({...row,endMethod:'Network.loadingFinished',responseStatus:200},trace),false);
  assert.equal(photoCanceled({...row,endMethod:'Network.loadingFinished',responseStatus:409},trace),false);
  const retry={path:'/api/photo',syntheticRequestId:row.syntheticRequestId,closeMs:3,responseStatus:409,responseFinished:true,responseError:'photo_request_retired'};
  assert.equal(photoCanceled({...row,endMethod:'Network.loadingFinished',responseStatus:409},[...trace,retry]),true);
  assert.equal(photoCanceled(row,[{...trace[0],closeMs:null},trace[1],retry]),false,'a closed retry cannot prove that the original photo closed');
  assert.equal(photoCanceled({...row,doneMs:null,canceled:true},trace),false);
});
