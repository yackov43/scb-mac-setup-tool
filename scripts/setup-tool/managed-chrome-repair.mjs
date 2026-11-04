import {readFileSync,writeFileSync,renameSync} from 'node:fs';import {randomUUID} from 'node:crypto';import path from 'node:path';
import {chromeInstalls} from './lib.mjs';import {chromeUserData,installIntoChromeNative} from './native-browser.mjs';
import {resolveChromeScope,validateExistingScope} from './chrome-scope.mjs';
function persistScope(home,config,scope){
 const file=path.join(home,'updater.json'),current=JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));
 if(path.resolve(current.directory)!==path.resolve(config.directory)||current.base!==config.base)throw Error('updater_config_changed');
 const temporary=file+'.scope-'+randomUUID()+'.tmp';writeFileSync(temporary,JSON.stringify({...current,userData:scope.userData,profile:scope.profile},null,2),{mode:0o600});renameSync(temporary,file);
}
/** Repair only proven registration defects, in an already authorized personal profile, without browser debugging. */
export async function repairManagedChrome({home,config,version,diagnostics,authorize,deps={}}){
 const d={chromeInstalls,chromeUserData,resolveChromeScope,validateExistingScope,installIntoChromeNative,persistScope,...deps};
 if(diagnostics?.chrome_process!=='RUNNING'||diagnostics.probe_error!=='NONE'||diagnostics.profiles_truncated)return {ok:true,attempted:false,reason:'inventory_not_ready'};
 const userData=config.userData||d.chromeUserData();let inventory,unreadable=false;
 try{inventory=d.chromeInstalls(userData,{onReadError:()=>{unreadable=true;}});if(!Array.isArray(inventory))unreadable=true;}catch{unreadable=true;}
 if(unreadable)return {ok:false,attempted:false,reason:'CHROME_PERMISSION_REQUIRED',detail:'inventory_unreadable'};
 const same=entry=>path.resolve(entry.path).toLowerCase()===path.resolve(config.directory).toLowerCase(),matching=inventory.filter(same);
 const selected=config.profile?matching.filter(entry=>entry.profile===config.profile):matching;
 const needsRepair=!selected.length||selected.some(entry=>entry.enabled===false||entry.developerMode===false||entry.pinned===false);
 if(!needsRepair)return {ok:true,attempted:false,reason:'registration_present'};
 let scope;
 try{
  scope=await d.resolveChromeScope({home,userData,config,installs:inventory,context:null,contextWaitMs:0});
  d.validateExistingScope(scope,config,inventory);
  const other=inventory.find(entry=>entry.profile===scope.profile&&!same(entry));if(other)throw Error('extension_directory_mismatch');
 }catch{return {ok:false,attempted:false,reason:'CHROME_PERMISSION_REQUIRED',detail:'profile_scope_not_verified'};}
 // The server must still permit this exact STARTED action immediately before native side effects.
 await authorize();
 const result=await d.installIntoChromeNative(config.directory,{expectedVersion:version,userData:scope.userData,profile:scope.profile});
 if(!result?.ok){const identity=/identity|receipt_mismatch/.test(result?.reason||'');return {ok:false,attempted:true,reason:identity?'RELEASE_ARTIFACT_MISMATCH':'INSTALL_FAILED'};}
 if(result.profile!==scope.profile||result.version!==version||result.pinned!==true)return {ok:false,attempted:true,reason:'RELEASE_ARTIFACT_MISMATCH'};
 d.persistScope(home,config,scope);return {ok:true,attempted:true};
}
