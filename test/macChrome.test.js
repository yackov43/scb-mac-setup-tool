import test from 'node:test';
import assert from 'node:assert/strict';
import {CHROME_BIN,dataVolumePath,userChromePids,loadIntoChromeMac} from '../scripts/setup-tool/mac-chrome.mjs';
test('Mac process inventory is diagnostic and distinguishes setup window/helpers',()=>{
  const alias=dataVolumePath('/Users/u/Library/Application Support/Google/Chrome');
  const processes=['10 '+CHROME_BIN,'11 '+CHROME_BIN+' --type=renderer','12 '+CHROME_BIN+' --user-data-dir=/test/window-profile','13 '+CHROME_BIN+' --user-data-dir='+alias].join('\n');
  assert.deepEqual(userChromePids(processes,{windowProfile:'/test/window-profile',alias}),[{pid:10,ours:false},{pid:13,ours:true}]);
});
test('Mac Chrome step requires independent exact runtime read-back',async()=>{
  assert.equal((await loadIntoChromeMac('/test/extension',{expectedVersion:'1.2.3',deps:{exists:()=>true,confirmRuntime:async()=>({verified:true,version:'1.2.3'})}})).ok,true);
  assert.equal((await loadIntoChromeMac('/test/extension',{expectedVersion:'1.2.3',deps:{exists:()=>true,confirmRuntime:async()=>({verified:true,version:'1.2.2'})}})).ok,false);
});
test('500 Mac setup polls never quit Chrome, start a browser or claim pinned markers as runtime',async()=>{
  let effects=0;
  const deps={exists:()=>true,confirmRuntime:async()=>null,chromeInstalls:()=>[{path:'/test/extension',pinned:true}],kill:()=>effects++,run:()=>effects++,spawnChrome:()=>effects++,openChrome:()=>effects++};
  for(let i=0;i<500;i++){const r=await loadIntoChromeMac('/test/extension',{expectedVersion:'1.2.3',deps});assert.equal(r.ok,false);assert.equal(r.userActionRequired,true);}
  assert.equal(effects,0);
});
test('missing Chrome is reported before any network check',async()=>{
  const r=await loadIntoChromeMac('/test/extension',{deps:{exists:()=>false,confirmRuntime:()=>{throw Error('must not run');}}});
  assert.equal(r.reason,'chrome_not_found');
});
