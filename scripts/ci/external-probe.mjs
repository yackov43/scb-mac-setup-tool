// CI-only probe (real macOS runner): does Chrome install + KEEP the extension from an "External Extensions" JSON in the profile?
//   VARIANT=crx|url node scripts/ci/external-probe.mjs
// No debugging port, no CDP, no quit of a user's Chrome: the file is written, Chrome is started the normal way.
// Every wait is bounded; the whole script hard-exits after 170 s.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

setTimeout(() => { console.log('RESULT hard-timeout'); process.exit(2); }, 170_000).unref();
const variant = process.env.VARIANT || 'crx';
const SITE = process.env.SITE || 'https://46-225-2-111.sslip.io';
const ID = 'geokjdngpomhdgjamobhgokjgphnjaed';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const userData = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mains = () => execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n')
  .filter(l => l.includes('Google Chrome.app/Contents/MacOS/Google Chrome ') && !/--type=/.test(l)).map(l => Number(l.trim().split(/\s+/)[0]));
const shot = name => { try { mkdirSync('/tmp/shots', { recursive: true }); execFileSync('/usr/sbin/screencapture', ['-x', `/tmp/shots/external-${variant}-${name}.png`]); } catch { /* no display */ } };
const state = () => {
  for (const f of ['Secure Preferences', 'Preferences']) {
    const p = path.join(userData, 'Default', f);
    if (!existsSync(p)) continue;
    const s = JSON.parse(readFileSync(p, 'utf8')).extensions?.settings?.[ID];
    if (s) return `PRESENT location=${s.location} state=${s.state} disable_reasons=${JSON.stringify(s.disable_reasons ?? [])} from_webstore=${s.from_webstore} version=${s.manifest?.version}`;
  }
  return 'ABSENT';
};
const quit = async () => {
  for (const p of mains()) try { process.kill(p, 'SIGTERM'); } catch { /* gone */ }
  for (let i = 0; i < 30 && mains().length; i++) await sleep(500);
  for (const p of mains()) try { process.kill(p, 'SIGKILL'); } catch { /* gone */ }
  await sleep(500);
};
const start = () => spawn(CHROME, ['--no-first-run', '--no-default-browser-check', 'chrome://extensions'], { detached: true, stdio: 'ignore' }).unref();

rmSync(userData, { recursive: true, force: true });
mkdirSync(path.join(userData, 'External Extensions'), { recursive: true });
writeFileSync(path.join(userData, 'First Run'), '');
let json;
if (variant === 'crx') {
  const crx = path.join(os.tmpdir(), 'scb-hosted.crx');
  execFileSync('/usr/bin/curl', ['-fsSL', '-m', '60', '-o', crx, `${SITE}/scb-extension-hosted.crx`]);
  const v = JSON.parse(execFileSync('/usr/bin/curl', ['-fsSL', '-m', '30', `${SITE}/extension-version.json`], { encoding: 'utf8' })).version;
  json = { external_crx: crx, external_version: v };
} else json = { external_update_url: `${SITE}/extension-updates.xml` };
writeFileSync(path.join(userData, 'External Extensions', `${ID}.json`), JSON.stringify(json));
console.log('JSON ' + JSON.stringify(json));

start();
let first = 'ABSENT';
for (let i = 0; i < 20; i++) { await sleep(2000); first = state(); if (first !== 'ABSENT') break; } // up to 40 s
await sleep(3000);
shot('1-first-start');
await quit();
const afterQuit = state();
start();
await sleep(15_000);
const afterRestart = state();
shot('2-second-start');
await quit();
console.log(`RESULT variant=${variant} firstStart=${first} | afterQuit=${afterQuit} | afterSecondStart=${afterRestart} | afterSecondQuit=${state()}`);
process.exit(0);
