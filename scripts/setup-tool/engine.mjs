// The setup pipeline behind the window. Pure orchestration over injectable dependencies, so every branch is testable
// without Windows, a network or a browser. The window only ever READS this state; it never decides anything.
import { copyFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync, rmSync, renameSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { installPackage, writeMarker, installedVersion } from '../setup-pilot/install-package.mjs';
import { launcherScript, registerUpdater } from '../setup-pilot/scheduler.mjs';
import { BASE, EXTENSION_ID, chromeInstalls, fetchPublicRelease, isNewerVersion } from './lib.mjs';
import { installViaChromeApproval, installViaChromeRelaunch } from './mac-cdp-install.mjs';
import { createChromeVerifier, selectExtensionDirectory } from './cli-browser.mjs';
import { installIntoChromeNative, macAccessibilityGranted, requestMacAccessibility, refreshMacSystemEvents } from './native-browser.mjs';
import { resolveChromeScope, validateExistingScope } from './chrome-scope.mjs';
import { createPairingObserver } from './setup-bridge.mjs';
import { registerProtocol } from './protocol.mjs';
import { registerLaunchAgent } from './launchagent.mjs';
import { returnToTelegram } from './telegram.mjs';
import { acquireComponentLock, bindNativeMarker, retireLegacyScheduler, nativeHeartbeat, approvedComponent, schedulerHealth } from './update-control.mjs';

export const STEP_IDS = ['download', 'files', 'updates', 'chrome', 'suno'];
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

export function createEngine({ key, home, toolVersion = '', exePath = process.execPath, skipChrome = false, installOnly = false, autoReturn = false, onBeforeReturn = () => { }, onDone = () => { }, sleep = ms => new Promise(r => setTimeout(r, ms)),
  deps = {}, limits = {} } = {}) {
  const defaultReportFailure = payload => {
    try {
      fetch(BASE + '/api/update-control/setup-report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(5000),
        body: JSON.stringify(payload),
      }).catch(() => { });
    } catch { }
  };
  const d = {
    acquireComponentLock, bindNativeMarker, retireLegacyScheduler, nativeHeartbeat, approvedComponent, schedulerHealth, fetchPublicRelease, installPackage, writeMarker, installedVersion, registerUpdater, registerProtocol, registerLaunchAgent, returnToTelegram,
    verifyChrome: createChromeVerifier({ home, toolVersion }), installIntoChrome: installIntoChromeNative, chromeInstalls, selectExtensionDirectory, resolveChromeScope,
    macAccessibility: process.platform === 'darwin' ? { granted: macAccessibilityGranted, request: requestMacAccessibility, refresh: refreshMacSystemEvents } : null,
    // macOS: Chrome's own approval route (mac-cdp-install.mjs) - no restart, no Accessibility. Windows keeps its native route.
    // Owner 2026-11-04: no approval at all. First the zero-approval route (Chrome closes once and comes back with its tabs);
    // only if that cannot finish, Chrome's own Allow route; the engine falls back to the manual route after that.
    macChromeApproval: process.platform === 'darwin' ? async (folder, options) => {
      const silent = await installViaChromeRelaunch(folder, { extensionId: EXTENSION_ID, ...options });
      return silent.ok || silent.final ? silent : installViaChromeApproval(folder, { extensionId: EXTENSION_ID, ...options });
    } : null,
    reportSetupFailure: defaultReportFailure, copyFile: copyFileSync, mkdir: mkdirSync, write: writeFileSync, read: file => readFileSync(file, 'utf8'), exists: existsSync, ...deps
  };
  const pairing = createPairingObserver(home);
  d.pairingEvents ||= () => pairing.events();
  const L = { chromePermissionMs: 180_000, chromeManualMs: 600_000, accessibilityMs: 900_000, accessibilityPollMs: 1_500, pairingMs: 1_800_000, pollMs: 400, sunoPollMs: 350, lockRetries: 60, lockPollMs: 500, ...limits };
  const state = { platform: process.platform === 'darwin' ? 'macOS' : 'Windows', returnedVia: '', phase: 'idle', steps: STEP_IDS.map(id => ({ id, status: 'pending', detail: '' })), folder: '', version: '', error: '' };
  const set = (id, status, detail = '') => { const s = state.steps.find(x => x.id === id); s.status = status; s.detail = detail; };
  let running = false, chromeScope = null;

  function reportFailure(step, rawError) {
    try {
      const home2 = os.homedir();
      const why = String(rawError || '').split(home2).join('~').replace(/[A-Z]:\\Users\\[^\\]+/gi, '~').slice(0, 300);
      d.reportSetupFailure({
        tool_version: toolVersion,
        platform: process.platform,
        os_version: os.release(),
        locale: Intl.DateTimeFormat().resolvedOptions().locale || '',
        step: step || '',
        error: why,
      });
    } catch { }
  }

  // macOS lets the setup add the extension to Chrome only after the person turns on ONE switch (Privacy & Security >
  // Accessibility). That is not a failure: ask once, show where, and wait. The switch turning on retries the automatic
  // install; adding the extension by hand (the instructions stay on screen) completes the step just the same.
  async function waitForMacAccessibility(folder) {
    set('chrome', 'action', 'accessibility');
    try { await d.macAccessibility.request(); } catch { }
    const started = Date.now();
    for (; ;) {
      if (await d.macAccessibility.granted().catch(() => false)) { try { await d.macAccessibility.refresh?.(); } catch { } return 'granted'; }
      const check = await d.verifyChrome(folder, { expectedVersion: state.version, ...chromeScope });
      if (check.ok && check.version === state.version && (!chromeScope || check.profile === chromeScope.profile)) return 'verified';
      if (Date.now() - started > L.accessibilityMs) return 'timeout';
      await sleep(L.accessibilityPollMs);
    }
  }

  // macOS: when the automatic route cannot finish, the person adds the extension by hand (the window shows how and
  // where) and the step completes the moment Chrome shows it, instead of failing the whole setup.
  async function waitForManualChrome(folder) {
    set('chrome', 'action', 'manual');
    const started = Date.now();
    for (; ;) {
      const check = await d.verifyChrome(folder, { expectedVersion: state.version, ...chromeScope });
      if (check.ok && check.version === state.version && (!chromeScope || check.profile === chromeScope.profile)) return true;
      if (Date.now() - started > L.chromeManualMs) return false;
      await sleep(L.accessibilityPollMs);
    }
  }

  async function chromeStep(folder) {
    if (skipChrome) { set('chrome', 'done', 'skipped'); return true; }
    let started = Date.now();
    let installationAttempted = false, accessibilityAsked = false, approvalTried = false;
    set('chrome', 'running');
    for (; ;) {
      const result = await d.verifyChrome(folder, { expectedVersion: state.version, ...chromeScope });
      if(result.ok&&chromeScope&&result.profile!==chromeScope.profile){set('chrome','error','runtime_profile_mismatch');reportFailure('chrome','runtime_profile_mismatch');return false;}
      if (result.ok && result.version === state.version) { set('chrome', 'done'); return true; }
      const reason = result.ok ? 'runtime_version_mismatch' : result.reason || 'runtime_not_verified';
      if (!installationAttempted && ['extension_missing', 'extension_not_pinned', 'extension_disabled', 'developer_mode_off'].includes(reason)) {
        installationAttempted = true;
        if (d.macChromeApproval && !approvalTried) {
          approvalTried = true;
          const viaChrome = await d.macChromeApproval(folder, { expectedVersion: state.version, ...(chromeScope?.userData ? { userData: chromeScope.userData } : {}),
            ...(chromeScope?.profile ? { profile: chromeScope.profile } : {}),
            // Only the switch and Allow need the person; a restart or the install itself is progress, not an action.
            onWaiting: what => set('chrome', ['debugging', 'approve'].includes(what) ? 'action' : 'running', what) });
          // Chrome writes its preference files a few seconds later; the verifier below confirms from them.
          if (viaChrome.ok) { set('chrome', 'running', 'verifying'); started = Date.now(); continue; }
          // Not finished through Chrome: the person adds it by hand (the instructions and the folder stay on screen).
          if (await waitForManualChrome(folder)) { set('chrome', 'done'); return true; }
          const why = viaChrome.reason + (viaChrome.step ? ' at ' + viaChrome.step : '');
          set('chrome', 'error', why); reportFailure('chrome', why); return false;
        }
        const installed = await d.installIntoChrome(folder, { expectedVersion: state.version, ...chromeScope });
        if (!installed.ok && installed.reason === 'mac_accessibility_permission_required' && d.macAccessibility && !accessibilityAsked) {
          accessibilityAsked = true;
          const outcome = await waitForMacAccessibility(folder);
          if (outcome === 'verified') { set('chrome', 'done'); return true; }
          if (outcome === 'granted') { installationAttempted = false; set('chrome', 'running'); continue; }
          set('chrome', 'error', installed.reason); reportFailure('chrome', installed.reason); return false;
        }
        if (!installed.ok) {
          const why = (installed.reason || 'native_install_failed') + (installed.step ? ' at ' + installed.step : '');
          if (await waitForManualChrome(folder)) { set('chrome', 'done'); return true; }
          set('chrome', 'error', why); reportFailure('chrome', why); return false;
        }
      }
      set('chrome', 'running', 'verifying');
      if (Date.now() - started > L.chromeManualMs) {
        set('chrome', 'error', reason); reportFailure('chrome', reason); return false;
      }
      await sleep(L.pollMs);
    }
  }

  // Events belong to the claimed, server-verified pairing session, including completion during downloads.
  let connectedSeen = false, watching = false, watcher = null;
  async function startWatcher() {
    connectedSeen = false;
    if (skipChrome || installOnly) return;
    watching = true;
    watcher = (async () => {
      while (watching) {
        const now = await d.pairingEvents().catch(() => null);
        if (now?.length) connectedSeen = true;
        await sleep(L.sunoPollMs ?? 400);
      }
    })();
  }

  async function run() {
    if (running) return; running = true;
    let releaseLock = null, completedReturn = false;
    Object.assign(state, { phase: 'running', error: '' });
    try {
      await startWatcher();
      set('download', 'running');
      let { release, bytes } = await d.fetchPublicRelease({ key });
      state.version = release.version; set('download', 'done');

      set('files', 'running');
      let priorConfig;
      try{priorConfig=JSON.parse(d.read(path.join(home,'updater.json')).replace(/^\uFEFF/,''));}catch(error){if(error.code!=='ENOENT')throw Error('invalid_updater_config');}
      const installs=d.chromeInstalls();
      chromeScope=skipChrome?null:await d.resolveChromeScope({home,installs,config:priorConfig});
      if(chromeScope)validateExistingScope(chromeScope,priorConfig,installs);
      const selected=chromeScope?installs.filter(item=>item.profile===chromeScope.profile):installs;
      const folder = d.selectExtensionDirectory({ home, installs: selected, fallback: path.join(os.homedir(), 'Documents', 'SunoCoverBot', 'extension'), read: d.read });
      // Preserve the configured installation scope; never borrow another Chrome profile's extension folder.
      try { const previous = JSON.parse(readFileSync(path.join(home, 'updater.json'), 'utf8')); if (previous.directory && !same(previous.directory, folder)) state.movedFrom = previous.directory; } catch { }
      for (let attempt = 0; ; attempt++) {
        try { releaseLock = await d.acquireComponentLock(folder); break; }
        catch (error) {
          if (error.message !== 'UPDATER_BUSY' || attempt >= L.lockRetries) throw error;
          await sleep(L.lockPollMs);
        }
      }
      state.folder = folder;
      const previousVersion = d.installedVersion(folder);
      if (previousVersion && isNewerVersion(previousVersion, release.version)) {
        // A pilot/admin may run ahead of the public bootstrap. Only its signed eligible target can replace it.
        const status = await d.nativeHeartbeat({ home, base: BASE, report: {
          updater_version: toolVersion, installed_version: previousVersion, updater_health: d.schedulerHealth(home),
        } });
        const target = status.target ? d.approvedComponent(status.target.envelope) : null;
        if (!target || isNewerVersion(previousVersion, target.version)) throw Error('release_downgrade_denied');
        ({ release, bytes } = await d.fetchPublicRelease({ key, meta: target }));
        if (isNewerVersion(previousVersion, release.version)) throw Error('release_downgrade_denied');
        state.version = release.version;
      }
      d.mkdir(home, { recursive: true });
      const toolBinary = process.platform === 'darwin' ? 'SunoCoverBotSetup-core' : 'SunoCoverBotSetup.exe';
      const exe = path.join(home, toolBinary);
      let previousTool = null;
      try { previousTool = JSON.parse(d.read(path.join(home, 'setup-version.json'))); } catch {}
      const newerToolInstalled = d.exists(exe) && /^\d+(\.\d+){1,3}$/.test(previousTool?.version || '') &&
        /^\d+(\.\d+){1,3}$/.test(toolVersion) && isNewerVersion(previousTool.version, toolVersion);
      if (!same(exePath, exe) && !newerToolInstalled) {
        try { rmSync(exe + '.old', { force: true }); } catch { }
        try { if (existsSync(exe)) renameSync(exe, exe + '.old'); } catch { }
        d.copyFile(exePath, exe);
        try { rmSync(exe + '.old', { force: true }); } catch { }
      }
      if (!newerToolInstalled && toolVersion && !(same(exePath, exe) && previousTool?.version === toolVersion))
        d.write(path.join(home, 'setup-version.json'), JSON.stringify({ version: toolVersion }));
      try { unlinkSync(exe + ':Zone.Identifier'); } catch (e) { }
      try { unlinkSync(exePath + ':Zone.Identifier'); } catch (e) { }
      // macOS: URL schemes live on the .app Info.plist. If we launched from a
      // DMG/.app, install that .app into ~/Applications so scbsetup:// keeps working
      // after the DMG is ejected (core binary alone is not enough).
      if (process.platform === 'darwin') {
        const appMatch = String(exePath).match(/^(.*\.app)(?=\/Contents\/)/i);
        if (appMatch && !newerToolInstalled) {
          const srcApp = appMatch[1];
          const destApp = path.join(os.homedir(), 'Applications', 'SunoCoverBotSetup.app');
          try {
            d.mkdir(path.dirname(destApp), { recursive: true });
            if (!same(srcApp, destApp)) {
              try { rmSync(destApp, { recursive: true, force: true }); } catch { }
              try { execFileSync('ditto', [srcApp, destApp], { stdio: 'ignore' }); }
              catch {
                try { execFileSync('cp', ['-R', srcApp, destApp], { stdio: 'ignore' }); } catch { }
              }
              try {
                execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', destApp], { stdio: 'ignore' });
              } catch { /* best-effort */ }
            }
          } catch { /* app install best-effort; core + updater.json still enable detection */ }
        }
      }
      d.write(path.join(home, 'updater.json'), JSON.stringify({ base: BASE, directory: folder, key,
        ...(chromeScope?{userData:chromeScope.userData,profile:chromeScope.profile}: {}) }, null, 2));
      d.installPackage(bytes, release, { key, directory: folder, previousVersion, registered: false });
      set('files', 'done');

      set('updates', 'running');
      if (process.platform === 'win32') {
        const launcher = path.join(home, 'update-launch.vbs');
        d.write(launcher, launcherScript(exe, '--update'));
        d.registerUpdater({ directory: home, launcherPath: launcher });
        d.registerProtocol(exe); // lets the website open this tool next time (scbsetup://)
      }
      // darwin: scbsetup:// / scbhelper:// come from the .app Info.plist (build-mac.sh); the quiet updater is a per-user
      // LaunchAgent running `core --update`. A Mac where launchd refuses must not block the install, so the failure is
      // recorded on the step instead of thrown (the status report shows it).
      let agentDetail = '';
      if (process.platform === 'darwin') {
        try {
          const agent = d.registerLaunchAgent({ corePath: exe, home });
          if (!agent.loaded || !agent.runsUpdate || !agent.interval) throw new Error('launchagent-verification-failed');
        } catch (error) { agentDetail = 'launchagent-failed: ' + String(error?.message || error).slice(0, 120); }
      }
      if (agentDetail) {
        d.writeMarker(folder, { registered: false, previousVersion: release.version, targetVersion: release.version });
        set('updates', 'error', agentDetail); state.phase = 'failed'; state.error = 'MAC_LAUNCHAGENT_FAILED'; return;
      }
      d.writeMarker(folder, { registered: true, previousVersion: release.version, targetVersion: release.version });
      d.bindNativeMarker(home, folder);
      if (process.platform === 'win32' && !d.chromeInstalls().some(c => !same(c.path, folder))) d.retireLegacyScheduler();
      set('updates', 'done', agentDetail);

      if (!(await chromeStep(folder))) { state.phase = 'failed'; state.error = 'chrome'; return; }
      if (releaseLock) { await releaseLock(); releaseLock = null; }
      if (installOnly) { state.phase = 'installed'; return; }

      set('suno', 'running');
      const started = Date.now();
      for (; ;) {
        const paired = connectedSeen ? true : null;
        if (paired === true) { set('suno', 'done'); break; }
        set('suno', 'action', 'waiting');
        if (skipChrome || Date.now() - started > L.pairingMs) break;
        await sleep(L.sunoPollMs ?? L.pollMs); // fast: the success page only stays open for ~2.5 s before it redirects
      }
      state.phase = state.steps.every(s => s.status === 'done') ? 'done' : 'waiting';
      if (state.phase === 'done' && autoReturn) {
        // Show all 5 completed steps in the front Setup Component window for a moment, then close the Setup window,
        // return the user to Telegram (keeping Chrome open), and end the tool.
        await sleep(L.closeMs ?? 1_200);
        try { onBeforeReturn(); } catch { }
        const back = await d.returnToTelegram().catch(() => ({ via: 'none' }));
        state.returnedVia = back.via;
        completedReturn = true;
      }
    } catch (error) {
      state.phase = 'failed'; state.error = String(error?.message || error);
      const active = state.steps.find(s => s.status === 'running'); if (active) set(active.id, 'error', String(error?.code || error?.message || error).slice(0, 160));
      // The failure also reaches the owner: where and why, with user names stripped from paths. Best effort, never blocks.
      reportFailure(active?.id || '', error?.code || error?.message || error);
    } finally {
      watching = false;
      if (watcher) await watcher;
      await pairing.close();
      if (releaseLock) await releaseLock();
      running = false;
      if (completedReturn) setTimeout(onDone, L.closeMs !== undefined ? L.closeMs : 150);
    }
  }
  function retry() { if (state.phase === 'failed' || state.phase === 'waiting') { for (const s of state.steps) if (s.status !== 'done') set(s.id, 'pending'); return run(); } }
  return { state, run, retry, snapshot: () => structuredClone(state) };
}

/** A silent run (opened by the website) shows its window only when something needs the user: a failure, or a Chrome step that needs a click. */
export function needsUserWindow(state) {
  return state.phase === 'failed' || state.steps.some(s => s.status === 'action' && ['permission', 'manual', 'accessibility'].includes(s.detail));
}
