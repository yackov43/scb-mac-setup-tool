// Suno CoverBot Setup: the standalone Windows tool behind the download icon on the connect page. Node is inside the EXE, so the
// user installs nothing else. Default, protocol and Terminal launches share one background CLI pipeline:
// download + verify the extension, write its folder, register the quiet updater, verify Chrome runtime, then follow the
// exact server-confirmed Suno connection. First-install Chrome approval remains required. It never evaluates
// downloaded code; it only downloads the PUBLIC extension ZIP and verifies it before writing a single file.
//
//   SunoCoverBotSetup.exe              the CLI pipeline, without opening a window
//   SunoCoverBotSetup.exe --update     what the scheduled task runs, hidden: install the published version if newer
//   SunoCoverBotSetup.exe --launch scbsetup://run   same CLI pipeline; the link's content is ignored
//   SunoCoverBotSetup.exe --uninstall  remove the updater task, the scbsetup:// link type and their files (the extension folder is left alone)
//   SunoCoverBotSetup.exe --selftest-file <path>   write the build identity to a file; changes nothing
//   SunoCoverBotSetup.exe --status-file <path>     write the update health (installed vs published version, task, last log lines); changes nothing
//   flags: --no-chrome (skip Chrome verification) --cli (print final JSON)
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { installedVersion } from '../setup-pilot/install-package.mjs';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { unregisterUpdater, currentSid, taskNameFor } from '../setup-pilot/scheduler.mjs';
import { unregisterProtocol } from './protocol.mjs';
import { BASE, fetchPublicRelease, fetchReleaseMeta } from './lib.mjs';
import { createEngine } from './engine.mjs';
import { createUiServer } from './ui-server.mjs';
import { launchWindow } from './window.mjs';
import { loadAssets } from './assets.mjs';
import { pickLanguage, setupCopy } from './copy.mjs';
import { printProgress } from './progress.mjs';
import { ensureSetupBridge, runSetupBridge, bridgeSecret } from './setup-bridge.mjs';
import { unregisterLaunchAgent, agentStatus } from './launchagent.mjs';

import { managedUpdate } from './managed-update.mjs';
import { RELEASE_PUBLIC_KEY, ACTION_PUBLIC_KEY } from './update-control.mjs';

export const TOOL_VERSION = process.platform === 'darwin' ? '2.3.15' : '2.3.11';
// The trusted extension public key is baked in at build time (esbuild --define); the env var is for development runs only.
const KEY = typeof __SCB_KEY__ === 'string' ? __SCB_KEY__ : (process.env.SCB_SETUP_KEY || '');
// SCB_SETUP_HOME exists for tests (the update verification runs the real EXE in a sandbox folder); normal runs never set it.
function defaultSetupHome() {
  if (process.env.SCB_SETUP_HOME) return process.env.SCB_SETUP_HOME;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'SunoCoverBot', 'setup');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'SunoCoverBot', 'setup');
  return path.join(os.homedir(), '.local', 'share', 'SunoCoverBot', 'setup');
}
const HOME = defaultSetupHome();
const flag = name => process.argv.includes('--' + name);
const argValue = name => { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : undefined; };
const log = (file, text) => { try { mkdirSync(HOME, { recursive: true }); appendFileSync(path.join(HOME, file), `[${new Date().toISOString().slice(0, 19)}] ${text}\n`); } catch { /* logging never fails a run */ } };

async function update({ reloadChrome = true } = {}) {
  const config = JSON.parse(readFileSync(path.join(HOME, 'updater.json'), 'utf8').replace(/^\uFEFF/, ''));
  const res = await managedUpdate({ home: HOME, config, toolVersion: TOOL_VERSION, reloadChrome, log });
  if (!process.env.SCB_SETUP_HOME && !flag('no-bridge')) await ensureSetupBridge({ home: HOME, toolVersion: TOOL_VERSION });
  return res;
}

async function statusReport() {
  const read = file => { try { return readFileSync(path.join(HOME, file), 'utf8').replace(/^﻿/, ''); } catch { return ''; } };
  let config = null; try { config = JSON.parse(read('updater.json')); } catch { /* not installed */ }
  const installed = config ? installedVersion(config.directory) : null;
  const meta = config ? await fetchReleaseMeta({ base: config.base }).catch(() => null) : null;
  let task = null;
  if (process.platform === 'darwin') task = agentStatus();
  else try {
    const text = execFileSync(path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'schtasks.exe'), ['/Query', '/TN', taskNameFor(currentSid()), '/FO', 'LIST', '/V'], { encoding: 'utf8', windowsHide: true });
    const pick = key => text.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))?.[1]?.trim() ?? null;
    task = { status: pick('Status'), lastRun: pick('Last Run Time'), lastResult: pick('Last Result'), nextRun: pick('Next Run Time') };
  } catch { /* task missing */ }
  return {
    tool: TOOL_VERSION, installedVersion: installed, publishedVersion: meta?.version ?? null,
    upToDate: null, runningVersion: null, verifiedVersion: null, runtimeVerification: 'INDEPENDENT_HEARTBEAT_REQUIRED', task, lastUpdateLog: read('update.log').trim().split(String.fromCharCode(10)).map(l => l.replace(String.fromCharCode(13), '')).slice(-3)
  };
}

async function uninstall() {
  await fetch('http://127.0.0.1:47832/shutdown', { method: 'POST', headers: { 'x-scb-bridge': bridgeSecret(HOME) }, signal: AbortSignal.timeout(1000) }).catch(() => { });
  const removed = process.platform === 'darwin' ? unregisterLaunchAgent() : unregisterUpdater();
  unregisterProtocol();
  for (const name of ['updater.json', 'update-launch.vbs', 'scb-updater-task.xml', 'update.log', 'cdp-bridge.ready', 'bridge-token']) rmSync(path.join(HOME, name), { force: true });
  log('setup.log', `uninstall: updater task removed=${removed}`);
}

async function runSetup() {
  if (!KEY) throw new Error('This build has no extension key baked in.');
  const initialReleaseId = argValue('initial-release-id');
  const deps = initialReleaseId ? { fetchPublicRelease: async options => fetchPublicRelease({ ...options, meta: options.meta || await fetchReleaseMeta({ initialReleaseId }) }) } : {};
  // Every launch mode shares this lock, including --cli and protocol launches.
  const lock = net.createServer(sock => { sock.on('error', () => { }); sock.end(); });
  const free = await new Promise((resolve, reject) => { lock.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(error)); lock.listen(47831, '127.0.0.1', () => resolve(true)); });
  if (!free) { log('setup.log', 'already running; duplicate setup ignored'); return; }
  if (!flag('no-chrome') && !flag('no-bridge') && !process.env.SCB_SETUP_HOME) {
    try { await ensureSetupBridge({ home: HOME, toolVersion: TOOL_VERSION }); }
    catch (error) { lock.close(); throw error; }
  }

  let stopProgress = () => {};
  const engine = createEngine({
    key: KEY, home: HOME, deps, toolVersion: TOOL_VERSION, installOnly: flag('install-extension'),
    skipChrome: flag('no-chrome'), autoReturn: !flag('no-chrome'), onDone: () => { try { stopProgress(); } catch { /* exiting */ } process.exit(0); }
  });

  // Execution is quiet CLI by default in the background with zero popup windows.
  // The UI window is only launched if explicitly requested with --gui.
  let ui = null, child = null;
  if (flag('gui') && process.platform === 'darwin' && !flag('headless') && !flag('cli')) {
    try {
      ui = createUiServer({ engine, assets: loadAssets(), onClose: () => process.exit(0) });
      const lang = pickLanguage(Intl.DateTimeFormat().resolvedOptions().locale);
      const url = (await ui.listen()) + '&lang=' + lang;
      child = launchWindow({ url, profileDir: path.join(HOME, 'window-profile') });
    } catch (e) {
      log('setup.log', 'UI window launch error: ' + (e?.message || e));
    }
  }

  // The macOS Terminal command (install-mac.sh) runs this in the foreground with --progress: the steps and anything Chrome
  // asks the person to do are printed in that Terminal, in their language.
  if (flag('progress')) stopProgress = printProgress(engine, setupCopy(pickLanguage(Intl.DateTimeFormat().resolvedOptions().locale)));
  try { await engine.run(); }
  finally {
    stopProgress();
    lock.close();
    if (ui && engine.state.phase === 'done') await ui.close().catch(() => {});
  }
  log('setup.log', JSON.stringify(engine.snapshot()));
  if (flag('cli')) process.stdout.write(JSON.stringify(engine.snapshot()) + '\n');
  process.exitCode = ['done', 'installed'].includes(engine.state.phase) ? 0 : 1;
}

function launchAction() {
  // --launch scbsetup://update  OR  --launch scbhelper://update  OR  argv containing the URL
  const raw = argValue('launch') || process.argv.find((a) => /^(scbsetup|scbhelper):\/\//i.test(a)) || '';
  const m = /^(?:scbsetup|scbhelper):\/\/(run|install|update)\/?/i.exec(String(raw).trim());
  if (m) return m[1].toLowerCase();
  if (flag('update')) return 'update';
  if (flag('launch')) return 'run';
  return null;
}

async function main() {
  if (process.platform !== 'win32' && process.platform !== 'darwin') throw new Error('Windows or macOS only.');
  const selftest = argValue('selftest-file');
  if (selftest) {
    writeFileSync(selftest, JSON.stringify({
      tool: TOOL_VERSION,
      keySha256: createHash('sha256').update(KEY).digest('hex').slice(0, 16),
      base: BASE,
      platform: process.platform,
      releaseTrustConfigured: !!RELEASE_PUBLIC_KEY,
      actionTrustConfigured: !!ACTION_PUBLIC_KEY,
      releaseKeyHash: createHash('sha256').update(RELEASE_PUBLIC_KEY).digest('hex'),
      actionKeyHash: createHash('sha256').update(ACTION_PUBLIC_KEY).digest('hex'),
      autoApprovalWorkerBaked: typeof __SCB_AUTO_ALLOW_AVAILABLE__ === 'boolean' && __SCB_AUTO_ALLOW_AVAILABLE__,
      legacyWorkerPayloadHash: createHash('sha256').update(Buffer.from(typeof __SCB_AUTO_ALLOW_B64__ === 'string' ? __SCB_AUTO_ALLOW_B64__ : '', 'base64')).digest('hex'),
      mode: 'cli', browserDebugging: false,
      nativeAutomationBaked: {
        windows: typeof __SCB_NATIVE_WIN__ === 'string' && __SCB_NATIVE_WIN__.length > 0,
        macos: typeof __SCB_NATIVE_MAC__ === 'string' && __SCB_NATIVE_MAC__.length > 0,
      },
      nativeAutomationHashes: {
        windows: createHash('sha256').update(typeof __SCB_NATIVE_WIN__ === 'string' ? __SCB_NATIVE_WIN__ : '').digest('hex'),
        macos: createHash('sha256').update(typeof __SCB_NATIVE_MAC__ === 'string' ? __SCB_NATIVE_MAC__ : '').digest('hex'),
      },
      runtimeDiagnosticsSchema: 1,
    }));
    return;
  }
  const statusFile = argValue('status-file');
  if (statusFile) { writeFileSync(statusFile, JSON.stringify(await statusReport(), null, 2)); return; }
  if (flag('bridge') || flag('cdp-bridge')) {
    // Legacy launchers use the old flag; it now starts the same HTTP-only service.
    await runSetupBridge({ home: HOME, toolVersion: TOOL_VERSION });
    return;
  }
  const action = launchAction();
  if (action === 'update' || flag('update')) {
    try { await update({ reloadChrome: !flag('no-chrome') }); }
    catch (error) { log('update.log', 'FAILED: ' + error.message); process.exitCode = 1; }
    return;
  }
  if (flag('uninstall')) { await uninstall(); return; }
  await runSetup();
}
if (!process.env.SCB_SETUP_NO_AUTORUN) main().catch(error => { log('setup.log', 'FAILED: ' + (error?.message || error)); process.exitCode = 1; });
