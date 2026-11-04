// CI-only probe (real macOS runner): can the setup tool add the extension PERSISTENTLY to a Chrome that runs normally on the
// DEFAULT profile - no restart, no command-line flags, no Accessibility for the tool - through Chrome's own approval mode?
//   node scripts/ci/approval-probe.mjs
// Approval mode = chrome://inspect/#remote-debugging "Allow remote debugging" (Local State devtools.remote_debugging.user-enabled).
// Chromium main: an approved browser connection is a trusted client on the browser target, so Extensions.loadUnpacked is
// available (chrome_devtools_session.cc); the CDP load is then made permanent by one developerPrivate.reload (see persist-probe).
// The runner stands in for the person: it ticks the setting by writing Local State before Chrome starts, and clicks Allow.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

setTimeout(() => { console.log('RESULT hard-timeout'); process.exit(2); }, 170_000).unref();
const ID = 'geokjdngpomhdgjamobhgokjgphnjaed';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const userData = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = name => { try { mkdirSync('/tmp/shots', { recursive: true }); execFileSync('/usr/sbin/screencapture', ['-x', `/tmp/shots/approval-${name}.png`], { timeout: 10_000 }); } catch { /* no display */ } };
const mains = () => execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n')
  .filter(l => l.includes('Google Chrome.app/Contents/MacOS/Google Chrome') && !/--type=/.test(l)).map(l => Number(l.trim().split(/\s+/)[0]));
const quit = async () => {
  for (const p of mains()) try { process.kill(p, 'SIGTERM'); } catch { /* gone */ }
  for (let i = 0; i < 40 && mains().length; i++) await sleep(500);
  for (const p of mains()) try { process.kill(p, 'SIGKILL'); } catch { /* gone */ }
  await sleep(800);
};
const entry = () => {
  const p = path.join(userData, 'Default', 'Secure Preferences');
  if (!existsSync(p)) return 'NO-SECURE-PREFS';
  const e = JSON.parse(readFileSync(p, 'utf8')).extensions || {};
  const x = e.settings?.[ID];
  return x ? `PRESENT location=${x.location} creation_flags=${x.creation_flags} disable_reasons=${JSON.stringify(x.disable_reasons ?? [])} devMode=${e.ui?.developer_mode}` : `ABSENT devMode=${e.ui?.developer_mode}`;
};

// A Mac whose Chrome has never had the extension, and whose person ticked "Allow remote debugging" once.
rmSync(userData, { recursive: true, force: true });
mkdirSync(userData, { recursive: true });
writeFileSync(path.join(userData, 'First Run'), '');
writeFileSync(path.join(userData, 'Local State'), JSON.stringify({ devtools: { remote_debugging: { 'user-enabled': true } } }));
const extDir = path.join(os.homedir(), 'Documents', 'SunoCoverBot', 'extension');
rmSync(extDir, { recursive: true, force: true });
mkdirSync(extDir, { recursive: true });
writeFileSync(path.join(extDir, 'manifest.json'), readFileSync(new URL('../../extension/manifest.json', import.meta.url), 'utf8'));

// Chrome exactly as a person starts it: no flags at all.
spawn(CHROME, ['--no-first-run', '--no-default-browser-check', 'about:blank'], { detached: true, stdio: 'ignore' }).unref();
const portFile = path.join(userData, 'DevToolsActivePort');
for (let i = 0; i < 80 && !existsSync(portFile); i++) await sleep(250);
console.log('APPROVAL portFile=' + (existsSync(portFile) ? JSON.stringify(readFileSync(portFile, 'utf8')) : 'MISSING'));
if (!existsSync(portFile)) { shot('no-port'); console.log('RESULT approval=unavailable reason=no_DevToolsActivePort'); await quit(); process.exit(0); }
const [port, wsPath] = readFileSync(portFile, 'utf8').split('\n').map(s => s.trim());

// The person clicks Allow (the runner does it through Accessibility, which only the RUNNER has; the product never needs it).
const clicker = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `
  const p = Application('System Events').processes.byName('Google Chrome'); let seen = [];
  for (let t = 0; t < 60; t++) {
    try { for (const w of p.windows()) for (const e of w.entireContents()) { try {
      if (e.role() !== 'AXButton') continue; const n = String(e.name() || e.description() || ''); seen.push(n);
      if (/^allow$/i.test(n)) { e.click(); console.log('CLICKED ' + n); t = 99; break; } } catch (_) {} } } catch (_) {}
    if (t < 99) delay(0.5); else break;
  }
  console.log('BUTTONS ' + JSON.stringify([...new Set(seen)].slice(0, 30)));`], { stdio: ['ignore', 'pipe', 'pipe'] });
clicker.stdout.on('data', d => process.stdout.write('AX ' + d)); clicker.stderr.on('data', d => process.stdout.write('AXERR ' + d));
await sleep(300);

const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
let next = 0; const pending = new Map();
ws.onmessage = ev => { const d = JSON.parse(ev.data); const p = d.id && pending.get(d.id); if (p) { pending.delete(d.id); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result); } };
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); setTimeout(() => { if (pending.delete(id)) reject(new Error('timeout ' + method)); }, 20_000); });
const opened = await new Promise(resolve => { ws.onopen = () => resolve('open'); ws.onerror = () => resolve('error'); ws.onclose = e => resolve('closed ' + (e.code || '')); setTimeout(() => resolve('timeout'), 40_000); });
await sleep(1500); shot('after-connect');
console.log('APPROVAL connect=' + opened);
if (opened !== 'open') { console.log('RESULT approval=connect_failed:' + opened); await quit(); process.exit(0); }

let loadRes;
try { loadRes = 'ok:' + (await send('Extensions.loadUnpacked', { path: extDir })).id; } catch (e) { loadRes = 'ERR:' + e.message; }
console.log('APPROVAL Extensions.loadUnpacked=' + loadRes);
let reload = 'skipped', after = 'skipped';
if (loadRes.startsWith('ok')) {
  const { targetId } = await send('Target.createTarget', { url: 'chrome://extensions', background: true });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = async ex => (await send('Runtime.evaluate', { expression: ex, awaitPromise: true, returnByValue: true }, sessionId)).result?.value;
  for (let i = 0; i < 40 && !(await page('typeof chrome !== "undefined" && !!chrome.developerPrivate').catch(() => false)); i++) await sleep(250);
  await page('chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })');
  reload = await page(`chrome.developerPrivate.reload('${ID}', { failQuietly: true }).then(() => 'ok', e => 'ERR ' + e.message)`);
  for (let i = 0; i < 20; i++) { await sleep(250); after = await page(`chrome.developerPrivate.getExtensionInfo('${ID}').then(i => i.location + '/' + i.state, e => 'ERR ' + e.message)`); if (/ENABLED/.test(after)) break; }
  await send('Target.closeTarget', { targetId }).catch(() => {});
}
ws.close();
await sleep(1000);
await quit();
const afterQuit = entry();
// What the person does next: start Chrome normally again; Chrome's startup cleanup would delete a CDP-only extension here.
spawn(CHROME, ['--no-first-run', '--no-default-browser-check', 'about:blank'], { detached: true, stdio: 'ignore' }).unref();
await sleep(12_000); shot('normal-restart');
await quit();
console.log(`RESULT approval=connected load=${loadRes} reload=${reload} state=${after} afterQuit=${afterQuit} afterNormalRestart=${entry()}`);
try { clicker.kill(); } catch { /* done */ }
process.exit(0);
