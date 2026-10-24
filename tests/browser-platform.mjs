// Explicit test-browser locations only. Never attach to a personal profile or
// use PATH/BROWSER to choose a command that will receive a launch capability.
import {existsSync,accessSync,constants} from 'node:fs';
import {join,isAbsolute} from 'node:path';

export function testBrowser({platform=process.platform,env=process.env}={}){
  const candidates=platform==='win32'
    ?[env.ProgramFiles,env.ProgramW6432,env['ProgramFiles(x86)'],env.LOCALAPPDATA].filter(value=>value&&isAbsolute(value)).map(base=>join(base,'Google/Chrome/Application/chrome.exe'))
    :platform==='linux'
      ?['/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser']
      :platform==='darwin'?['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']:[];
  return candidates.find(path=>{try{if(!existsSync(path))return false;if(platform!=='win32')accessSync(path,constants.X_OK);return true;}catch{return false;}}) ?? null;
}
