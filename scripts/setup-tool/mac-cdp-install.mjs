// macOS step 4: add the extension to the person's OWN running Chrome, persistently, with no Chrome restart, no
// command-line flags and no Accessibility permission. Measured end to end on GitHub's macOS 15.8 runner with Chrome
// 156.0.8078.74 (yackov43/scb-mac-setup-tool run 41840389021, 2026-11-04); the reasons come from Chromium's source:
//  1. "Allow remote debugging for this browser instance" (chrome://inspect/#remote-debugging, Local State
//     devtools.remote_debugging.user-enabled) starts a loopback endpoint on the DEFAULT profile at once and writes
//     DevToolsActivePort; every connection then needs the person's "Allow" click (remote_debugging_server.cc).
//  2. An approved browser connection is a trusted client on the browser target, so Extensions.loadUnpacked is available
//     (chrome_devtools_session.cc). Chrome tags that copy INSTALLED_VIA_CDP and DELETES it at its next start
//     (ExtensionPrefs::CleanUpCdpInstalledExtensions) - why every earlier Mac CDP install was session-only.
//  3. So Developer mode is turned on and the extension is reloaded ONCE: an unpacked reload re-installs it from its
//     folder through a fresh UnpackedInstaller without that tag (ChromeExtensionRegistrarDelegate::
//     DoLoadExtensionForReload) - a normal "Load unpacked" install (creation_flags 32806 -> 38) that survived quitting
//     and a normal restart on the runner.
import { readFileSync, mkdtempSync, rmSync, writeFileSync, openSync, existsSync, constants as fsConstants } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const MAC_CHROME_USER_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
export const INSPECT_URL = 'chrome://inspect/#remote-debugging';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function readDebugEndpoint(userData = MAC_CHROME_USER_DATA, read = file => readFileSync(file, 'utf8')) {
  try {
    const [port, wsPath] = read(path.join(userData, 'DevToolsActivePort')).split('\n').map(s => s.trim());
    if (/^\d{2,5}$/.test(port) && /^\/devtools\/browser\/[\w-]+$/.test(wsPath || '')) return { port: Number(port), wsPath };
  } catch { /* off */ }
  return null;
}

// Opens the switch's page in the person's Chrome and puts its address on the clipboard, so pasting it works too.
export function showDebuggingSwitch(run = (file, args) => new Promise(resolve => execFile(file, args, { timeout: 10_000 }, () => resolve()))) {
  const copy = new Promise(resolve => {
    const child = execFile('/usr/bin/pbcopy', [], { timeout: 5_000 }, () => resolve());
    child.stdin?.end(INSPECT_URL);
  });
  return Promise.all([copy, run('/usr/bin/open', ['-a', 'Google Chrome', INSPECT_URL])]);
}

// Resolves with the open socket once the person clicks Allow. A refusal right away = the endpoint is not running.
export function connectBrowser({ port, wsPath }, timeoutMs, Socket = globalThis.WebSocket) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const ws = new Socket(`ws://127.0.0.1:${port}${wsPath}`);
    const timer = setTimeout(() => { try { ws.close(); } catch { /* closing */ } reject(Error('approval_timeout')); }, timeoutMs);
    ws.onopen = () => { clearTimeout(timer); resolve(ws); };
    ws.onerror = ws.onclose = () => { clearTimeout(timer); reject(Error(Date.now() - started < 1500 ? 'debugging_off' : 'approval_refused')); };
  });
}

export function cdpClient(ws) {
  let next = 0; const pending = new Map();
  ws.onmessage = event => {
    const m = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    const p = m.id && pending.get(m.id); if (!p) return;
    pending.delete(m.id); clearTimeout(p.timer);
    if (m.error) p.reject(Error(m.error.message)); else p.resolve(m.result);
  };
  ws.onclose = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('connection_closed')); } pending.clear(); };
  const send = (method, params = {}, sessionId, ms = 20_000) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('cdp_timeout:' + method)); }, ms);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return { send, close: () => { try { ws.close(); } catch { /* closed */ } } };
}

/**
 * onWaiting(what): 'debugging' (the person turns the switch on), 'approve' (the person clicks Allow), 'installing'.
 * Never restarts or closes Chrome and never touches a window the person has open.
 */
export async function installViaChromeApproval(directory, { extensionId, expectedVersion, userData = MAC_CHROME_USER_DATA, onWaiting = () => {}, limits = {}, deps = {} } = {}) {
  const L = { enableMs: 600_000, approveMs: 120_000, pollMs: 1_000, attempts: 3, settleMs: 250, ...limits };
  const d = { readEndpoint: () => readDebugEndpoint(userData), showSwitch: showDebuggingSwitch, connect: connectBrowser, client: cdpClient, sleep, now: Date.now, ...deps };
  let endpoint = d.readEndpoint(), shown = false, ws = null, lastError = 'debugging_off';
  const started = d.now();
  for (let attempt = 0; !ws;) {
    if (!endpoint) {
      if (!shown) { shown = true; onWaiting('debugging'); await Promise.resolve(d.showSwitch()).catch(() => {}); }
      if (d.now() - started > L.enableMs) return { ok: false, reason: 'chrome_debugging_not_enabled' };
      await d.sleep(L.pollMs); endpoint = d.readEndpoint(); continue;
    }
    onWaiting('approve');
    try { ws = await d.connect(endpoint, L.approveMs); }
    catch (error) {
      lastError = error.message;
      // A file left by an earlier Chrome session, or the switch turned off again: back to waiting for the switch.
      if (lastError === 'debugging_off') { endpoint = null; if (d.now() - started > L.enableMs) return { ok: false, reason: 'chrome_debugging_not_enabled' }; await d.sleep(L.pollMs); endpoint = d.readEndpoint(); continue; }
      // Chrome 152 on macOS 14 dropped the first approved connection (CI, 2026-11-04): ask again, a bounded number of times.
      if (++attempt >= L.attempts) return { ok: false, reason: 'chrome_' + lastError };
      await d.sleep(L.pollMs); endpoint = d.readEndpoint() || endpoint;
    }
  }
  const cdp = d.client(ws);
  try { return await loadPersistently(cdp, { directory, extensionId, expectedVersion, route: 'chrome_approval', onWaiting, sleep: d.sleep, settleMs: L.settleMs }); }
  finally { cdp.close(); }
}

// Load -> Developer mode -> ONE reload (drops INSTALLED_VIA_CDP) -> pin, in a background chrome://extensions tab that is
// closed again. Shared by both routes; never closes the connection itself.
export async function loadPersistently(cdp, { directory, extensionId, expectedVersion, route, onWaiting = () => {}, sleep: wait = sleep, settleMs = 250 }) {
  let targetId = null;
  try {
    onWaiting('installing');
    const loaded = await cdp.send('Extensions.loadUnpacked', { path: directory });
    if (loaded?.id !== extensionId) return { ok: false, reason: 'extension_id_mismatch' };
    ({ targetId } = await cdp.send('Target.createTarget', { url: 'chrome://extensions', background: true }));
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const page = async expression => {
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (r?.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r?.result?.value;
    };
    for (let i = 0; i < 40 && !(await page('typeof chrome !== "undefined" && !!chrome.developerPrivate').catch(() => false)); i++) await wait(settleMs);
    const id = JSON.stringify(extensionId);
    await page('chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })');
    await page(`chrome.developerPrivate.reload(${id}, { failQuietly: true })`);
    let info = null;
    for (let i = 0; i < 40; i++) {
      info = await page(`chrome.developerPrivate.getExtensionInfo(${id}).then(i => ({ state: i.state, version: i.version }), () => null)`).catch(() => null);
      if (info?.state === 'ENABLED') break;
      await wait(settleMs);
    }
    if (info?.state !== 'ENABLED') return { ok: false, reason: 'extension_not_enabled_after_reload' };
    if (expectedVersion && info.version !== expectedVersion) return { ok: false, reason: 'runtime_version_mismatch' };
    await page(`chrome.developerPrivate.updateExtensionConfiguration({ extensionId: ${id}, pinnedToToolbar: true })`).catch(() => {});
    return { ok: true, version: info.version, pinned: true, route };
  } catch (error) {
    return { ok: false, reason: 'chrome_cdp_failed', step: String(error?.message || error).slice(0, 80) };
  } finally {
    if (targetId) await cdp.send('Target.closeTarget', { targetId }, undefined, 5_000).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Zero-approval route (owner, 2026-11-04: "no approval at all - like the GPT extension"). A RUNNING Chrome accepts
// outside control only through approval mode, which always shows "Allow" (ChromeDevToolsManagerDelegate::AcceptDebugging
// -> DevToolsConnectionDialog::Show, no remember option). So Chrome is closed ONCE (SIGTERM = its normal quit: session and
// preferences are saved) and reopened with all its windows and tabs (--restore-last-session) holding a PRIVATE pipe:
//  - launchd starts it, not this process: Chrome stays its own app for macOS (camera/microphone prompts name Chrome,
//    not Terminal) and outlives this setup run;
//  - the pipe is two FIFOs in a private 0700 folder that Chrome opens READ-WRITE, so it never sees end-of-file (on EOF
//    Chrome closes itself: RemoteDebuggingServer::StartPipeHandler -> CloseBrowserSoon). After the install the paths are
//    deleted, so nothing can ever reach that pipe again. No network port is opened at any point;
//  - --remote-debugging-pipe on the default profile needs the /System/Volumes/Data spelling (measured 2026-10-26).
export const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** The person's own Chrome: main processes (no --type=) on the default folder, in either spelling. */
export function personChromePids(psText, userData = MAC_CHROME_USER_DATA) {
  const alias = path.posix.join('/System/Volumes/Data', userData);
  const pids = [];
  for (const line of String(psText).split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line); if (!m) continue;
    const cmd = m[2];
    if (!cmd.startsWith(CHROME_BIN) || /\s--type=/.test(cmd)) continue;
    if (cmd.includes('--user-data-dir=') && !cmd.includes('--user-data-dir=' + userData) && !cmd.includes('--user-data-dir=' + alias)) continue;
    pids.push(Number(m[1]));
  }
  return pids;
}

const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function chromeJobPlist(label, programArguments) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + `<plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array>`
    + programArguments.map(a => `<string>${xml(a)}</string>`).join('')
    + '</array><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>ProcessType</key><string>Interactive</string></dict></plist>\n';
}

/** CDP over Chrome's pipe: JSON messages separated by NUL. */
export function pipeClient(writable, readable) {
  let buffer = '', next = 0; const pending = new Map();
  readable.on('data', chunk => {
    buffer += chunk.toString('utf8');
    for (let i; (i = buffer.indexOf('\0')) >= 0;) {
      const raw = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      let m; try { m = JSON.parse(raw); } catch { continue; }
      const p = m.id && pending.get(m.id); if (!p) continue;
      pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(Error(m.error.message)); else p.resolve(m.result);
    }
  });
  readable.on('error', () => {});
  writable.on('error', () => {});
  const send = (method, params = {}, sessionId, ms = 30_000) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('cdp_timeout:' + method)); }, ms);
    pending.set(id, { resolve, reject, timer });
    writable.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  return { send, close: () => { for (const p of pending.values()) clearTimeout(p.timer); pending.clear(); try { readable.destroy(); } catch { } try { writable.destroy(); } catch { } } };
}

function realDeps() {
  return {
    ps: () => execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }),
    kill: (pid, signal) => process.kill(pid, signal),
    mkfifo: (...paths) => execFileSync('/usr/bin/mkfifo', ['-m', '600', ...paths]),
    mkdtemp: () => mkdtempSync(path.join(os.tmpdir(), 'scb-chrome-')),
    write: writeFileSync, remove: target => rmSync(target, { recursive: true, force: true }),
    launchctl: args => execFileSync('/bin/launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    open: args => execFileSync('/usr/bin/open', args, { stdio: 'ignore' }),
    connectPipe: (inPath, outPath) => {
      const flags = fsConstants.O_RDWR | fsConstants.O_NONBLOCK;
      const toChrome = new net.Socket({ fd: openSync(inPath, flags), readable: false, writable: true });
      const fromChrome = new net.Socket({ fd: openSync(outPath, flags), readable: true, writable: false });
      return pipeClient(toChrome, fromChrome);
    },
    uid: () => process.getuid(),
    exists: existsSync,
  };
}

export async function installViaChromeRelaunch(directory, { extensionId, expectedVersion, userData = MAC_CHROME_USER_DATA, profile = null, onWaiting = () => {}, limits = {}, deps = {} } = {}) {
  userData = String(userData).replace(/^\/System\/Volumes\/Data(?=\/)/, ''); // either spelling in, one spelling used
  const L = { quitMs: 20_000, pollMs: 250, settleMs: 250, readyMs: 45_000, ...limits };
  const d = { ...realDeps(), sleep, now: Date.now, ...deps };
  if (!d.exists(CHROME_BIN)) return { ok: false, reason: 'chrome_not_found', final: true };
  const running = personChromePids(d.ps(), userData);
  onWaiting(running.length ? 'restart' : 'starting');
  for (const pid of running) { try { d.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
  for (const started = d.now(); personChromePids(d.ps(), userData).length;) {
    // Never force it: a Chrome that will not quit keeps everything the person has open.
    if (d.now() - started > L.quitMs) return { ok: false, reason: 'chrome_did_not_quit' };
    await d.sleep(L.pollMs);
  }
  const dir = d.mkdtemp(), inPath = path.posix.join(dir, 'in'), outPath = path.posix.join(dir, 'out'), plist = path.posix.join(dir, 'chrome.plist'); // macOS paths
  const label = 'io.sslip.sunocoverbot.chrome.' + d.now();
  const reopen = () => { try { d.open(['-a', 'Google Chrome', '--args', ...(running.length ? ['--restore-last-session'] : [])]); } catch { /* the person can open it */ } };
  let cdp = null;
  try {
    d.mkfifo(inPath, outPath);
    const chrome = [CHROME_BIN, '--user-data-dir=' + path.posix.join('/System/Volumes/Data', userData), '--remote-debugging-pipe',
      ...(running.length ? ['--restore-last-session'] : []), ...(profile ? ['--profile-directory=' + profile] : [])];
    d.write(plist, chromeJobPlist(label, ['/bin/sh', '-c', 'exec 3<>"$1" 4<>"$2"; shift 2; exec "$@"', 'sh', inPath, outPath, ...chrome]));
    d.launchctl(['bootstrap', 'gui/' + d.uid(), plist]);
    cdp = d.connectPipe(inPath, outPath);
    await cdp.send('Browser.getVersion', {}, undefined, L.readyMs);
    return await loadPersistently(cdp, { directory, extensionId, expectedVersion, route: 'chrome_relaunch', onWaiting, sleep: d.sleep, settleMs: L.settleMs });
  } catch (error) {
    // Chrome must never stay closed because of the setup: if it did not come back, open it normally.
    if (!personChromePids(d.ps(), userData).length) reopen();
    return { ok: false, reason: 'chrome_relaunch_failed', step: String(error?.message || error).slice(0, 80) };
  } finally {
    cdp?.close();
    d.remove(dir);   // the FIFO paths: nothing can reach Chrome's pipe from now on
  }
}
