// macOS: put the extension into the user's REAL Chrome profile with no manual step (owner, 2026-10-26: "everything automatic").
//
// Why this exists: since Chrome 136 a debugging port is only honoured for a NON-default --user-data-dir, and the toggle that
// allows it for the default profile needs a human click. Windows has an auto-clicker for that click; a Mac has none.
// MEASURED on a real macOS runner (Chrome 156, public repo yackov43/scb-mac-setup-tool, workflow "Chrome profile path probe"):
// Chrome resolves the path first, so a symlink alias, a lower-case spelling, `/./`, `/../` and `//` are all still "the default"
// and get no port. ONE spelling of the same folder is not recognised: the data-volume path, `/System/Volumes/Data` + the usual
// path (the same physical folder, reached through macOS's firmlink). Chrome accepts a debugging port there. So, once, at first
// install only:
//   1. quit the user's Chrome gracefully (SIGTERM = Chrome's own clean shutdown, session saved),
//   2. start it again on the data-volume spelling with a debugging port and `--restore-last-session` (windows and tabs come back),
//   3. load + pin the extension through the tool's normal Chrome step,
//   4. quit that instance and start Chrome normally (restoring the session again). The debugging port is never left open.
// MEASURED (2026-10-27, real macOS runners, Chrome 156) - what does NOT work, so nobody tries it again:
//   - An extension loaded through CDP `Extensions.loadUnpacked` is written to the profile on quit but removed by Chrome at its next
//     normal start (also in a throwaway profile, so it is not the data-volume path). It lives for the Chrome session this tool drove.
//   - An "External Extensions" JSON (external_crx or external_update_url) installs and survives restarts, but Chrome 156 flags it
//     `suspiciousInstall` (off-store) and disables it; chrome.management.setEnabled answers "cannot be modified by user".
//   - Dropping the folder on chrome://extensions through CDP reaches the page's drop handler (isDirectory=true) but loads nothing.
// Because the load is per-session, this step must restart the user's Chrome AT MOST ONCE per run: the engine polls it, and a restart
// per poll piled 25+ chrome://extensions tabs into a real Chrome and pegged the machine (measured, then guarded: see SESSION below).
// The scheduled LaunchAgent never does any of this: an up-to-date or self-updating install must not touch Chrome.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadIntoChrome, closeCdp } from './chrome.mjs';
import { chromeInstalls } from './lib.mjs';

export const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const defaultUserData = () => path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
// The same folder as defaultUserData(), spelled through the data volume (see the header).
export const dataVolumePath = p => path.posix.join('/System/Volumes/Data', p);
const aliasDir = () => dataVolumePath(defaultUserData());
const same = (a, b) => path.resolve(a) === path.resolve(b);
const markerPath = () => path.join(os.homedir(), 'Library', 'Application Support', 'SunoCoverBot', 'setup', 'chrome-relaunch-failed.json');
// If Chrome never opened a debugging port on the alias, the idea does not work on this Mac/Chrome: do not restart the user's Chrome again for nothing.
const MARKER_TTL_MS = 14 * 24 * 60 * 60 * 1000;
// Any OTHER failed restart (e.g. the extension could not be accepted) is remembered for a few hours: the engine polls this step, and a Mac
// whose Chrome gets quit and restarted on every poll is exactly the loop that must never exist.
const RELAUNCH_FAILED_TTL_MS = 6 * 60 * 60 * 1000;
const MARKER_TTLS = { debug_port_missing: MARKER_TTL_MS, relaunch_failed: RELAUNCH_FAILED_TTL_MS };
// At most ONE disruptive restart of the user's Chrome per process, whatever the outcome (the engine calls this step repeatedly).
const SESSION = { relaunched: false };
const logPath = () => path.join(os.homedir(), 'Library', 'Application Support', 'SunoCoverBot', 'setup', 'mac-chrome.log');
/** Small support trail (kept under ~20 KB): what the Chrome step decided and why. Never throws. */
function appendLog(line) {
  try {
    const file = logPath();
    mkdirSync(path.dirname(file), { recursive: true });
    try { if (statSync(file).size > 20_000) rmSync(file, { force: true }); } catch { /* new file */ }
    appendFileSync(file, new Date().toISOString().slice(0, 19) + ' ' + line + String.fromCharCode(10));
  } catch { /* logging must never break the install */ }
}

/** Main processes of the USER's Chrome. The setup window is also a Chrome (its own --user-data-dir, inside `windowProfile`): never touched. */
export function userChromePids(psOutput, { windowProfile = path.join(os.homedir(), 'Library', 'Application Support', 'SunoCoverBot', 'setup', 'window-profile'), alias = aliasDir() } = {}) {
  const pids = [];
  for (const line of String(psOutput).split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, pid, command] = m;
    if (!command.startsWith(CHROME_BIN)) continue;
    if (/\s--type=/.test(command)) continue; // renderer/gpu/utility helpers
    if (command.includes(windowProfile)) continue; // our own setup window
    // Our own debugging instance is found by `alias` below; every other main process is the user's Chrome.
    if (command.includes(alias)) { pids.push({ pid: Number(pid), ours: true }); continue; }
    pids.push({ pid: Number(pid), ours: false });
  }
  return pids;
}

const listChrome = d => userChromePids(d.run('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }), { alias: d.alias, windowProfile: d.windowProfile });

async function quit(pids, d) {
  const { kill, sleep, timeoutMs } = d;
  for (const p of pids) { try { kill(p.pid, 'SIGTERM'); } catch { /* already gone */ } }
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const left = listChrome(d).filter(p => pids.some(q => q.pid === p.pid));
    if (left.length === 0) return true;
    await sleep(250);
  }
  return false;
}

/**
 * @returns {{ok:boolean, version?:string, reason?:string, relaunched?:boolean}} same shape as loadIntoChrome.
 * `deps` exists for the tests: every process, file and sleep is injectable.
 */
export async function loadIntoChromeMac(directory, { expectedVersion = null, deps = {} } = {}) {
  const d = {
    run: execFileSync, kill: process.kill.bind(process), sleep: ms => new Promise(r => setTimeout(r, ms)),
    loadIntoChrome, closeCdp, chromeInstalls, exists: existsSync, mkdir: mkdirSync, rm: rmSync,
    spawnChrome: args => { const c = spawn(CHROME_BIN, args, { detached: true, stdio: 'ignore' }); c.unref(); return c; },
    openChrome: args => // -n: the setup window is ALSO a running Chrome; without it `open` would hand the request to that one and start nothing.
    execFileSync('/usr/bin/open', ['-n', '-a', 'Google Chrome', '--args', ...args], { stdio: 'ignore' }),
    readFile: p => readFileSync(p, 'utf8'), writeFile: writeFileSync, marker: markerPath(), now: Date.now, session: SESSION, log: appendLog,
    userData: defaultUserData(), alias: aliasDir(), windowProfile: path.join(os.homedir(), 'Library', 'Application Support', 'SunoCoverBot', 'setup', 'window-profile'), quitMs: 20_000, portMs: 25_000, ...deps,
  };

  // 1) Chrome may already be drivable (the user turned remote debugging on, or this is a re-run): the normal step, no restart.
  const first = await d.loadIntoChrome(directory, { expectedVersion });
  if (first.ok) return first;
  if (!['debugging_off', 'permission_pending', 'connection_closed'].includes(first.reason)) return first;

  // 2) Already installed AND pinned from this very folder (a manual install, or an earlier run): never restart Chrome for nothing.
  if (d.chromeInstalls(d.userData).some(c => c.pinned && same(c.path, directory))) return { ok: true, reason: 'already_installed', version: expectedVersion || undefined };

  // A previous attempt proved the alias gives no debugging port here: fall back to the manual step without touching Chrome.
  try {
    const m = JSON.parse(d.readFile(d.marker));
    const ttl = MARKER_TTLS[m?.reason];
    if (ttl && d.now() - Number(m.at || 0) < ttl) return { ok: false, reason: 'relaunch_disabled' };
  } catch { /* no marker */ }

  // Checked BEFORE anything is quit: never close the user's Chrome when we cannot start it again.
  if (!d.exists(CHROME_BIN)) return { ok: false, reason: 'chrome_not_found' };

  // The data-volume spelling must exist (macOS 10.15+); otherwise there is nothing to try and nothing is quit.
  if (!d.exists(d.alias)) return { ok: false, reason: 'data_volume_path_missing' };

  // This process already restarted the user's Chrome once and it did not end in success: do NOT do it again (the caller polls).
  if (d.session.relaunched) return { ok: false, reason: 'relaunch_already_done' };

  const before = listChrome(d).filter(p => !p.ours);
  const wasRunning = before.length > 0;
  if (wasRunning && !(await quit(before, { ...d, timeoutMs: d.quitMs }))) return { ok: false, reason: 'chrome_did_not_quit' };
  d.session.relaunched = true; // Chrome is really down now: this is the one and only restart of this run
  d.log('relaunch: user Chrome ' + (wasRunning ? 'quit' : 'was not running') + ', starting the debug instance');

  const portFile = path.join(d.userData, 'DevToolsActivePort');
  d.rm(portFile, { force: true }); // a stale file from an earlier run would point at a dead port
  try { d.spawnChrome([`--user-data-dir=${d.alias}`, '--remote-debugging-port=0', '--enable-unsafe-extension-debugging', '--restore-last-session', '--no-first-run', '--no-default-browser-check']); }
  catch (error) { if (wasRunning) { try { d.openChrome(['--restore-last-session']); } catch { /* user reopens Chrome */ } } return { ok: false, reason: 'chrome_start_failed:' + (error?.message || error) }; }
  const portUntil = Date.now() + d.portMs;
  while (Date.now() < portUntil && !d.exists(portFile)) await d.sleep(200);

  let result = { ok: false, reason: 'debug_port_missing' };
  if (!d.exists(portFile)) { try { d.mkdir(path.dirname(d.marker), { recursive: true }); d.writeFile(d.marker, JSON.stringify({ reason: 'debug_port_missing', at: d.now() })); } catch { /* best effort */ } }
  if (d.exists(portFile)) {
    result = await d.loadIntoChrome(directory, { expectedVersion });
    d.log('load -> ' + JSON.stringify(result));
    // Give Chrome a moment to persist the extension + its toolbar pin before it is closed.
    if (result.ok) await d.sleep(1500);
  }

  // 4) Always leave Chrome as we found it: no debugging port, session restored, running only if it was running.
  try { d.closeCdp(); } catch { /* already closed */ }
  const ours = listChrome(d).filter(p => p.ours);
  if (ours.length) await quit(ours, { ...d, timeoutMs: d.quitMs });
  d.rm(portFile, { force: true });
  if (wasRunning) { try { d.openChrome(['--restore-last-session']); } catch { /* Chrome stays closed; the user opens it as usual */ } }
  if (!result.ok && result.reason !== 'debug_port_missing') { try { d.mkdir(path.dirname(d.marker), { recursive: true }); d.writeFile(d.marker, JSON.stringify({ reason: 'relaunch_failed', detail: String(result.reason || ''), at: d.now() })); } catch { /* best effort */ } }
  d.log('relaunch finished -> ' + JSON.stringify({ ok: result.ok, reason: result.reason }));
  return { ...result, relaunched: true };
}
