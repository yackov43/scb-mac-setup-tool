// Customer transport: loopback HTTP only. It never opens a browser debugging connection.
import http from 'node:http';
import net from 'node:net';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import { BASE, EXTENSION_ID, isNewerVersion } from './lib.mjs';
import { retireLegacyDebugWorkers } from './legacy-workers.mjs';

export const SETUP_PORT = 47832;
const LOCAL = 'http://127.0.0.1:' + SETUP_PORT;
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function bridgeSecret(home) {
  mkdirSync(home, { recursive: true });
  const file = path.join(home, 'bridge-token');
  try { writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return readFileSync(file, 'utf8').trim();
}

async function readBody(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > 4096) throw Error('body_too_large');
  }
  return text ? JSON.parse(text) : {};
}
export async function verifyPairing(context, { base = BASE, fetchImpl = fetch } = {}) {
  const url = new URL('/api/pairing-status', base);
  url.searchParams.set('code', context.code); url.searchParams.set('t', context.token);
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw Error('pairing_not_verified');
  const result = await response.json();
  if (!result.ok || !['pending', 'used'].includes(result.status)) throw Error('pairing_not_verified');
  return { status: result.status, connectionId: /^[a-f0-9]{64}$/.test(result.connection_id || '') ? result.connection_id : null };
}
const pairingResult = result => typeof result === 'string' ? { status: result, connectionId: null } : result;

export function createSetupBridge({ base = BASE, toolVersion, secret, installed, update, install,
  pairingStatus = context => verifyPairing(context, { base }), now = Date.now } = {}) {
  const sites = new Set([new URL(base).origin, 'https://sunocoverbot.com']);
  const origins = new Set([...sites, 'chrome-extension://' + EXTENSION_ID]);
  let session = null, registration = null, queue = Promise.resolve(), draining = false;
  const operations = new Map();
  const busy = () => !!(session || registration || operations.size);
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const localAuth = !origin && equal(req.headers['x-scb-bridge'], secret);
    const send = (status, value) => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
        ...(origins.has(origin) ? { 'access-control-allow-origin': origin, vary: 'Origin',
          'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'Content-Type',
          'access-control-allow-private-network': 'true' } : {}) });
      res.end(status === 204 ? '' : JSON.stringify(value));
    };
    const host = req.headers.host || '';
    if (!/^127\.0\.0\.1:\d+$/.test(host) || (origin && !origins.has(origin))) return send(403, { error: 'origin_denied' });
    const url = new URL(req.url, LOCAL);
    if (req.method === 'OPTIONS') return send(origins.has(origin) ? 204 : 403, {});
    if (!origins.has(origin) && !localAuth) return send(403, { error: 'bridge_auth_required' });
    try {
      if (session && now() - session.at > 30 * 60_000) session = null;
      if (draining) return send(503, { error: 'bridge_draining' });
      if (url.pathname === '/status' && req.method === 'GET')
        return send(200, { ok: true, installed: installed(), toolVersion, mode: 'cli', protocol: 1, busy: busy() });
      if (url.pathname === '/connected') return send(410, { error: 'server_pairing_verification_required' });
      if (url.pathname === '/ensure-extension' && req.method === 'POST') {
        if (!installed()) return send(200, { ok: false, installed: false, reason: 'setup_not_installed' });
        const kind = url.searchParams.get('load') === '1' ? 'install' : 'update';
        if (!operations.has(kind)) {
          const work = kind === 'install' ? install : update;
          if (typeof work !== 'function') throw Error('installer_unavailable');
          const operation = queue.catch(() => {}).then(work).finally(() => operations.delete(kind));
          queue = operation; operations.set(kind, operation);
        }
        await operations.get(kind);
        return send(200, { ok: true, installed: true, updating: kind === 'update', installing: kind === 'install' });
      }
      if (url.pathname === '/pairing-context' && req.method === 'POST') {
        if (!sites.has(origin)) return send(403, { error: 'site_required' });
        const context = await readBody(req);
        if (!/^S[A-Z0-9]{6}$/.test(context.code || '') || !/^[a-z0-9]{8,20}$/i.test(context.token || ''))
          return send(400, { error: 'invalid_pairing_context' });
        const same = s => s?.code === context.code && equal(s?.token, context.token);
        if (same(session)) return send(200, { ok: true });
        if (registration) {
          await registration;
          return send(same(session) ? 200 : 409, { ok: same(session) });
        }
        registration = (async () => {
          const result = pairingResult(await pairingStatus(context));
          if (result.status !== 'pending' || session && (!result.connectionId || session.connectionId !== result.connectionId)) return false;
          session = { ...context, connectionId: result.connectionId, id: session?.id || randomUUID(), at: now(), claimed: session?.claimed || false };
          return true;
        })();
        try { return send(await registration ? 200 : 409, { ok: !!session }); }
        finally { registration = null; }
      }
      if (['/profile-context', '/claim-pairing', '/pairing-status', '/release-pairing', '/shutdown'].includes(url.pathname) && !localAuth)
        return send(403, { error: 'native_auth_required' });
      if(url.pathname==='/profile-context'&&req.method==='GET')return send(200,{id:session?.id||null,
        tokenDigest:session?createHash('sha256').update(session.token).digest('hex'):null});
      if (url.pathname === '/claim-pairing' && req.method === 'POST') {
        if (session) session.claimed = true;
        return send(200, { id: session?.id || null });
      }
      if (url.pathname === '/pairing-status' && req.method === 'GET') {
        if (!session?.claimed || url.searchParams.get('id') !== session.id) return send(409, { error: 'session_mismatch' });
        return send(200, { status: pairingResult(await pairingStatus(session)).status });
      }
      if (url.pathname === '/release-pairing' && req.method === 'POST') {
        if (url.searchParams.get('id') !== session?.id) return send(409, { error: 'session_mismatch' });
        session = null; return send(200, { ok: true });
      }
      if (url.pathname === '/shutdown' && req.method === 'POST') {
        if (busy()) return send(409, { error: 'bridge_busy' });
        draining = true;
        send(200, { ok: true }); server.close(); return;
      }
      send(404, { error: 'not_found' });
    } catch { send(503, { error: 'bridge_operation_failed' }); }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 5000;
  return server;
}

async function nativeRequest(home, route, method = 'GET') {
  const response = await fetch(LOCAL + route, { method, headers: { 'x-scb-bridge': bridgeSecret(home) },
    signal: AbortSignal.timeout(6000), redirect: 'error' });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    const error=Error(response.status === 409 && result.error === 'bridge_busy' ? 'bridge_busy' : 'bridge_request_failed');
    error.httpStatus=response.status;throw error;
  }
  return response.json();
}
export const readProfileContext = home => nativeRequest(home, '/profile-context').catch(error=>{
  if(error.httpStatus===404)throw Error('bridge_upgrade_required');throw error;
});
export function createPairingObserver(home) {
  let id = null, lastPoll = 0, events = [], flight = null;
  return {
    async events() {
      if (Date.now() - lastPoll < 2000) return events;
      if (flight) return flight;
      flight = (async () => {
        lastPoll = Date.now();
        if (!id) id = (await nativeRequest(home, '/claim-pairing', 'POST')).id;
        if (id && (await nativeRequest(home, '/pairing-status?id=' + id)).status === 'used') events = [id];
        return events;
      })().catch(() => []).finally(() => { flight = null; });
      return flight;
    },
    async close() {
      if (flight) await flight;
      if (id) await nativeRequest(home, '/release-pairing?id=' + id, 'POST').catch(() => {});
      id = null; events = []; lastPoll = 0;
    },
  };
}

async function probeBridge(home) {
  try { return await nativeRequest(home, '/status'); }
  catch (error) { if (error.cause?.code === 'ECONNREFUSED') return null; throw error; }
}
async function shutdownLegacyBridge() {
  // Compatibility control message to our old local worker, never a browser/CDP connection.
  await new Promise((resolve, reject) => {
    const socket = net.connect(SETUP_PORT, '127.0.0.1');
    const timer = setTimeout(() => { socket.destroy(); reject(Error('legacy_bridge_shutdown_timeout')); }, 1000);
    socket.once('connect', () => socket.write(JSON.stringify({ id: 1, method: 'Bridge.shutdown' }) + '\n'));
    socket.once('data', () => { clearTimeout(timer); socket.destroy(); resolve(); });
    socket.once('error', error => { clearTimeout(timer); socket.destroy(); reject(error); });
  });
}
export async function ensureSetupBridge({ home, toolVersion, exePath = process.execPath, deps = {} } = {}) {
  const d = { probe: () => probeBridge(home), shutdown: () => nativeRequest(home, '/shutdown', 'POST'),
    shutdownLegacy: shutdownLegacyBridge, retireWorkers: () => retireLegacyDebugWorkers(home),
    pause: () => new Promise(r => setTimeout(r, 100)), spawn, attempts: 50, ...deps };
  const status = await d.probe();
  const protocolCompatible = value => value?.mode === 'cli' && (value.protocol || 1) === 1 &&
    /^\d+(\.\d+){1,3}$/.test(value.toolVersion || '');
  const compatible = value => protocolCompatible(value) &&
    (value.toolVersion === toolVersion || isNewerVersion(value.toolVersion, toolVersion));
  if (compatible(status) || protocolCompatible(status) && status.busy) { await d.retireWorkers(); return; }
  if (status) {
    if (status.mode === 'cli') {
      try { await d.shutdown(); }
      catch (error) {
        if (protocolCompatible(status) && error.message === 'bridge_busy') { await d.retireWorkers(); return; }
        throw error;
      }
    }
    else if (!status.mode && typeof status.installed === 'boolean' && typeof status.hasExtensionDir === 'boolean' && /^2\.3\.\d+$/.test(status.toolVersion || '')) await d.shutdownLegacy();
    else throw Error('unknown_bridge_listener');
    let released = false;
    for (let i = 0; i < d.attempts; i++) { if (!await d.probe()) { released = true; break; } await d.pause(); }
    if (!released) throw Error('bridge_shutdown_timeout');
  }
  await d.retireWorkers();
  const packaged = /SunoCoverBotSetup.*(?:\.exe|-core)$/i.test(path.basename(exePath));
  const args = packaged ? ['--bridge'] : [path.join(process.cwd(), 'scripts/setup-tool/main.mjs'), '--bridge'];
  const child = d.spawn(exePath, args, { detached: true, stdio: 'ignore', windowsHide: true });
  let spawnError = null;
  child.once('error', error => { spawnError = error; });
  child.unref();
  for (let i = 0; i < d.attempts; i++) {
    if (spawnError) throw spawnError;
    const ready = await d.probe();
    if (compatible(ready)) return;
    if (ready) throw Error('bridge_identity_mismatch');
    await d.pause();
  }
  throw Error('bridge_start_timeout');
}
export function resolveBridgeRuntime({home,toolVersion,exePath=process.execPath,platform=process.platform,
  exists=existsSync,read=file=>readFileSync(file,'utf8')}={}) {
  const installed=path.join(home,platform==='darwin'?'SunoCoverBotSetup-core':'SunoCoverBotSetup.exe');
  let marker;try{marker=JSON.parse(read(path.join(home,'setup-version.json')).replace(/^\uFEFF/,''));}catch{}
  if(exists(installed)&&/^\d+(\.\d+){1,3}$/.test(marker?.version||'')&&(marker.version===toolVersion||isNewerVersion(marker.version,toolVersion)))return{file:installed,args:[]};
  if(exists(exePath)&&/SunoCoverBotSetup.*(?:\.exe|-core)$/i.test(path.basename(exePath)))return{file:exePath,args:[]};
  const entry=fileURLToPath(new URL('./main.mjs',import.meta.url));
  if(exists(exePath)&&/^node(?:\.exe)?$/i.test(path.basename(exePath))&&exists(entry))return{file:exePath,args:[entry]};
  throw Error('bridge_runtime_unavailable');
}
export async function runSetupBridge({ home, toolVersion, base = BASE } = {}) {
  const exe = path.join(home, process.platform === 'darwin' ? 'SunoCoverBotSetup-core' : 'SunoCoverBotSetup.exe');
  const launch = args => new Promise((resolve, reject) => {
    const runtime=resolveBridgeRuntime({home,toolVersion});
    const child = spawn(runtime.file, [...runtime.args,...args, '--no-bridge'], { stdio: 'ignore', windowsHide: true });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error('operation_failed')));
  });
  const server = createSetupBridge({ base, toolVersion, secret: bridgeSecret(home),
    installed: () => existsSync(exe) && existsSync(path.join(home, 'updater.json')),
    update: () => launch(['--update']),
    install: () => launch(['--cli', '--install-extension']),
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(SETUP_PORT, '127.0.0.1', resolve); });
  await new Promise(resolve => server.once('close', resolve));
}
