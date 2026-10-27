// CI-only probe (real macOS runner): does an extension loaded through the tool's CDP path SURVIVE closing Chrome?
//   node scripts/ci/persist-probe.mjs <waitMsBeforeQuit> <term|osa|kill>
// Starts Chrome on the default profile through the data-volume spelling (what the product does), loads the extension with the
// tool's own loadIntoChrome, waits, quits Chrome, then reports whether the profile now records the extension.
// Every wait is bounded and the whole script hard-exits after 150 s, so it can never spin.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadIntoChrome, closeCdp, openCdp } from '../setup-tool/chrome.mjs';

setTimeout(() => { console.log('RESULT hard-timeout'); process.exit(2); }, 150_000).unref();
const [waitArg = '1500', how = 'term'] = process.argv.slice(2);
const waitMs = Number(waitArg);
const ID = 'geokjdngpomhdgjamobhgokjgphnjaed';
// SNAP: what the profile's preference files say about extensions + their integrity MACs, at a named moment.
const snap = label => {
  const out = [];
  for (const f of ['Secure Preferences', 'Preferences']) {
    const q = path.join(userData, 'Default', f);
    if (!existsSync(q)) { out.push(f + ': missing'); continue; }
    const j = JSON.parse(readFileSync(q, 'utf8'));
    const e = j.extensions || {};
    out.push(`${f}: settings=${Object.keys(e.settings || {}).length} ours=${!!e.settings?.[ID]} ui=${JSON.stringify(e.ui)} pinned=${JSON.stringify(e.pinned_extensions)} macSettings=${Object.keys(j.protection?.macs?.extensions?.settings || {}).length} macOurs=${!!j.protection?.macs?.extensions?.settings?.[ID]} macDev=${!!j.protection?.macs?.extensions?.ui?.developer_mode} superMac=${!!j.protection?.super_mac}`);
  }
  console.log('SNAP ' + label + ' | ' + out.join(' || '));
};
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// NONDEFAULT=1: a throwaway --user-data-dir (no data-volume trick needed) as the control.
const nd = process.env.NONDEFAULT === '1';
const userData = nd ? path.join(os.tmpdir(), 'probe-profile') : path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
const alias = nd ? userData : path.posix.join('/System/Volumes/Data', userData);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mains = () => execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n')
  .filter(l => l.includes('Google Chrome.app/Contents/MacOS/Google Chrome ') && !/--type=/.test(l)).map(l => Number(l.trim().split(/\s+/)[0]));

// Fresh profile each time, like a Mac that has never had the extension. First Run sentinel = no Welcome dialog.
rmSync(userData, { recursive: true, force: true });
mkdirSync(userData, { recursive: true });
writeFileSync(path.join(userData, 'First Run'), '');
const extDir = path.join(os.tmpdir(), 'probe-ext');
rmSync(extDir, { recursive: true, force: true });
mkdirSync(extDir, { recursive: true });
const m = JSON.parse(readFileSync(new URL('../../extension/manifest.json', import.meta.url), 'utf8'));
writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(m));

const child = spawn(CHROME, [`--user-data-dir=${alias}`, '--remote-debugging-port=0', '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', 'about:blank'], { detached: true, stdio: 'ignore' });
child.unref();
const portFile = path.join(userData, 'DevToolsActivePort');
for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(250);
if (!existsSync(portFile)) { console.log('RESULT no-debug-port'); process.exit(1); }

// LOAD=drop: drop the folder on chrome://extensions, the way a person does (the control for Extensions.loadUnpacked).
async function loadByDrop() {
  const cdp = await openCdp(userData);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'chrome://extensions' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Target.activateTarget', { targetId }).catch(() => {});
  await cdp.send('Page.bringToFront', {}, sessionId).catch(() => {});
  const page = async ex => (await cdp.send('Runtime.evaluate', { expression: ex, awaitPromise: true, returnByValue: true }, sessionId)).result?.value;
  await sleep(2500);
  await page('chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })');
  await sleep(1000);
  console.log('DROP devmode=' + await page('chrome.developerPrivate.getProfileConfiguration().then(c => String(c.inDeveloperMode))') + ' viewport=' + await page('innerWidth + "x" + innerHeight'));
  // Report what the page's own drop handler sees, so a failure says WHY.
  await page("window.__dropSeen = []; for (const t of ['dragenter','dragover','drop']) document.addEventListener(t, e => window.__dropSeen.push(t + ':' + [...(e.dataTransfer?.types || [])].join('|') + ':' + (e.dataTransfer?.items?.length ?? -1) + ':' + (e.dataTransfer?.items?.[0]?.webkitGetAsEntry?.()?.isDirectory)), true); 1");
  const data = { items: [], files: [extDir], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'dragOver', 'drop']) { await cdp.send('Input.dispatchDragEvent', { type, x: 400, y: 300, data }, sessionId); await sleep(700); }
  console.log('DROP seen=' + await page('JSON.stringify(window.__dropSeen)'));
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if (await page(`chrome.developerPrivate.getExtensionsInfo().then(a => a.some(x => x.id === '${ID}'))`)) return { ok: true };
  }
  return { ok: false, reason: 'drop_no_effect' };
}
// LOAD=devmode: no extension at all - only flip Developer mode (a Chrome-validated pref) to see if ANY such change survives a restart here.
async function setDevMode() {
  const cdp = await openCdp(userData);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'chrome://extensions' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await sleep(2000);
  await cdp.send('Runtime.evaluate', { expression: 'chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })', awaitPromise: true, returnByValue: true }, sessionId);
  return { ok: true };
}
const load = process.env.LOAD === 'devmode' ? await setDevMode().catch(e => ({ ok: false, reason: e.message })) : process.env.LOAD === 'drop' ? await loadByDrop().catch(e => ({ ok: false, reason: 'drop_error:' + e.message })) : await loadIntoChrome(extDir, { userData });
closeCdp();
await sleep(waitMs);
if (how === 'term') { for (const p of mains()) try { process.kill(p, 'SIGTERM'); } catch { /* gone */ } }
else if (how === 'osa') { try { execFileSync('osascript', ['-e', 'tell application "Google Chrome" to quit'], { stdio: 'ignore', timeout: 10_000 }); } catch { /* ignore */ } }
else { for (const p of mains()) try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
let left = mains().length;
for (let i = 0; i < 40 && left; i++) { await sleep(500); left = mains().length; }
const stuck = left > 0;
if (stuck) for (const p of mains()) try { process.kill(p, 'SIGKILL'); } catch { /* gone */ }
await sleep(500);
snap('after the debug session was quit');

let entry = null; let pinned = false;
for (const f of ['Secure Preferences', 'Preferences']) {
  const p = path.join(userData, 'Default', f);
  if (!existsSync(p)) continue;
  const e = JSON.parse(readFileSync(p, 'utf8')).extensions || {};
  if (e.settings?.[ID]) entry = { file: f, path: e.settings[ID].path, location: e.settings[ID].location };
  if ((e.pinned_extensions || []).includes(ID)) pinned = true;
}
if (process.env.DIAG === '1') {
  const sp = JSON.parse(readFileSync(path.join(userData, 'Default', 'Secure Preferences'), 'utf8'));
  const raw = sp.extensions?.settings?.[ID];
  if (raw) { const { manifest, ...rest } = raw; console.log('DIAG entry ' + JSON.stringify(rest).slice(0, 900)); }
  { const pr = JSON.parse(readFileSync(path.join(userData, 'Default', 'Preferences'), 'utf8')); console.log('DIAG devMode-in-Preferences=' + pr.extensions?.ui?.developer_mode + ' | devMode-mac-present=' + JSON.stringify(!!sp.protection?.macs?.extensions?.ui?.developer_mode)); }
  console.log('DIAG macs ' + JSON.stringify(Object.keys(sp.protection?.macs?.extensions?.settings || {})).slice(0, 300));
}
console.log(`RESULT load=${process.env.LOAD || 'cdp'} nondefault=${nd} wait=${waitMs}ms quit=${how} load=${load.ok ? 'ok' : 'FAIL:' + load.reason} chromeStuck=${stuck} persisted=${entry ? 'YES ' + JSON.stringify(entry) : 'NO'} pinned=${pinned}`);

// Phase 2 - what a USER does next: start Chrome normally (no flags, no port), look at chrome://extensions, then close it again.
const dump = () => {
  let loc = null; let pin = false; let why = null; let dev = null;
  for (const f of ['Secure Preferences', 'Preferences']) {
    const p = path.join(userData, 'Default', f);
    if (!existsSync(p)) continue;
    const e = JSON.parse(readFileSync(p, 'utf8')).extensions || {};
    if (e.settings?.[ID]) { loc = e.settings[ID].location; why = JSON.stringify(e.settings[ID].disable_reasons ?? []); }
    if ((e.pinned_extensions || []).includes(ID)) pin = true;
    if (f === 'Preferences') dev = e.ui?.developer_mode;
  }
  return loc === null ? `ABSENT pinned=${pin} devMode=${dev}` : `PRESENT location=${loc} disable_reasons=${why} pinned=${pin} devMode=${dev}`;
};
const restart = process.env.RESTART || 'direct';
if (restart === 'open') execFileSync('/usr/bin/open', ['-n', '-a', 'Google Chrome', '--args', '--no-first-run', '--no-default-browser-check', 'chrome://extensions'], { stdio: 'ignore' });
else if (restart === 'alias') spawn(CHROME, [`--user-data-dir=${alias}`, '--no-first-run', '--no-default-browser-check', 'chrome://extensions'], { detached: true, stdio: 'ignore' }).unref();
else if (restart === 'aliasport') spawn(CHROME, [`--user-data-dir=${alias}`, '--remote-debugging-port=0', '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', 'chrome://extensions'], { detached: true, stdio: 'ignore' }).unref();
else if (process.env.DIAG === '1') {
  const { openSync } = await import('node:fs');
  const fd = openSync('/tmp/chrome-restart.log', 'w');
  spawn(CHROME, [`--user-data-dir=${alias}`, '--enable-logging=stderr', '--v=0', '--no-first-run', '--no-default-browser-check', 'chrome://extensions'], { detached: true, stdio: ['ignore', fd, fd] }).unref();
} else spawn(CHROME, ['--no-first-run', '--no-default-browser-check', 'chrome://extensions'], { detached: true, stdio: 'ignore' }).unref();
await sleep(15_000);
const running = dump();
mkdirSync('/tmp/shots', { recursive: true });
try { execFileSync('/usr/sbin/screencapture', ['-x', `/tmp/shots/restart-${waitMs}-${how}-${restart}.png`]); } catch { /* no display */ }
for (const p of mains()) try { process.kill(p, 'SIGTERM'); } catch { /* gone */ }
for (let i = 0; i < 40 && mains().length; i++) await sleep(500);
for (const p of mains()) try { process.kill(p, 'SIGKILL'); } catch { /* gone */ }
await sleep(500);
if (process.env.DIAG === '1' && existsSync('/tmp/chrome-restart.log')) for (const l of readFileSync('/tmp/chrome-restart.log', 'utf8').split(String.fromCharCode(10)).filter(l => /xtension|pref|reset|corrupt|hash|mac|developer|unpacked/i.test(l)).slice(0, 25)) console.log('DIAGLOG ' + l.slice(0, 240));
snap('after a normal start + quit');
console.log(`RESULT2 load=${process.env.LOAD || 'cdp'} nondefault=${nd} restart=${restart} afterNormalStartWhileRunning=${running} afterNormalStartAndQuit=${dump()}`);
process.exit(0);
