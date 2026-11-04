// On a fresh Mac, adding the extension to Chrome needs ONE switch: Privacy & Security > Accessibility for the app that ran
// the setup (Terminal). Before this, a real customer got "setup could not finish" (mac_accessibility_permission_required,
// reported 2026-11-04 by setup tool 2.3.12). Now the setup asks, shows where, waits, and continues by itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { createEngine, needsUserWindow } from '../scripts/setup-tool/engine.mjs';
import { macAccessibilityGranted, requestMacAccessibility, refreshMacSystemEvents } from '../scripts/setup-tool/native-browser.mjs';
import { setupCopy, SETUP_LANGUAGES } from '../scripts/setup-tool/copy.mjs';

const KEY = 'K'.repeat(120), HOME = '/Users/u/Library/Application Support/SunoCoverBot/setup';
const statuses = engine => Object.fromEntries(engine.state.steps.map(s => [s.id, s.status]));

function harness({ installs, granted = () => false, manualAfter = Infinity, accessibilityMs = 60, mac = true } = {}) {
  const calls = [], seenStates = [];
  let installed = false, verifies = 0, installCount = 0;
  const deps = {
    macChromeApproval: null, // these cases cover the Accessibility route; macChromeApproval.test.js covers the Chrome route
    acquireComponentLock: async () => async () => {}, bindNativeMarker: () => {}, retireLegacyScheduler: () => {},
    resolveChromeScope: async () => ({ userData: '/Users/u/Library/Application Support/Google/Chrome', profile: 'Default' }),
    fetchPublicRelease: async () => ({ release: { sha256: 'a'.repeat(64), version: '1.2.3' }, bytes: Buffer.from('zip') }),
    installPackage: () => {}, writeMarker: () => {}, installedVersion: () => '1.0.0', registerUpdater: () => {}, registerProtocol: () => {},
    registerLaunchAgent: () => ({ loaded: true, runsUpdate: true, interval: 900 }),
    chromeInstalls: () => [], pairingEvents: (() => { let i = 0; return async () => (i++ ? ['new-tab'] : []); })(),
    verifyChrome: async (_folder, request) => {
      verifies++;
      if (installed || verifies > manualAfter) return { ok: true, version: '1.2.3', profile: request.profile };
      return { ok: false, reason: 'extension_missing' };
    },
    installIntoChrome: async () => {
      const result = installs[Math.min(installCount++, installs.length - 1)];
      if (result.ok) installed = true;
      calls.push('install:' + (result.ok ? 'ok' : result.reason));
      return result;
    },
    macAccessibility: mac ? {
      granted: async () => { const value = granted(); calls.push('granted?' + value); return value; },
      request: async () => { calls.push('request'); },
      refresh: async () => { calls.push('refresh'); },
    } : null,
    reportSetupFailure: payload => calls.push(`report:${payload.step}:${payload.error}`),
    copyFile: () => {}, mkdir: () => {}, write: () => {}, read: () => { const e = Error('missing'); e.code = 'ENOENT'; throw e; }, exists: () => true,
  };
  const engine = createEngine({ key: KEY, home: HOME, exePath: HOME + '/SunoCoverBotSetup-core', sleep: async () => {
    const chrome = engine.state.steps.find(s => s.id === 'chrome');
    seenStates.push(chrome.status + ':' + chrome.detail);
  }, deps, limits: { pollMs: 0, chromePermissionMs: 40, chromeManualMs: 40, pairingMs: 40, accessibilityMs, accessibilityPollMs: 0 } });
  return { engine, calls, seenStates };
}
const NO_PERMISSION = { ok: false, reason: 'mac_accessibility_permission_required' };

test('no Accessibility yet: the setup asks once, waits, and adds the extension by itself when the switch turns on', async () => {
  let polls = 0;
  const { engine, calls, seenStates } = harness({ installs: [NO_PERMISSION, { ok: true }], granted: () => ++polls >= 3 });
  await engine.run();
  assert.equal(statuses(engine).chrome, 'done');
  assert.equal(engine.state.phase, 'done');
  assert.deepEqual(calls.filter(c => c === 'request'), ['request'], 'the macOS prompt and settings pane are opened exactly once');
  assert.deepEqual(calls.filter(c => c.startsWith('install:')), ['install:mac_accessibility_permission_required', 'install:ok']);
  assert.ok(calls.indexOf('request') < calls.indexOf('install:ok'));
  assert.ok(seenStates.includes('action:accessibility'), 'the window shows the Accessibility instructions while waiting');
  assert.ok(!calls.some(c => c.startsWith('report:')), 'waiting for the person is not a failure: nothing is reported');
});

test('the person adds the extension by hand instead: the step completes without a second automatic attempt', async () => {
  const { engine, calls } = harness({ installs: [NO_PERMISSION], manualAfter: 4 });
  await engine.run();
  assert.equal(statuses(engine).chrome, 'done');
  assert.deepEqual(calls.filter(c => c.startsWith('install:')), ['install:mac_accessibility_permission_required']);
  assert.ok(!calls.some(c => c.startsWith('report:')));
});

test('nobody turns it on: the step fails with the real reason, reported once', async () => {
  const { engine, calls } = harness({ installs: [NO_PERMISSION], accessibilityMs: 30 });
  await engine.run();
  assert.equal(engine.state.phase, 'failed');
  assert.deepEqual(engine.state.steps.find(s => s.id === 'chrome'), { id: 'chrome', status: 'error', detail: 'mac_accessibility_permission_required' });
  assert.deepEqual(calls.filter(c => c.startsWith('report:')), ['report:chrome:mac_accessibility_permission_required']);
});

test('macOS still refuses after the switch: no endless loop, one report', async () => {
  const { engine, calls } = harness({ installs: [NO_PERMISSION, NO_PERMISSION], granted: () => true });
  await engine.run();
  assert.equal(engine.state.phase, 'failed');
  assert.deepEqual(calls.filter(c => c === 'request'), ['request']);
  assert.deepEqual(calls.filter(c => c.startsWith('install:')), ['install:mac_accessibility_permission_required', 'install:mac_accessibility_permission_required']);
  assert.deepEqual(calls.filter(c => c.startsWith('report:')), ['report:chrome:mac_accessibility_permission_required']);
});

test('without the macOS helper (Windows) the same reason still fails at once, as before', async () => {
  const { engine, calls } = harness({ installs: [NO_PERMISSION], mac: false });
  await engine.run();
  assert.equal(engine.state.phase, 'failed');
  assert.ok(!calls.includes('request'));
  assert.deepEqual(calls.filter(c => c.startsWith('report:')), ['report:chrome:mac_accessibility_permission_required']);
});

test('a silent run opens its window for the Accessibility switch', () => {
  const state = { phase: 'running', steps: [{ id: 'chrome', status: 'action', detail: 'accessibility' }] };
  assert.equal(needsUserWindow(state), true);
});

test('the macOS probes are the native step\'s own check, and the request opens the system prompt and the exact pane', async () => {
  const seen = [];
  const exec = stdout => async (file, args) => { seen.push([file, ...args].join(' ')); if (stdout instanceof Error) throw stdout; return { stdout }; };
  assert.equal(await macAccessibilityGranted({ exec: exec('true\n') }), true);
  assert.equal(await macAccessibilityGranted({ exec: exec('false\n') }), false);
  assert.equal(await macAccessibilityGranted({ exec: exec(Error('-1743 not authorized')) }), false);
  // Measured on macOS 14.8: System Events' uiElementsEnabled kept answering false after Terminal's switch was turned on,
  // until System Events restarted, while AXIsProcessTrusted was already true. So the probe asks AXIsProcessTrusted...
  assert.match(seen[0], /^\/usr\/bin\/osascript -l JavaScript -e ObjC\.import\('ApplicationServices'\); \$\.AXIsProcessTrusted\(\)$/);
  // ...and System Events is restarted before the automatic retry, so the native step's own check sees the permission.
  const killed = [];
  await refreshMacSystemEvents({ exec: async (file, args) => { killed.push([file, ...args].join(' ')); throw Error('No matching processes'); } });
  assert.deepEqual(killed, ['/usr/bin/killall System Events']);
  // The probe must be the same condition native-install-mac.js checks first, or "granted" would not mean "will pass".
  assert.match(readFileSync(new URL('../scripts/setup-tool/native-install-mac.js', import.meta.url), 'utf8'), /system\.uiElementsEnabled\(\)/);
  seen.length = 0;
  await requestMacAccessibility({ exec: exec(Error('no prompt available')) });
  assert.equal(seen.length, 2, 'a failed prompt still opens the settings pane');
  assert.match(seen[0], /AXIsProcessTrustedWithOptions\(\$\(\{AXTrustedCheckOptionPrompt: true\}\)\)/);
  assert.equal(seen[1], '/usr/bin/open x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
});

test('the instructions exist in all 30 languages and the window renders them with the manual route and the folder', () => {
  assert.equal(SETUP_LANGUAGES.length, 30);
  for (const language of SETUP_LANGUAGES) {
    const copy = setupCopy(language);
    assert.ok(copy.macAccessibility && copy.macAccessibility.length > 60, language);
    assert.ok(copy.macAccessibility !== copy.chromeManual, language);
    if (language !== 'en') assert.notEqual(copy.macAccessibility, setupCopy('en').macAccessibility, language + ' is translated');
  }
  const ui = readFileSync(new URL('../scripts/setup-tool/ui/ui.js', import.meta.url), 'utf8');
  assert.doesNotThrow(() => new Script(ui));
  assert.match(ui, /step\.detail === 'accessibility'\) \{ more = el\('div', 'more', copy\.macAccessibility\); var alt = el\('div', 'more', copy\.chromeManual\); alt\.appendChild\(el\('code', '', s\.folder\)\)/);
});

test('a native failure names the step it stopped at, in the window and in the owner\'s alert', async () => {
  const { engine, calls } = harness({ installs: [{ ok: false, reason: 'native_control_unavailable', step: 'developer_mode' }] });
  await engine.run();
  assert.equal(engine.state.steps.find(s => s.id === 'chrome').detail, 'native_control_unavailable at developer_mode');
  assert.deepEqual(calls.filter(c => c.startsWith('report:')), ['report:chrome:native_control_unavailable at developer_mode']);
});

test('the native step uses the Chrome process that opened its own page, and turns page accessibility on only for the step', () => {
  const native = readFileSync(new URL('../scripts/setup-tool/native-install-mac.js', import.meta.url), 'utf8');
  assert.doesNotMatch(native, /applicationProcesses\.byName\('Google Chrome'\)/, 'the first process with that name may be the setup window');
  assert.match(native, /applicationProcesses\.whose\(\{ name: 'Google Chrome' \}\)\(\)/);
  const on = native.indexOf("$('AXEnhancedUserInterface'), $.NSNumber.numberWithBool(true)");
  const off = native.indexOf("$('AXEnhancedUserInterface'), $.NSNumber.numberWithBool(false)");
  assert.ok(on > 0 && off > on, 'switched on for the step, back off in finally');
  assert.ok(native.indexOf('write({ ok: false, reason, step, message') < off, 'the switch-off runs in the cleanup after the failure receipt');
  assert.ok(on < native.indexOf("checkpoint('developer_mode')"), 'on before the Extensions page controls are looked up');
});

test('the switch turning on restarts System Events before the automatic retry', async () => {
  const { engine, calls } = harness({ installs: [NO_PERMISSION, { ok: true }], granted: () => true });
  await engine.run();
  assert.ok(calls.indexOf('refresh') > 0 && calls.indexOf('refresh') < calls.indexOf('install:ok'));
});

test('macOS: when the automatic route fails, the person adds the extension by hand and the step completes', async () => {
  const { engine, calls, seenStates } = harness({ installs: [{ ok: false, reason: 'native_control_unavailable', step: 'extensions_navigation' }], manualAfter: 4 });
  await engine.run();
  assert.equal(statuses(engine).chrome, 'done');
  assert.ok(seenStates.includes('action:manual'), 'the window shows the manual route and the folder');
  assert.ok(!calls.some(c => c.startsWith('report:')), 'finishing by hand is not a failure');
});
