import { createHash } from 'node:crypto';
import { mkdirSync,lstatSync,chmodSync } from 'node:fs';
import { resolve,join,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Path computation is deliberately free of filesystem and process operations.
export function privateDataRoot({projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),localAppData=process.env.LOCALAPPDATA}={}) {
  if(!localAppData)throw new Error('private_data_location');
  const install=createHash('sha256').update(resolve(projectRoot).replaceAll('\\','/').toLowerCase(),'utf8').digest('hex').slice(0,16);
  return join(resolve(localAppData),'WebKakao',install);
}
export function ensurePrivateDirectory(folder) {
  const target=resolve(folder);
  // Check each existing ancestor before following it or writing anything.
  for(let current=target;;current=dirname(current)){
    try{const info=lstatSync(current);if(info.isSymbolicLink() || !info.isDirectory())throw new Error('private_data_path');}catch(error){if(error.code!=='ENOENT')throw error;}
    if(dirname(current)===current)break;
  }
  mkdirSync(target,{recursive:true,mode:0o700});
  if(process.platform==='win32'){
    const script="$ErrorActionPreference='Stop';$p=$env:WEBKAKAO_PRIVATE_DIRECTORY;$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object System.Security.AccessControl.DirectorySecurity;$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);$allowed=@($sid.Value,'S-1-5-18','S-1-5-32-544');foreach($s in $allowed){$id=New-Object System.Security.Principal.SecurityIdentifier($s);$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($id,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule)};Set-Acl -LiteralPath $p -AclObject $acl;$check=Get-Acl -LiteralPath $p;if(!$check.AreAccessRulesProtected){throw 'private_acl'};$rules=@($check.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]));if($rules.Count -ne 3){throw 'private_acl'};foreach($r in $rules){if($r.IdentityReference.Value -notin $allowed -or $r.AccessControlType -ne 'Allow' -or $r.IsInherited -or $r.FileSystemRights -ne 'FullControl'){throw 'private_acl'}}";
    execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,WEBKAKAO_PRIVATE_DIRECTORY:target},stdio:'ignore',windowsHide:true,timeout:10000});
  }else chmodSync(target,0o700);
  return target;
}

// Existing explicit file ACEs are not repaired by protecting the parent.
// Refuse the file instead of reading a secret from an unverified location.
export function verifyPrivateFile(path,{maxBytes=1024*1024}={}) {
  let info;try{info=lstatSync(path);}catch(error){if(error.code==='ENOENT')return false;throw error;}
  if(!info.isFile() || info.isSymbolicLink() || info.size>maxBytes)throw new Error('private_file_path');
  for(let current=dirname(resolve(path));;current=dirname(current)){
    const parent=lstatSync(current);if(parent.isSymbolicLink() || !parent.isDirectory())throw new Error('private_file_path');
    if(dirname(current)===current)break;
  }
  if(process.platform==='win32'){
    const script="$ErrorActionPreference='Stop';$p=$env:WEBKAKAO_PRIVATE_FILE;$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$allowed=@($sid,'S-1-5-18','S-1-5-32-544');$acl=Get-Acl -LiteralPath $p;if($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid){throw 'private_file_owner'};$rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]));if(!$rules.Count){throw 'private_file_acl'};foreach($r in $rules){if($r.IdentityReference.Value -notin $allowed -or $r.AccessControlType -ne 'Allow'){throw 'private_file_acl'}}";
    execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,WEBKAKAO_PRIVATE_FILE:resolve(path)},stdio:'ignore',windowsHide:true,timeout:10000});
  }else if(info.mode & 0o077)throw new Error('private_file_acl');
  return true;
}
