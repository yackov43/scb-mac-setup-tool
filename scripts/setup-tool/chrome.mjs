import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, rmSync, renameSync, copyFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { EXTENSION_ID } from './lib.mjs';
// Windows builds bake the generated payload; importing orchestration on Mac/Linux needs no generated Windows binary.
const AUTO_ALLOW_B64 = typeof __SCB_AUTO_ALLOW_B64__ === 'string' ? __SCB_AUTO_ALLOW_B64__ : (()=>{
  try{return JSON.parse(readFileSync(new URL('./auto-allow-bin.mjs',import.meta.url),'utf8').match(/=\s*("[^"]*")/)?.[1]||'""');}catch{return '';}
})();

export const BRIDGE_PORT = 47832;
const userDataDir = () => {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
  return path.join(os.homedir(), '.config', 'google-chrome');
};
const setupDir = () => {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'SunoCoverBot', 'setup');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || '', 'SunoCoverBot', 'setup');
  return path.join(os.homedir(), '.local', 'share', 'SunoCoverBot', 'setup');
};
const extensionDir = () => {
  try {
    const uFile = path.join(setupDir(), 'updater.json');
    if (existsSync(uFile)) {
      const u = JSON.parse(readFileSync(uFile, 'utf8'));
      if (u.directory && existsSync(u.directory)) return u.directory;
    }
  } catch {}
  const docDir = path.join(os.homedir(), 'Documents', 'SunoCoverBot', 'extension');
  if (existsSync(docDir)) return docDir;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'SunoCoverBot', 'extension');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || '', 'SunoCoverBot', 'extension');
  return path.join(os.homedir(), '.local', 'share', 'SunoCoverBot', 'extension');
};
const runtimeDir = () => path.join(process.env.TEMP || process.env.TMPDIR || os.tmpdir(), 'scb-runtime');
const readyFilePath = () => path.join(runtimeDir(), 'auto-allow.ready');
const bridgeReadyPath = () => path.join(runtimeDir(), 'cdp-bridge.ready');

export function isSetupToolInstalled() {
  try {
    const dir = setupDir();
    if (!existsSync(path.join(dir, 'updater.json'))) return false;
    if (process.platform === 'darwin') {
      // First-run copies the SEA core here; the .app (URL schemes) may live in Applications.
      return existsSync(path.join(dir, 'SunoCoverBotSetup-core'))
        || existsSync(path.join(dir, 'SunoCoverBotSetup.app'))
        || existsSync(path.join(os.homedir(), 'Applications', 'SunoCoverBotSetup.app'))
        || existsSync('/Applications/SunoCoverBotSetup.app');
    }
    return existsSync(path.join(dir, 'SunoCoverBotSetup.exe'));
  } catch {
    return false;
  }
}

function isBridgeAlive() {
  try {
    for (const bf of [bridgeReadyPath(), path.join(setupDir(), 'cdp-bridge.ready')]) {
      if (existsSync(bf) && (Date.now() - statSync(bf).mtimeMs) < 6_000) return true;
    }
    return false;
  } catch {
    return false;
  }
}

let bridgeLastSpawn = 0;
export function ensureCdpBridge() {
  if (process.platform !== 'win32' || process.argv.includes('--cdp-bridge')) return;
  const now = Date.now();
  if (isBridgeAlive() && now - bridgeLastSpawn < 15_000) return;
  bridgeLastSpawn = now;
  try {
    const rtDir = runtimeDir();
    mkdirSync(rtDir, { recursive: true });
    const rtBridgeExe = path.join(rtDir, 'SunoCoverBotSetup-bridge.exe');
    const primaryExe = path.join(setupDir(), 'SunoCoverBotSetup.exe');
    const execBase = path.basename(process.execPath).toLowerCase();
    let sourceExe = '';
    if (execBase === 'sunocoverbotsetup.exe' || execBase === 'sunocoverbotsetup-bridge.exe') {
      sourceExe = process.execPath;
    } else if (existsSync(primaryExe)) {
      sourceExe = primaryExe;
    }
    let cmd = '';
    let args = ['--cdp-bridge'];
    if (sourceExe) {
      if (path.resolve(sourceExe).toLowerCase() !== path.resolve(rtBridgeExe).toLowerCase()) {
        try {
          const srcStat = statSync(sourceExe);
          const dstExists = existsSync(rtBridgeExe);
          if (!dstExists || statSync(rtBridgeExe).size !== srcStat.size) {
            copyFileSync(sourceExe, rtBridgeExe);
          }
        } catch {}
      }
      cmd = existsSync(rtBridgeExe) ? rtBridgeExe : sourceExe;
    } else {
      const mainScript = path.join(process.cwd(), 'scripts', 'setup-tool', 'main.mjs');
      if (existsSync(mainScript)) {
        cmd = process.execPath;
        args = [mainScript, '--cdp-bridge'];
      }
    }
    if (cmd) {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
    }
  } catch {}
}

function isAutoAllowAlive() {
  if (process.platform !== 'win32') return false;
  try {
    const readyFound = existsSync(readyFilePath()) || existsSync(path.join(setupDir(), 'auto-allow.ready'));
    if (!readyFound) return false;
    const taskOut = execFileSync(path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tasklist.exe'), ['/FI', 'IMAGENAME eq auto-allow.exe', '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
    return taskOut.toLowerCase().includes('auto-allow.exe');
  } catch {
    try {
      for (const rf of [readyFilePath(), path.join(setupDir(), 'auto-allow.ready')]) {
        if (existsSync(rf)) return true;
      }
    } catch {}
    return false;
  }
}

let autoAllowLastSpawn = 0;
export function ensureAutoAllow() {
  if (process.platform !== 'win32' || !AUTO_ALLOW_B64) return;
  const now = Date.now();
  if (isAutoAllowAlive() && now - autoAllowLastSpawn < 10_000) return;
  autoAllowLastSpawn = now;
  try {
    const dir = setupDir();
    mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, 'auto-allow.exe');
    if (!existsSync(exe) || statSync(exe).size !== Buffer.from(AUTO_ALLOW_B64, 'base64').length) {
      writeFileSync(exe, Buffer.from(AUTO_ALLOW_B64, 'base64'));
    }
    const rt = runtimeDir();
    mkdirSync(rt, { recursive: true });
    const rtExe = path.join(rt, 'auto-allow.exe');
    if (!existsSync(rtExe) || statSync(rtExe).size !== statSync(exe).size) {
      try { copyFileSync(exe, rtExe); } catch {}
    }
    const targetExe = existsSync(rtExe) ? rtExe : exe;
    const child = spawn(targetExe, ['--continuous'], { detached: true, stdio: 'ignore', windowsHide: true, cwd: dir });
    child.unref();
  } catch {}
}

export function stopAutoAllow() {
  if (process.platform !== 'win32') return;
  try {
    for (const rf of [readyFilePath(), path.join(setupDir(), 'auto-allow.ready')]) {
      try { rmSync(rf, { force: true }); } catch {}
    }
    execFileSync(path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'taskkill.exe'), ['/F', '/IM', 'auto-allow.exe'], { stdio: 'ignore', windowsHide: true });
  } catch {}
}

export async function waitAutoAllowReady(maxMs = 3000) {
  if (process.platform !== 'win32' || !AUTO_ALLOW_B64) return;
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (isAutoAllowAlive()) return;
    await new Promise(r => setTimeout(r, 60));
  }
}

export async function shutdownCdpBridge() {
  if (process.platform !== 'win32') return;
  const socket = new net.Socket();
  await new Promise(resolve => {
    socket.once('connect', () => {
      try { socket.write(JSON.stringify({ id: 1, method: 'Bridge.shutdown' }) + '\n'); } catch {}
      setTimeout(() => { socket.destroy(); resolve(); }, 150);
    });
    socket.once('error', () => resolve());
    socket.connect(BRIDGE_PORT, '127.0.0.1');
    setTimeout(() => { socket.destroy(); resolve(); }, 350);
  });
}

function isChromeUserData(dir) {
  try {
    return path.resolve(dir).toLowerCase() === path.resolve(userDataDir()).toLowerCase();
  } catch { return false; }
}

async function directOpen(userData, { waitMs = 15_000, onPermissionPending = null } = {}) {
  const portFile = path.join(userData, 'DevToolsActivePort');
  if (!existsSync(portFile)) throw new Error('debugging_off');
  const [port, wsPath] = readFileSync(portFile, 'utf8').split('\n');
  if (!port?.trim() || !wsPath?.trim()) throw new Error('debugging_off');
  if (isChromeUserData(userData)) {
    ensureAutoAllow();
    await waitAutoAllowReady(5000);
  }
  const ws = new WebSocket(`ws://127.0.0.1:${port.trim()}${wsPath.trim()}`);
  await new Promise((resolve, reject) => {
    let settled = false;
    let pendingShown = false;
    const finish = fn => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hintTimer) clearTimeout(hintTimer);
      fn();
    };
    const hintTimer = setTimeout(() => {
      if (settled) return;
      pendingShown = true;
      try { onPermissionPending?.(); } catch {}
    }, 1500);
    hintTimer.unref?.();
    const timer = setTimeout(() => finish(() => {
      try { ws.close(); } catch {}
      reject(new Error('permission_pending'));
    }), Math.max(5_000, Number(waitMs) || 15_000));
    timer.unref?.();
    if (ws.readyState === 1) finish(resolve);
    else ws.onopen = () => finish(resolve);
    ws.onerror = () => finish(() => reject(new Error(pendingShown ? 'permission_denied' : 'debugging_off')));
    ws.onclose = () => finish(() => reject(new Error(pendingShown ? 'permission_denied' : 'debugging_off')));
  });
  let nextId = 0; const pending = new Map();
  const conn = { dead: false };
  ws.onclose = () => { conn.dead = true; for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('connection_closed')); } pending.clear(); };
  ws.onmessage = event => { const d = JSON.parse(event.data); const p = d.id && pending.get(d.id); if (p) { pending.delete(d.id); clearTimeout(p.timer); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result); } };
  const send = (method, params = {}, sessionId, timeoutMs = 20_000) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { if (pending.delete(id)) reject(new Error('timeout:' + method)); }, timeoutMs);
    timer.unref?.();
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  Object.assign(conn, { send, close: () => ws.close() });
  return conn;
}

async function openViaBridge(userData, { waitMs = 5_000, onPermissionPending = null } = {}) {
  const socket = new net.Socket();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('bridge_timeout')); }, 350);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('error', err => { clearTimeout(timer); reject(err); });
    socket.connect(BRIDGE_PORT, '127.0.0.1');
  });
  let nextId = 0;
  const pending = new Map();
  const conn = { dead: false };
  let buf = '';
  socket.on('close', () => {
    conn.dead = true;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('connection_closed')); }
    pending.clear();
  });
  socket.on('error', () => {});
  socket.on('data', chunk => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const d = JSON.parse(line);
        const p = d.id && pending.get(d.id);
        if (p) {
          pending.delete(d.id);
          clearTimeout(p.timer);
          d.ok ? p.resolve(d.result) : p.reject(new Error(d.error || 'bridge_error'));
        }
      } catch {}
    }
  });
  const send = (method, params = {}, sessionId, timeoutMs = 20_000) => new Promise((resolve, reject) => {
    if (conn.dead) { reject(new Error('connection_closed')); return; }
    const id = ++nextId;
    const timer = setTimeout(() => { if (pending.delete(id)) reject(new Error('timeout:' + method)); }, timeoutMs);
    timer.unref?.();
    pending.set(id, { resolve, reject, timer });
    try {
      socket.write(JSON.stringify({ id, userData, method, params, sessionId, timeoutMs }) + '\n');
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      reject(err);
    }
  });
  Object.assign(conn, { send, close: () => { conn.dead = true; try { socket.end(); socket.destroy(); } catch {} } });
  const effectiveWaitMs = Math.max(1_000, Number(waitMs) || 5_000);
  const hintTimer = onPermissionPending
    ? setTimeout(() => { try { onPermissionPending(); } catch {} }, 900)
    : null;
  hintTimer?.unref?.();
  try {
    await send('Bridge.open', { waitMs: effectiveWaitMs }, undefined, effectiveWaitMs + 1_500);
  } catch (err) {
    conn.close();
    throw err;
  } finally {
    if (hintTimer) clearTimeout(hintTimer);
  }
  return conn;
}

async function rawOpen(userData, options = {}) {
  ensureAutoAllow();
  return directOpen(userData, options);
}

/**
 * Lightweight background HTTP server on 127.0.0.1:47832.
 * Answers HTTP CORS/PNA queries from /connect and extension (`GET /status`, `POST /connected`, `POST /ensure-extension`)
 * so the web page and extension can trigger silent background updates without keeping CDP attached.
 */
function writeHttpJson(socket, status, payload) {
  try {
    const body = JSON.stringify(payload);
    const headers = [
      `HTTP/1.1 ${status === 204 ? '204 No Content' : status === 200 ? '200 OK' : `${status} Error`}`,
      'Access-Control-Allow-Origin: *',
      'Access-Control-Allow-Methods: GET, POST, OPTIONS',
      'Access-Control-Allow-Headers: Content-Type',
      'Access-Control-Allow-Private-Network: true',
      'Cache-Control: no-store',
      'Content-Type: application/json; charset=utf-8',
      `Content-Length: ${ status === 204 ? 0 : Buffer.byteLength(body, 'utf8') }`,
      'Connection: close',
      '',
      status === 204 ? '' : body,
    ].join('\r\n');
    socket.end(headers);
  } catch {}
}

export async function runCdpBridge() {
  const server = net.createServer(socket => {
    let buf = '';
    let isHttp = null;
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buf += chunk.toString('utf8');
      if (isHttp === null) {
        const trimmed = buf.trimStart();
        if (!trimmed) return;
        isHttp = /^(GET|POST|OPTIONS|HEAD)\s+/i.test(trimmed);
      }
      if (isHttp) {
        if (!buf.includes('\r\n\r\n') && !buf.includes('\n\n')) return;
        const firstLine = buf.split(/\r?\n/, 1)[0] || '';
        const [method = '', rawPath = ''] = firstLine.trim().split(/\s+/);
        const urlPath = rawPath.split('?')[0];
        if (method.toUpperCase() === 'OPTIONS') {
          writeHttpJson(socket, 204, {});
          return;
        }
        if (method.toUpperCase() === 'GET' && urlPath === '/status') {
          const installed = isSetupToolInstalled();
          const hasExtensionDir = existsSync(path.join(extensionDir(), 'manifest.json'));
          writeHttpJson(socket, 200, { ok: true, installed, hasExtensionDir, toolVersion: '2.3.6' });
          return;
        }
        if (method.toUpperCase() === 'POST' && urlPath === '/connected') {
          try {
            mkdirSync(runtimeDir(), { recursive: true });
            writeFileSync(path.join(runtimeDir(), 'suno-connected.stamp'), String(Date.now()));
          } catch {}
          writeHttpJson(socket, 200, { ok: true });
          return;
        }
        if (method.toUpperCase() === 'POST' && urlPath === '/ensure-extension') {
          void (async () => {
            try {
              const installed = isSetupToolInstalled();
              if (!installed) {
                writeHttpJson(socket, 200, { ok: false, installed: false, reason: 'setup_not_installed' });
                return;
              }
              const setupCandidates = process.platform === 'darwin'
                ? [path.join(setupDir(), 'SunoCoverBotSetup-core'), path.join(setupDir(), 'SunoCoverBotSetup.app', 'Contents', 'Resources', 'SunoCoverBotSetup-core')]
                : [path.join(setupDir(), 'SunoCoverBotSetup.exe')];
              const setupExe = setupCandidates.find((p) => existsSync(p)) || '';
              const extDir = extensionDir();
              if (rawPath.includes('load=1') || existsSync(path.join(extDir, 'manifest.json'))) {
                try {
                  const res = await loadIntoChrome(extDir);
                  if (res?.ok) {
                    writeHttpJson(socket, 200, { ok: true, installed: true, loaded: true, version: res?.version || null });
                    return;
                  }
                } finally {
                  closeCdp();
                }
              }
              if (setupExe) {
                const child = spawn(setupExe, ['--update'], { detached: true, stdio: 'ignore', windowsHide: true });
                child.unref();
                writeHttpJson(socket, 200, { ok: true, installed: true, updating: true });
                return;
              }
              writeHttpJson(socket, 200, { ok: false, installed: false });
            } catch (err) {
              writeHttpJson(socket, 200, { ok: false, error: err?.message || String(err) });
            }
          })();
          return;
        }
        writeHttpJson(socket, 404, { ok: false, error: 'not_found' });
        return;
      }
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        void (async () => {
          let req;
          try { req = JSON.parse(line); } catch { return; }
          const id = req?.id;
          try {
            if (req.method === 'Bridge.shutdown') {
              try { socket.write(JSON.stringify({ id, ok: true, result: {} }) + '\n'); } catch {}
              try { rmSync(bridgeReadyPath(), { force: true }); } catch {}
              process.exit(0);
            }
            socket.write(JSON.stringify({ id, ok: true, result: {} }) + '\n');
          } catch (err) {
            try { socket.write(JSON.stringify({ id, ok: false, error: err?.message || String(err) }) + '\n'); } catch {}
          }
        })();
      }
    });
  });
  const bound = await new Promise(resolve => {
    server.once('error', () => resolve(false));
    server.listen(BRIDGE_PORT, '127.0.0.1', () => resolve(true));
  });
  if (!bound) return;
  const touchReady = () => {
    try {
      mkdirSync(runtimeDir(), { recursive: true });
      const ts = String(Date.now());
      writeFileSync(bridgeReadyPath(), ts);
      if (isSetupToolInstalled()) {
        writeFileSync(path.join(setupDir(), 'cdp-bridge.ready'), ts);
      }
    } catch {}
  };
  touchReady();
  setInterval(touchReady, 2_000);
  await new Promise(() => {});
}

/**
 * ONE debugging connection for the whole run. Chrome asks the user to allow remote debugging per connection, so opening a fresh one for
 * every check (the pairing watch polls several times a second) meant approval after approval. Callers get a handle whose close() is a
 * no-op; the real connection is closed once, by closeCdp(), when the tool ends (which also clears Chrome's debugging banner).
 */
export function createCdpPool(connect) {
  const live = new Map();
  const connecting = new Map();
  return {
    async get(key, options) {
      let conn = live.get(key);
      if (conn && !conn.dead) return { send: (...args) => conn.send(...args), close() {} };
      let pending = connecting.get(key);
      if (!pending) {
        pending = connect(key, options).then(
          c => { live.set(key, c); connecting.delete(key); return c; },
          err => { connecting.delete(key); throw err; }
        );
        connecting.set(key, pending);
      }
      conn = await pending;
      return { send: (...args) => conn.send(...args), close() {} };
    },
    closeAll() {
      for (const conn of live.values()) { try { conn.close(); } catch { /* already closed */ } }
      live.clear();
      connecting.clear();
    },
    hasLive(key) {
      if (key !== undefined) {
        const c = live.get(key);
        return !!(c && !c.dead);
      }
      for (const c of live.values()) if (c && !c.dead) return true;
      return false;
    },
    size: () => live.size,
  };
}
const pool = createCdpPool(rawOpen);
export const openCdp = (userData = userDataDir(), options = {}) => pool.get(userData, options);
export const hasLiveCdp = (userData = userDataDir()) => pool.hasLive(userData);
export const closeCdp = () => {
  pool.closeAll();
};

export function ensurePinnedInPreferences(userData = userDataDir()) {
  try {
    const defaultPrefs = path.join(userData, 'Default', 'Preferences');
    if (existsSync(defaultPrefs)) {
      const text = readFileSync(defaultPrefs, 'utf8');
      const data = JSON.parse(text);
      if (!data.extensions) data.extensions = {};
      if (!Array.isArray(data.extensions.pinned_extensions)) data.extensions.pinned_extensions = [];
      if (!data.extensions.pinned_extensions.includes(EXTENSION_ID)) {
        data.extensions.pinned_extensions.push(EXTENSION_ID);
        writeFileSync(defaultPrefs, JSON.stringify(data));
      }
    }
  } catch {}
}

/** Loads (or reloads) the unpacked extension folder into Chrome, enables it and pins it. Returns { ok, version } or { ok:false, reason }. */
export async function loadIntoChrome(directory, { userData = userDataDir(), expectedVersion = null, waitMs = 15_000, onPermissionPending = null } = {}) {
  let cdp;
  try { cdp = await openCdp(userData, { waitMs, onPermissionPending }); } catch (error) { return { ok: false, reason: error.message }; }
  await new Promise(r => setTimeout(r, 30));

  let extVersion = expectedVersion;
  try {
    const mf = path.join(directory, 'manifest.json');
    if (existsSync(mf)) {
      const parsed = JSON.parse(readFileSync(mf, 'utf8'));
      if (parsed.version) extVersion = parsed.version;
    }
  } catch {}

  // 1. PRIMARY: 100% Pure CLI load/reload directly via CDP browser command (Domain: Extensions)
  // ZERO tabs created, ZERO windows created, absolute background silence.
  try {
    const directRes = await cdp.send('Extensions.loadUnpacked', { path: directory });
    if (directRes && directRes.id) {
      try { ensurePinnedInPreferences(userData); } catch {}

      // Clean up any stray chrome://extensions tabs left from previous sessions
      try {
        const { targetInfos } = await cdp.send('Target.getTargets').catch(() => ({ targetInfos: [] }));
        const cleanupTabs = (targetInfos || []).filter(t => t.url && (t.url.startsWith('chrome://extensions') || t.url.startsWith('chrome://settings') || t.url.startsWith('chrome://inspect')));
        const pages = (targetInfos || []).filter(t => t.type === 'page');
        if (pages.length <= cleanupTabs.length && cleanupTabs.length > 0) {
          await cdp.send('Target.createTarget', { url: 'chrome://newtab/' }).catch(() => {});
        }
        for (const t of cleanupTabs) {
          await cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
        }
      } catch {}

      cdp.close();
      return { ok: true, version: extVersion || '1.0.0' };
    }
  } catch (err) {
    // If Extensions.loadUnpacked is not supported on this specific Chrome engine, fall back to WebUI
  }

  // 2. FALLBACK (legacy Chrome engines only):
  let targetId;
  let sessionId;
  try {
    ({ targetId } = await cdp.send('Target.createTarget', { url: 'chrome://extensions', background: true }));
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
    const page = async expression => {
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    const waitDevPrivate = Date.now();
    while (Date.now() - waitDevPrivate < 2500) {
      try {
        const ready = await page('typeof chrome !== "undefined" && !!chrome.developerPrivate');
        if (ready) break;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    const ours = async () => JSON.parse(await page(`chrome.developerPrivate.getExtensionsInfo().then(a => JSON.stringify(a.filter(x => x.id === '${EXTENSION_ID}').map(x => ({ version: x.version, state: x.state, errors: (x.manifestErrors || []).length }))))`))[0];
    await page('chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })');
    let found = await ours();
    const isReady = f => f && f.state === 'ENABLED' && !f.errors && (!expectedVersion || f.version === expectedVersion);
    // Already loaded, enabled and at the expected version: leave it alone (a reload is only for a version change).
    if (!isReady(found)) {
      if (found) await page(`chrome.developerPrivate.reload('${EXTENSION_ID}', { failQuietly: true })`);
      else await cdp.send('Extensions.loadUnpacked', { path: directory });
      const waitLoad = Date.now();
      while (Date.now() - waitLoad < 2500) {
        await new Promise(resolve => setTimeout(resolve, 60));
        found = await ours().catch(() => null);
        if (isReady(found)) break;
      }
    }
    if (!found || found.state !== 'ENABLED' || found.errors) return { ok: false, reason: 'not_enabled' };
    await page(`chrome.developerPrivate.updateExtensionConfiguration({ extensionId: '${EXTENSION_ID}', pinnedToToolbar: true })`);

    // Reload any open /connect page so it immediately recognizes the freshly loaded extension
    try {
      const { targetInfos } = await cdp.send('Target.getTargets');
      const connectTabs = (targetInfos || []).filter(t => t.type === 'page' && t.url && t.url.includes('/connect'));
      for (const ct of connectTabs) {
        const { sessionId: sId } = await cdp.send('Target.attachToTarget', { targetId: ct.targetId, flatten: true });
        await cdp.send('Page.reload', {}, sId).catch(() => {});
        await cdp.send('Target.detachFromTarget', { sessionId: sId }).catch(() => {});
      }
    } catch {}

    return { ok: true, version: found.version };
  } catch (error) {
    return { ok: false, reason: error.message };
  } finally {
    try {
      if (sessionId) {
        await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      }
      if (targetId) {
        await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
      }
      const { targetInfos } = await cdp.send('Target.getTargets').catch(() => ({ targetInfos: [] }));
      const cleanupTabs = (targetInfos || []).filter(t => t.url && (t.url.startsWith('chrome://extensions') || t.url.startsWith('chrome://settings') || t.url.startsWith('chrome://inspect')));
      const pages = (targetInfos || []).filter(t => t.type === 'page');
      if (pages.length <= cleanupTabs.length && cleanupTabs.length > 0) {
        await cdp.send('Target.createTarget', { url: 'chrome://newtab/' }).catch(() => {});
      }
      for (const t of cleanupTabs) {
        await cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
      }
      await new Promise(r => setTimeout(r, 60));
    } catch {}
    cdp.close();
  }
}

/**
 * Ids of the tabs that sit on our site's /api/connected page (the page the server sends a browser to only after it accepted a new Suno
 * connection), or null when Chrome cannot be observed. The caller remembers the ids present at the start and counts only NEW ones, so a
 * success tab left over from an earlier run can never pass for a fresh connection. The extension's stored device token is not used: it
 * outlives a disconnect.
 */
export async function connectedTabIds({ userData = userDataDir(), site = 'https://46-225-2-111.sslip.io' } = {}) {
  const stamp = path.join(runtimeDir(), 'suno-connected.stamp');
  try {
    if (existsSync(stamp)) {
      return [`stamp-${statSync(stamp).mtimeMs}`];
    }
  } catch {}
  if (!pool.hasLive(userData)) return null;
  let cdp;
  try { cdp = await openCdp(userData); } catch { return null; }
  try {
    const { targetInfos } = await cdp.send('Target.getTargets', {}, undefined, 4_000);
    return targetInfos.filter(t => t.type === 'page' && t.url.startsWith(`${site}/api/connected`)).map(t => t.targetId);
  } catch { return null; } finally { cdp.close(); }
}
