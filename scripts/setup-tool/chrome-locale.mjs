// Read Chrome's installed locale resources for native control selectors. No UI, downloads or generated translations.
// DataPack layout: chromium/tools/grit/grit/format/data_pack.py (versions4/5 and alias entries).
import {readFileSync,readdirSync,existsSync,realpathSync} from 'node:fs';
import path from 'node:path';

const invalid=()=>{throw Error('invalid_chrome_locale_pack');};
export function readChromePack(bytes) {
  if(!Buffer.isBuffer(bytes)||bytes.length<9||bytes.length>32*1024*1024)invalid();
  const version=bytes.readUInt32LE(0);
  let count,aliases=0,encoding,header;
  if(version===4){count=bytes.readUInt32LE(4);encoding=bytes[8];header=9;}
  else if(version===5&&bytes.length>=12){encoding=bytes[4];count=bytes.readUInt16LE(8);aliases=bytes.readUInt16LE(10);header=12;}
  else invalid();
  const tableEnd=header+(count+1)*6+aliases*4;
  if(count>65535||![0,1,2].includes(encoding)||tableEnd>bytes.length)invalid();
  const entry=i=>({id:bytes.readUInt16LE(header+i*6),offset:bytes.readUInt32LE(header+i*6+2)});
  const resources=new Map(),ids=[];
  let previous=entry(0);
  if(previous.offset<tableEnd||previous.offset>bytes.length)invalid();
  for(let i=0;i<count;i++) {
    const next=entry(i+1);
    if(!previous.id||i&&previous.id<=ids[i-1]||next.offset<previous.offset||next.offset>bytes.length)invalid();
    ids.push(previous.id);resources.set(previous.id,bytes.subarray(previous.offset,next.offset));previous=next;
  }
  if(previous.offset!==bytes.length)invalid();
  for(let i=0;i<aliases;i++) {
    const at=header+(count+1)*6+i*4,id=bytes.readUInt16LE(at),index=bytes.readUInt16LE(at+2);
    if(!id||index>=count||resources.has(id))invalid();
    resources.set(id,resources.get(ids[index]));
  }
  return {encoding,resources};
}
export const normalizeChromeLabel=value=>String(value||'').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,'').replace(/\s+/g,' ').trim();
function text(pack,id) {
  const bytes=pack.resources.get(id);
  if(!bytes||![1,2].includes(pack.encoding))return '';
  try{return normalizeChromeLabel(new TextDecoder(pack.encoding===2?'utf-16le':'utf-8',{fatal:true}).decode(bytes).replace(/\0+$/,''));}
  catch{return '';}
}
const directories=root=>{try{return readdirSync(root,{withFileTypes:true}).filter(e=>e.isDirectory()||e.isSymbolicLink()).map(e=>e.name);}catch{return [];}};
export function chromePinLabels(chrome,platform=process.platform) {
  const labels=new Set(['Pin to toolbar','Pin to Toolbar']),groups=[];
  if(platform==='win32') {
    const application=path.dirname(chrome);
    for(const root of [application,...directories(application).filter(n=>/^\d+(?:\.\d+){1,3}$/.test(n)).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true})).slice(0,3).map(n=>path.join(application,n))]) {
      const folder=path.join(root,'Locales');
      if(existsSync(path.join(folder,'en-US.pak'))) {
        const files=readdirSync(folder).filter(n=>/^[\w-]+\.pak$/.test(n)).slice(0,150).map(n=>path.join(folder,n));
        groups.push({english:path.join(folder,'en-US.pak'),files});
      }
    }
  } else if(platform==='darwin') {
    const versions=path.resolve(path.dirname(chrome),'..','Frameworks','Google Chrome Framework.framework','Versions'),seen=new Set();
    for(const version of ['Current',...directories(versions).filter(n=>/^\d+(?:\.\d+){1,3}$/.test(n)).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true})).slice(0,3)]) {
      const folder=path.join(versions,version,'Resources');let real;
      try{real=realpathSync(folder);}catch{continue;}
      if(seen.has(real))continue;seen.add(real);
      const english=['en','en_US','en-US'].map(n=>path.join(folder,n+'.lproj','locale.pak')).find(existsSync);
      if(english)groups.push({english,files:directories(folder).filter(n=>/^[\w-]+\.lproj$/.test(n)).slice(0,150).map(n=>path.join(folder,n,'locale.pak'))});
    }
  }
  for(const group of groups) {
    try {
      const english=readChromePack(readFileSync(group.english));
      const ids=[...english.resources.keys()].filter(id=>text(english,id).toLowerCase()==='pin to toolbar');
      if(!ids.length)continue;
      for(const file of group.files)try {
        const translated=readChromePack(readFileSync(file));
        for(const id of ids){const value=text(translated,id);if(value&&value.length<=200&&!/[\x00-\x1f]/.test(value))labels.add(value);}
      }catch{/* A missing/corrupt locale cannot justify selecting a different control. */}
    }catch{/* English fallback selects only the exact English label, never a positional toggle. */}
  }
  return [...labels];
}
