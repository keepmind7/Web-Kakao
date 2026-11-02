// Explicit test-browser locations only. Never attach to a personal profile or
// use PATH/BROWSER to choose a command that will receive a launch capability.
import {existsSync,accessSync,constants,readFileSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';

export async function browserDebugPort(file,{timeout=15000,read=readFileSync}={}){
  const deadline=performance.now()+timeout;
  do{
    try{
      const port=Number(read(file,'utf8').split(/\r?\n/)[0]);
      if(Number.isInteger(port)&&port>0&&port<65536)return port;
    }catch(error){if(!['ENOENT','EBUSY'].includes(error.code))throw error;}
    await sleep(40);
  }while(performance.now()<deadline);
  throw new Error('Chrome startup deadline: DevToolsActivePort unavailable');
}

export function browserCleanupPassed(cleanup){
  return cleanup.chromeExitObserved===true && cleanup.serverListening!==true && cleanup.serverClosed!==false
    && (cleanup.pending??0)===0 && !cleanup.error && (cleanup.profileProcessCount??0)===0
    && (cleanup.servers??[]).every(server=>server.listening===false);
}

export function testBrowser({platform=process.platform,env=process.env}={}){
  if(platform==='win32')env=Object.fromEntries(Object.entries(env).map(([key,value])=>[key.toUpperCase(),value]));
  const candidates=platform==='win32'
    ?[env.PROGRAMFILES,env.PROGRAMW6432,env['PROGRAMFILES(X86)'],env.LOCALAPPDATA].filter(value=>value&&isAbsolute(value)).map(base=>join(base,'Google/Chrome/Application/chrome.exe'))
    :platform==='linux'
      ?['/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser']
      :platform==='darwin'?['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']:[];
  return candidates.find(path=>{try{if(!existsSync(path))return false;if(platform!=='win32')accessSync(path,constants.X_OK);return true;}catch{return false;}}) ?? null;
}
