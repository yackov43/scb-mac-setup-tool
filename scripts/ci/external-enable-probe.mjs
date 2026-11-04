// CI-only probe (real macOS runner): why can chrome.management.setEnabled not accept the externally installed extension?
//   VARIANT=crx|url node scripts/ci/external-enable-probe.mjs
// Writes the External Extensions file, starts Chrome on the data-volume path with a debugging port, waits (bounded) for the extension,
// prints what Chrome says about it (userMayModify, controlledInfo, disableReasons) and tries each way of enabling it.
// Hard exit after 170 s; every wait is bounded.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openCdp, closeCdp } from '../setup-tool/chrome.mjs';

setTimeout(() => { console.log('RESULT hard-timeout'); process.exit(2); }, 170_000).unref();
const variant = process.env.VARIANT || 'url';
const SITE = process.env.SITE || 'https://46-225-2-111.sslip.io';
const ID = 'geokjdngpomhdgjamobhgokjgphnjaed';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const userData = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
const alias = path.posix.join('/System/Volumes/Data', userData);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mains = () => execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n')
  .filter(l => l.includes('Google Chrome.app/Contents/MacOS/Google Chrome ') && !/--type=/.test(l)).map(l => Number(l.trim().split(/\s+/)[0]));

console.log('MANAGED ' + (existsSync('/Library/Managed Preferences') ? JSON.stringify(readdirSync('/Library/Managed Preferences')) : 'none'));
try { console.log('DEFAULTS ' + execFileSync('/usr/bin/defaults', ['read', 'com.google.Chrome'], { encoding: 'utf8' }).slice(0, 300).replace(/\s+/g, ' ')); } catch { console.log('DEFAULTS none'); }

rmSync(userData, { recursive: true, force: true });
mkdirSync(path.join(userData, 'External Extensions'), { recursive: true });
writeFileSync(path.join(userData, 'First Run'), '');
let json;
if (variant === 'crx') {
  const crx = path.join(os.tmpdir(), 'scb-hosted.crx');
  execFileSync('/usr/bin/curl', ['-fsSL', '-m', '60', '-o', crx, `${SITE}/scb-extension-hosted.crx`]);
  json = { external_crx: crx, external_version: JSON.parse(execFileSync('/usr/bin/curl', ['-fsSL', '-m', '30', `${SITE}/extension-version.json`], { encoding: 'utf8' })).version };
} else json = { external_update_url: `${SITE}/extension-updates.xml` };
writeFileSync(path.join(userData, 'External Extensions', `${ID}.json`), JSON.stringify(json));

spawn(CHROME, [`--user-data-dir=${alias}`, '--remote-debugging-port=0', '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', 'about:blank'], { detached: true, stdio: 'ignore' }).unref();
const portFile = path.join(userData, 'DevToolsActivePort');
for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(250);
if (!existsSync(portFile)) { console.log('RESULT no-debug-port'); process.exit(1); }

const cdp = await openCdp(userData);
const { targetId } = await cdp.send('Target.createTarget', { url: 'chrome://extensions' });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
const page = async ex => {
  const r = await cdp.send('Runtime.evaluate', { expression: ex, awaitPromise: true, returnByValue: true }, sessionId);
  return r.exceptionDetails ? 'ERR ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).split('\n')[0] : r.result.value;
};
const info = () => page(`chrome.developerPrivate.getExtensionsInfo().then(a => JSON.stringify(a.filter(x => x.id === '${ID}').map(x => ({ state: x.state, location: x.location, userMayModify: x.userMayModify, controlledInfo: x.controlledInfo, disableReasons: x.disableReasons, fromWebstore: x.fromWebstore, mustRemainInstalled: x.mustRemainInstalled, pinnedToToolbar: x.pinnedToToolbar }))))`);
let seen = '[]';
for (let i = 0; i < 90 && seen === '[]'; i++) { await sleep(500); seen = String(await info()); if (seen.startsWith('ERR')) seen = '[]'; }
console.log(`INFO variant=${variant} ${seen}`);
const tryIt = async (label, ex) => { const r = await page(ex); await sleep(800); console.log(`TRY ${label} -> ${String(r).slice(0, 160)} | now ${String(await info()).slice(0, 220)}`); };
await tryIt('management.setEnabled', `chrome.management.setEnabled('${ID}', true).then(() => 'resolved')`);
await tryIt('developerPrivate.updateExtensionConfiguration(pin)', `chrome.developerPrivate.updateExtensionConfiguration({ extensionId: '${ID}', pinnedToToolbar: true }).then(() => 'resolved')`);
await tryIt('developerPrivate.reload', `chrome.developerPrivate.reload('${ID}', { failQuietly: true }).then(() => 'resolved')`);
console.log('FNS ' + await page('Object.keys(chrome.developerPrivate).filter(k => /nable|isable|llow|ccept|xternal|cknow/i.test(k)).join(",")'));
closeCdp();
for (const p of mains()) try { process.kill(p, 'SIGTERM'); } catch { /* gone */ }
await sleep(3000);
for (const p of mains()) try { process.kill(p, 'SIGKILL'); } catch { /* gone */ }
console.log('RESULT done');
process.exit(0);
