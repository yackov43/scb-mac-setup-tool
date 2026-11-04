// One native CLI worker per installation scope. No browser debugging endpoint or second updater.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EXTENSION_ID, chromeInstalls } from './lib.mjs';
import { chromePinLabels } from './chrome-locale.mjs';

const flights = new Map();
const run = promisify(execFile);
const asset = (name, baked) => typeof baked === 'string' ? baked : readFileSync(new URL(name, import.meta.url), 'utf8');
function chromePath(platform) {
  if (platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean)
    .map(root => path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')).find(file => existsSync(file));
}
export function chromeUserData(platform = process.platform) {
  return platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
    : path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'User Data');
}
export function nativeProfile(directory, userData, requested, inventory = chromeInstalls(userData)) {
  const matches = inventory.filter(c => path.resolve(c.path).toLowerCase() === path.resolve(directory).toLowerCase());
  if (!requested && matches.length > 1) throw Error('chrome_profile_selection_required');
  let profile = requested || matches[0]?.profile;
  if (!profile) {
    const state = JSON.parse(readFileSync(path.join(userData, 'Local State'), 'utf8').replace(/^\uFEFF/, ''));
    const profiles = Object.keys(state.profile?.info_cache || {});
    if (profiles.length > 1) throw Error('chrome_profile_selection_required');
    profile = profiles[0] || state.profile?.last_used || 'Default';
  }
  if (!/^(Default|Profile \d+)$/.test(profile) || !existsSync(path.join(userData, profile))) throw Error('chrome_profile_selection_required');
  return profile;
}
export async function installIntoChromeNative(directory, { expectedVersion, userData = chromeUserData(), profile, deps = {} } = {}) {
  const key = [path.resolve(directory), path.resolve(userData), expectedVersion, profile || ''].join('\n');
  if (flights.has(key)) return flights.get(key);
  const flight = (async () => {
    let stage, proof;
    try {
      const d = { platform: process.platform, run, ...deps };
      if (!['win32', 'darwin'].includes(d.platform)) throw Error('unsupported_platform');
      if (!path.isAbsolute(directory) || !path.isAbsolute(userData)) throw Error('invalid_directory');
      const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
      const id = createHash('sha256').update(Buffer.from(manifest.key || '', 'base64')).digest('hex').slice(0, 32)
        .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
      if (manifest.version !== expectedVersion || id !== EXTENSION_ID) throw Error('package_identity_mismatch');
      const inventory = chromeInstalls(userData);
      const chosen = nativeProfile(directory, userData, profile, inventory);
      const existing = inventory.find(item => item.profile === chosen);
      if (existing && path.resolve(existing.path).toLowerCase() !== path.resolve(directory).toLowerCase())
        throw Error('extension_directory_mismatch');
      const plan = { installRequired: !existing, enableRequired: existing?.enabled !== true,
        developerModeRequired: existing?.developerMode !== true, pinRequired: existing?.pinned !== true };
      if (!Object.values(plan).some(Boolean)) return { ok: true, version: expectedVersion, profile: chosen, pinned: true };
      const chrome = d.chrome || chromePath(d.platform); if (!chrome) throw Error('chrome_not_found');
      stage = mkdtempSync(path.join(os.tmpdir(), 'scb-native-'));
      const request = path.join(stage, 'request.json'), result = path.join(stage, 'result.json');
      const nonce = randomUUID(), route = '/native-setup/' + nonce;
      // Recent Chrome rejects internal chrome:// URLs from external launches. A loopback nonce page
      // proves ownership first; the worker may then navigate only that owned window to Extensions.
      proof = createServer((req, res) => {
        const allowed = req.headers.host === '127.0.0.1:' + proof.address().port &&
          req.url === route && ['GET', 'HEAD'].includes(req.method);
        res.writeHead(allowed ? 200 : 404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'referrer-policy': 'no-referrer' });
        res.end(allowed && req.method !== 'HEAD' ? '<!doctype html><title>SCB_NATIVE_SETUP_'+nonce+'</title>' : '');
      });
      proof.requestTimeout = 3000; proof.headersTimeout = 3000;
      await new Promise((resolve, reject) => { proof.once('error', reject); proof.listen(0, '127.0.0.1', resolve); });
      const launchUrl = 'http://127.0.0.1:' + proof.address().port + route;
      writeFileSync(request, JSON.stringify({ directory, userData, profile: chosen, chrome, extensionId: id, ...plan,
        version: expectedVersion, name: manifest.name, nonce, launchUrl,
        pinLabels: plan.pinRequired ? chromePinLabels(chrome, d.platform) : [] }), { mode: 0o600 });
      let file, args;
      if (d.platform === 'win32') {
        const script = path.join(stage, 'install.ps1');
        writeFileSync(script, asset('./native-install-win.ps1', typeof __SCB_NATIVE_WIN__ === 'string' ? __SCB_NATIVE_WIN__ : null));
        file = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        args = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, request, result];
      } else {
        const script = path.join(stage, 'install.js');
        writeFileSync(script, asset('./native-install-mac.js', typeof __SCB_NATIVE_MAC__ === 'string' ? __SCB_NATIVE_MAC__ : null));
        file = '/usr/bin/osascript'; args = ['-l', 'JavaScript', script, request, result];
      }
      await d.run(file, args, { windowsHide: true, timeout: 100_000, maxBuffer: 16_384 });
      const receipt = JSON.parse(readFileSync(result, 'utf8').replace(/^\uFEFF/, ''));
      // The step travels with the reason: "native_control_unavailable" alone never said which control (2026-11-04).
      if (receipt.ok !== true) return { ok: false, reason: receipt.reason || 'native_install_failed',
        ...(typeof receipt.step === 'string' && /^[a-z_]{1,40}$/.test(receipt.step) ? { step: receipt.step } : {}) };
      if (receipt.extensionId !== id || receipt.version !== expectedVersion || receipt.profile !== chosen || receipt.pinned !== true)
        throw Error('native_receipt_mismatch');
      return { ok: true, version: expectedVersion, profile: chosen, pinned: true };
    } catch (error) {
      const reason = /^[a-z_]+$/.test(error.message || '') ? error.message : 'native_install_failed';
      return { ok: false, reason };
    } finally {
      if (proof) { proof.closeAllConnections(); await new Promise(resolve => proof.close(resolve)); }
      if (stage) {
        const target = path.resolve(stage), parent = path.resolve(os.tmpdir()) + path.sep;
        if (!target.startsWith(parent)) throw Error('unsafe_staging_path');
        rmSync(target, { recursive: true, force: true });
      }
    }
  })().finally(() => flights.delete(key));
  flights.set(key, flight); return flight;
}

// macOS: the native step presses Chrome's own buttons, which macOS allows only after the person turns on the app that
// started this setup (usually Terminal) in Privacy & Security > Accessibility. The probe is that step's own first check,
// so `true` here means exactly that the next native attempt gets past it.
export async function macAccessibilityGranted({ exec = run } = {}) {
  try {
    // AXIsProcessTrusted answers for the app that started this setup and changes the moment its switch does. System
    // Events' uiElementsEnabled keeps its first answer until System Events restarts (measured, macOS 14.8).
    const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', "ObjC.import('ApplicationServices'); $.AXIsProcessTrusted()"], { timeout: 10_000 });
    return String(stdout).trim() === 'true';
  } catch { return false; }
}
/** System Events caches "not allowed"; it relaunches on demand, then with the new permission. */
export async function refreshMacSystemEvents({ exec = run } = {}) {
  try { await exec('/usr/bin/killall', ['System Events'], { timeout: 10_000 }); } catch { }
}
/** macOS's own prompt (it also lists the app under Accessibility, switched off), then that exact settings pane. */
export async function requestMacAccessibility({ exec = run } = {}) {
  try { await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', "ObjC.import('ApplicationServices'); $.AXIsProcessTrustedWithOptions($({AXTrustedCheckOptionPrompt: true}))"], { timeout: 10_000 }); } catch { }
  try { await exec('/usr/bin/open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'], { timeout: 10_000 }); } catch { }
}
