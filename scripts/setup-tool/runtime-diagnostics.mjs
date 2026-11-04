import {readFileSync,realpathSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {chromeInstalls} from './lib.mjs';
import {installedVersion} from '../setup-pilot/install-package.mjs';
import {validNativeDiagnostics} from '../../src/update-control/native-diagnostics.js';

export function chromeProcessState({platform=process.platform,pid=process.pid,uid=process.getuid?.(),run=execFileSync}={}){
 try{
  if(platform==='win32'){
   if(!Number.isSafeInteger(pid)||pid<=0)return 'UNKNOWN';
   const command=`$ErrorActionPreference='Stop'; $scbSessionId=(Get-Process -Id ${pid}).SessionId; $scbSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $scbChrome=@(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -Property Handle,ProcessId,ParentProcessId,SessionId | Where-Object { $_.SessionId -eq $scbSessionId }); $scbIds=@($scbChrome.ProcessId); $scbUnknown=$false; foreach($scbProcess in $scbChrome | Where-Object { $_.ParentProcessId -notin $scbIds }){try{$scbOwner=Invoke-CimMethod -InputObject $scbProcess -MethodName GetOwnerSid -ErrorAction Stop;if($scbOwner.ReturnValue -ne 0){$scbUnknown=$true}elseif($scbOwner.Sid -eq $scbSid){'RUNNING';exit}}catch{$scbUnknown=$true}}; if($scbUnknown){'UNKNOWN'}else{'NOT_RUNNING'}`;
   const output=String(run(path.join(process.env.SystemRoot||'C:/Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',windowsHide:true,timeout:5000})).trim();
   return ['RUNNING','NOT_RUNNING'].includes(output)?output:'UNKNOWN';
  }
  if(platform==='darwin'&&Number.isSafeInteger(uid)){
   const output=String(run('/bin/ps',['-U',String(uid),'-o','comm='],{encoding:'utf8',timeout:5000}));
   return output.split(/\r?\n/).some(line=>line.trim().endsWith('/Google Chrome'))?'RUNNING':'NOT_RUNNING';
  }
 }catch{}
 return 'UNKNOWN';
}

/** Read only the known extension's registered profiles. Return status enums, never browser content or paths. */
export function collectRuntimeDiagnostics({directory,userData,installationId,deps={}}){
 const d={chromeInstalls,installedVersion,read:file=>readFileSync(file,'utf8'),realpath:file=>realpathSync.native(file),processState:chromeProcessState,platform:process.platform,...deps};
 const processState=d.processState();
 const knownProcess=['RUNNING','NOT_RUNNING'].includes(processState);
 const result={schema:1,chrome_process:knownProcess?processState:'UNKNOWN',probe_error:knownProcess?'NONE':'PROCESS_PROBE_FAILED',profile_count_total:0,profiles_truncated:false,profiles:[]};
 let inventory;
 let inventoryError=false;
 try{inventory=d.chromeInstalls(userData,{onReadError:()=>{inventoryError=true;}});if(!Array.isArray(inventory))throw Error('inventory_unreadable');}
 catch{result.probe_error='INVENTORY_UNREADABLE';return result;}
 result.profile_count_total=Math.min(inventory.length,10000);result.profiles_truncated=inventory.length>12;
 if(inventoryError)result.probe_error='INVENTORY_UNREADABLE';
 const normalized=value=>{let absolute=path.resolve(value);try{absolute=d.realpath(absolute);}catch{}return d.platform==='win32'?absolute.toLowerCase():absolute;};
 for(const item of inventory.slice(0,12)){
  if(!/^(Default|Profile [0-9]{1,6})$/.test(item.profile||''))continue;
  const validPath=typeof item.path==='string'&&path.isAbsolute(item.path)&&!item.path.startsWith('\\\\')&&!item.path.startsWith('//');
  let version=null,marker='UNKNOWN';
  if(validPath){
   try{const value=d.installedVersion(item.path);if(/^\d+(\.\d+){1,3}$/.test(value||'')&&value.length<=30)version=value;}catch{}
   try{
    const text=d.read(path.join(item.path,'scb-native-updater.json'));if(text.length>4096)throw Error('marker_oversized');
    const value=JSON.parse(text);marker=typeof value.installation_id==='string'?(value.installation_id===installationId?'MATCH':'MISMATCH'):'MISSING';
   }catch(error){marker=error.code==='ENOENT'?'MISSING':'UNKNOWN';}
  }
  result.profiles.push({profile:item.profile,same_directory:validPath&&typeof directory==='string'&&path.isAbsolute(directory)&&normalized(item.path)===normalized(directory),
   extension_enabled:item.enabled===true?'ENABLED':item.enabled===false?'DISABLED':'UNKNOWN',developer_mode:item.developerMode===true?'ON':item.developerMode===false?'OFF':'UNKNOWN',
   pinned:item.pinned===true?'PINNED':item.pinned===false?'UNPINNED':'UNKNOWN',files_version:version,marker_matches:marker});
 }
 if(!validNativeDiagnostics(result))throw Error('invalid_native_diagnostics');
 return result;
}
