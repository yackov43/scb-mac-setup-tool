// Strict, bounded status data. File paths, profile display names, URLs and credentials are never accepted.
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v,allowed)=>object(v)&&Object.keys(v).every(k=>allowed.includes(k));
const one=(v,allowed)=>allowed.includes(v);
export function validNativeDiagnostics(v){
 if(!keys(v,['schema','chrome_process','probe_error','profile_count_total','profiles_truncated','profiles'])||v.schema!==1||
  !one(v.chrome_process,['RUNNING','NOT_RUNNING','UNKNOWN'])||!one(v.probe_error,['NONE','PROCESS_PROBE_FAILED','INVENTORY_UNREADABLE'])||
  !Number.isInteger(v.profile_count_total)||v.profile_count_total<0||v.profile_count_total>10000||typeof v.profiles_truncated!=='boolean'||
  !Array.isArray(v.profiles)||v.profiles.length>12||v.profiles.length>v.profile_count_total)return false;
 const seen=new Set();
 for(const p of v.profiles){
  if(!keys(p,['profile','same_directory','extension_enabled','developer_mode','pinned','files_version','marker_matches'])||
   !/^(Default|Profile [0-9]{1,6})$/.test(p.profile||'')||seen.has(p.profile)||typeof p.same_directory!=='boolean'||
   !one(p.extension_enabled,['ENABLED','DISABLED','UNKNOWN'])||!one(p.developer_mode,['ON','OFF','UNKNOWN'])||
   !one(p.pinned,['PINNED','UNPINNED','UNKNOWN'])||!one(p.marker_matches,['MATCH','MISMATCH','MISSING','UNKNOWN'])||
   !(p.files_version===null||typeof p.files_version==='string'&&p.files_version.length<=30&&/^\d+(\.\d+){1,3}$/.test(p.files_version)))return false;
  seen.add(p.profile);
 }
 return true;
}

export function nativeDiagnosticReasons(d){
 if(!validNativeDiagnostics(d))return ['DIAGNOSTICS_UNAVAILABLE'];
 const reasons=[];
 if(d.chrome_process==='NOT_RUNNING')reasons.push('CHROME_NOT_RUNNING');
 if(d.probe_error!=='NONE')reasons.push(d.probe_error);
 if(!d.profile_count_total&&d.probe_error!=='INVENTORY_UNREADABLE')reasons.push('EXTENSION_PROFILE_NOT_FOUND');
 if(d.profiles.length&&!d.profiles_truncated&&d.probe_error!=='INVENTORY_UNREADABLE'&&!d.profiles.some(p=>p.same_directory))reasons.push('UPDATER_DIRECTORY_MISMATCH');
 if(d.profiles.some(p=>p.same_directory&&p.extension_enabled==='DISABLED'))reasons.push('EXTENSION_DISABLED');
 if(d.profiles.some(p=>p.same_directory&&p.developer_mode==='OFF'))reasons.push('DEVELOPER_MODE_OFF');
 if(d.profiles.some(p=>p.same_directory&&p.marker_matches==='MISMATCH'))reasons.push('NATIVE_BINDING_MISMATCH');
 if(!reasons.length)reasons.push('PROFILE_ACTIVITY_NOT_CONFIRMED');
 return reasons;
}
