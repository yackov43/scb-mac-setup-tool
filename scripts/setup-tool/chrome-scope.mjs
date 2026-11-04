// Local-only profile association. Never log visited URLs, tokens, or history contents.
import {copyFileSync,existsSync,mkdtempSync,readFileSync,readdirSync,rmSync,statSync} from 'node:fs';
import {createHash,timingSafeEqual} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import {BASE} from './lib.mjs';
import {chromeUserData} from './native-browser.mjs';
import {readProfileContext} from './setup-bridge.mjs';

const profileName=value=>/^(Default|Profile \d+)$/.test(value||'');
const samePath=(a,b)=>{const x=path.resolve(a),y=path.resolve(b);return process.platform==='win32'?x.toLowerCase()===y.toLowerCase():x===y;};
export function validateExistingScope(scope,config,installs=[]) {
  if(!config)return;
  if(Object.hasOwn(config,'profile')&&(!profileName(config.profile)||config.profile!==scope.profile)||
    Object.hasOwn(config,'userData')&&(typeof config.userData!=='string'||!path.isAbsolute(config.userData)||!samePath(config.userData,scope.userData)))throw Error('chrome_profile_scope_mismatch');
  if(config.directory) {
    const users=installs.filter(item=>samePath(item.path,config.directory));
    if(users.length>1)throw Error('chrome_profile_selection_required');
    if(users.length===1&&users[0].profile!==scope.profile)throw Error('chrome_profile_scope_mismatch');
  }
}
const stamp=file=>{try{const s=statSync(file,{bigint:true});return {size:s.size,time:s.mtimeNs};}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const unchanged=(a,b)=>a===null&&b===null||a&&b&&a.size===b.size&&a.time===b.time;
function matchesContext(urlText,context,origins) {
  try {
    const url=new URL(urlText),tokens=url.searchParams.getAll('t');
    if(!origins.has(url.origin)||url.username||url.password||!['/api/connect','/connect'].includes(url.pathname)||tokens.length!==1||!/^[a-z0-9]{8,20}$/i.test(tokens[0]))return false;
    return timingSafeEqual(createHash('sha256').update(tokens[0]).digest(),Buffer.from(context.tokenDigest,'hex'));
  }catch{return false;}
}
function hasRecentContext(directory,context,{now,origins,onSnapshot}) {
  const history=path.join(directory,'History');if(!existsSync(history))return false;
  const parent=path.resolve(os.tmpdir()),stage=mkdtempSync(path.join(parent,'scb-history-scope-'));
  let db;
  try {
    onSnapshot(stage);
    const files=[history,history+'-wal'];
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = files.map(stamp);
      if (!before[0] || before.some(s => s && s.size > 512n * 1024n * 1024n)) return false;
      files.forEach((file, i) => { if (before[i]) copyFileSync(file, path.join(stage, i ? 'History-wal' : 'History')); });
      if (before.every((s, i) => unchanged(s, stamp(files[i]))) || attempt === 2) break;
    }
    db=new DatabaseSync(path.join(stage,'History'),{readOnly:true});
    db.exec('PRAGMA trusted_schema=OFF');
    const table=db.prepare("SELECT sql FROM sqlite_schema WHERE name='urls' AND type='table'").get();
    if(!/^CREATE\s+TABLE\b/i.test(table?.sql||''))return false;
    const query=db.prepare('SELECT url FROM urls WHERE last_visit_time>=? AND url>=? AND url<? ORDER BY last_visit_time DESC LIMIT 64');
    const since=(BigInt(Math.floor(now-30*60000))+11644473600000n)*1000n;
    for(const origin of origins)for(const route of ['/api/connect','/connect']) {
      const prefix=origin+route;
      if(query.all(since,prefix,prefix+'\uffff').some(row=>matchesContext(row.url,context,origins)))return true;
    }
    return false;
  }catch{return false;}
  finally {
    try{db?.close();}finally{
      const target=path.resolve(stage);
      if(!target.startsWith(parent+path.sep)||path.dirname(target)!==parent||!path.basename(target).startsWith('scb-history-scope-'))throw Error('unsafe_history_snapshot_path');
      rmSync(target,{recursive:true,force:true,maxRetries:3,retryDelay:50});
    }
  }
}
export async function resolveChromeScope({home,userData=chromeUserData(),context,installs=[],config,now=Date.now(),onSnapshot=()=>{},
  origins=[new URL(BASE).origin,'https://sunocoverbot.com','http://sunocoverbot.com','https://46-225-2-111.sslip.io','http://46-225-2-111.sslip.io','https://46.225.2.111','http://46.225.2.111'],contextRequest=()=>readProfileContext(home),contextWaitMs=5000,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
  if(!path.isAbsolute(userData)||!Number.isFinite(now))throw Error('invalid_chrome_scope');
  const profiles=readdirSync(userData,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&profileName(entry.name)).map(entry=>entry.name);
  if(!profiles.length||profiles.length>64)throw Error('chrome_profile_selection_required');
  if(context===undefined) {
    const deadline=Date.now()+Math.max(0,Math.min(contextWaitMs,10000));
    do{
      const result=await contextRequest();
      if(!Object.hasOwn(result,'tokenDigest'))throw Error('bridge_upgrade_required');
      context=result.id?result:null;
      if(context||Date.now()>=deadline)break;
      await pause(200);
    }while(true);
  }
  let chosen,proof;
  if(context) {
    if(!/^[a-f0-9]{64}$/.test(context.tokenDigest||''))throw Error('invalid_profile_context');
    const trusted=new Set(origins);
    const matches=profiles.filter(profile=>hasRecentContext(path.join(userData,profile),context,{now,origins:trusted,onSnapshot}));
    if(matches.length>1)throw Error('chrome_profile_selection_required');
    if(matches.length===1){
      [chosen]=matches;proof='pairing-history';
    }else if(config?.profile&&profiles.includes(config.profile)){
      chosen=config.profile;proof='configured';
    }else{
      throw Error('chrome_profile_not_verified');
    }
  }else {
    if(config?.profile&&profiles.includes(config.profile)){chosen=config.profile;proof='configured';}
    else if(profiles.length===1){[chosen]=profiles;proof='single-profile';}
    else throw Error('chrome_profile_selection_required');
  }
  const scope={userData,profile:chosen,proof};validateExistingScope(scope,config,installs);return scope;
}
