// macOS step 4 through Chrome's own approval mode: no restart, no flags, no Accessibility. The persistence invariant is
// measured (CI run 41840389021, macOS 15.8 + Chrome 156): Extensions.loadUnpacked alone is deleted at Chrome's next start
// (INSTALLED_VIA_CDP); Developer mode + ONE reload afterwards makes it a normal unpacked install that survives restarts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../scripts/setup-tool/engine.mjs';
import { installViaChromeApproval, readDebugEndpoint, INSPECT_URL } from '../scripts/setup-tool/mac-cdp-install.mjs';

const ID = 'geokjdngpomhdgjamobhgokjgphnjaed';
const ENDPOINT = { port: 9222, wsPath: '/devtools/browser/abc-123' };

function fakeChrome({ version = '1.2.3', reloadedState = 'ENABLED', loadedId = ID } = {}) {
  const calls = [];
  const client = () => ({
    close: () => calls.push('close'),
    send: async (method, params = {}) => {
      if (method === 'Runtime.evaluate') {
        const ex = params.expression;
        calls.push('eval:' + (/updateProfileConfiguration/.test(ex) ? 'devmode' : /\.reload\(/.test(ex) ? 'reload' : /getExtensionInfo/.test(ex) ? 'info' : /pinnedToToolbar/.test(ex) ? 'pin' : 'ready'));
        if (/getExtensionInfo/.test(ex)) return { result: { value: { state: calls.includes('eval:reload') ? reloadedState : 'ENABLED', version } } };
        return { result: { value: true } };
      }
      calls.push(method + (params.url ? ':' + params.url + (params.background ? ':bg' : '') : ''));
      if (method === 'Extensions.loadUnpacked') return { id: loadedId };
      if (method === 'Target.createTarget') return { targetId: 't1' };
      if (method === 'Target.attachToTarget') return { sessionId: 's1' };
      return {};
    },
  });
  return { calls, client };
}

test('the Chrome route: load, Developer mode, ONE reload after the load, pin, and the Extensions tab is closed again', async () => {
  const chrome = fakeChrome(), waits = [];
  const result = await installViaChromeApproval('/Users/u/Documents/SunoCoverBot/extension', { extensionId: ID, expectedVersion: '1.2.3', onWaiting: w => waits.push(w),
    deps: { readEndpoint: () => ENDPOINT, connect: async () => ({}), client: chrome.client, sleep: async () => {} } });
  assert.deepEqual(result, { ok: true, version: '1.2.3', pinned: true, route: 'chrome_approval' });
  const c = chrome.calls;
  assert.equal(c[0], 'Extensions.loadUnpacked');
  assert.ok(c.includes('Target.createTarget:chrome://extensions:bg'), 'a background tab: nothing pops up over the person\'s work');
  assert.ok(c.indexOf('eval:devmode') < c.indexOf('eval:reload'), 'Developer mode first, or the reloaded copy comes back disabled');
  assert.ok(c.indexOf('Extensions.loadUnpacked') < c.indexOf('eval:reload'), 'the reload is what removes the INSTALLED_VIA_CDP tag');
  assert.ok(c.includes('eval:pin') && c.includes('Target.closeTarget') && c.at(-1) === 'close');
  assert.deepEqual(waits, ['approve', 'installing']);
});

test('switch off: the page is opened once, the setup waits for it, then asks for Allow', async () => {
  const chrome = fakeChrome(), waits = [];
  let reads = 0, shown = 0;
  const result = await installViaChromeApproval('/x', { extensionId: ID, onWaiting: w => waits.push(w),
    deps: { readEndpoint: () => (++reads >= 4 ? ENDPOINT : null), showSwitch: async () => { shown++; }, connect: async () => ({}), client: chrome.client, sleep: async () => {} } });
  assert.equal(result.ok, true);
  assert.equal(shown, 1);
  assert.deepEqual(waits, ['debugging', 'approve', 'installing']);
});

test('nobody turns the switch on: a clear reason, no endless wait', async () => {
  let t = 0;
  const result = await installViaChromeApproval('/x', { extensionId: ID, limits: { enableMs: 5 },
    deps: { readEndpoint: () => null, showSwitch: async () => {}, sleep: async () => {}, now: () => (t += 3) } });
  assert.deepEqual(result, { ok: false, reason: 'chrome_debugging_not_enabled' });
});

test('Allow never clicked (or an old Chrome drops the first approval): bounded retries, then the reason', async () => {
  let tries = 0;
  const result = await installViaChromeApproval('/x', { extensionId: ID, limits: { attempts: 3 },
    deps: { readEndpoint: () => ENDPOINT, connect: async () => { tries++; throw Error('approval_timeout'); }, sleep: async () => {} } });
  assert.equal(tries, 3);
  assert.deepEqual(result, { ok: false, reason: 'chrome_approval_timeout' });
});

test('a different extension id or a reload that does not come back enabled is not success', async () => {
  const wrong = fakeChrome({ loadedId: 'a'.repeat(32) });
  assert.deepEqual(await installViaChromeApproval('/x', { extensionId: ID, deps: { readEndpoint: () => ENDPOINT, connect: async () => ({}), client: wrong.client, sleep: async () => {} } }),
    { ok: false, reason: 'extension_id_mismatch' });
  const disabled = fakeChrome({ reloadedState: 'DISABLED' });
  assert.deepEqual(await installViaChromeApproval('/x', { extensionId: ID, deps: { readEndpoint: () => ENDPOINT, connect: async () => ({}), client: disabled.client, sleep: async () => {} } }),
    { ok: false, reason: 'extension_not_enabled_after_reload' });
});

test('DevToolsActivePort is read strictly', () => {
  const at = text => readDebugEndpoint('/u', () => text);
  assert.deepEqual(at('9222\n/devtools/browser/d7decdab-0ffd-4304-8aa5-13fc514860e0'), { port: 9222, wsPath: '/devtools/browser/d7decdab-0ffd-4304-8aa5-13fc514860e0' });
  assert.equal(at('9222\n/devtools/page/x'), null);
  assert.equal(at('abc\n/devtools/browser/x'), null);
  assert.equal(readDebugEndpoint('/u', () => { throw Error('ENOENT'); }), null);
  assert.equal(INSPECT_URL, 'chrome://inspect/#remote-debugging');
});

function engineHarness(viaChrome, { manualAfter = Infinity } = {}) {
  const calls = [], seen = [];
  let installed = false, verifies = 0;
  const deps = {
    acquireComponentLock: async () => async () => {}, bindNativeMarker: () => {}, retireLegacyScheduler: () => {},
    resolveChromeScope: async () => ({ userData: '/Users/u/Library/Application Support/Google/Chrome', profile: 'Default' }),
    fetchPublicRelease: async () => ({ release: { sha256: 'a'.repeat(64), version: '1.2.3' }, bytes: Buffer.from('zip') }),
    installPackage: () => {}, writeMarker: () => {}, installedVersion: () => '1.0.0', registerUpdater: () => {}, registerProtocol: () => {},
    registerLaunchAgent: () => ({ loaded: true, runsUpdate: true, interval: 900 }),
    chromeInstalls: () => [], pairingEvents: (() => { let i = 0; return async () => (i++ ? ['new-tab'] : []); })(),
    verifyChrome: async (_f, request) => (installed || ++verifies > manualAfter ? { ok: true, version: '1.2.3', profile: request.profile } : { ok: false, reason: 'extension_missing' }),
    macChromeApproval: async (folder, options) => {
      calls.push('approval:' + options.userData);
      options.onWaiting('approve');
      const r = await viaChrome(); if (r.ok) installed = true; return r;
    },
    installIntoChrome: async () => { calls.push('native'); return { ok: false, reason: 'native_control_unavailable' }; },
    macAccessibility: { granted: async () => false, request: async () => { calls.push('accessibility'); }, refresh: async () => {} },
    reportSetupFailure: p => calls.push(`report:${p.step}:${p.error}`),
    copyFile: () => {}, mkdir: () => {}, write: () => {}, read: () => { const e = Error('missing'); e.code = 'ENOENT'; throw e; }, exists: () => true,
  };
  const engine = createEngine({ key: 'K'.repeat(120), home: '/Users/u/Library/Application Support/SunoCoverBot/setup', exePath: '/tmp/core', deps,
    sleep: async () => { const s = engine.state.steps.find(x => x.id === 'chrome'); seen.push(s.status + ':' + s.detail); },
    limits: { pollMs: 0, chromePermissionMs: 40, chromeManualMs: 40, pairingMs: 40, accessibilityPollMs: 0 } });
  return { engine, calls, seen };
}

test('engine (macOS): the Chrome route finishes step 4 without Accessibility, the native route or a report', async () => {
  const { engine, calls } = engineHarness(async () => ({ ok: true, version: '1.2.3', route: 'chrome_approval' }));
  await engine.run();
  assert.equal(engine.state.steps.find(s => s.id === 'chrome').status, 'done');
  assert.deepEqual(calls, ['approval:/Users/u/Library/Application Support/Google/Chrome']);
});

test('engine (macOS): the Chrome route did not finish -> the manual route, never the Accessibility prompt', async () => {
  const done = engineHarness(async () => ({ ok: false, reason: 'chrome_debugging_not_enabled' }), { manualAfter: 2 });
  await done.engine.run();
  assert.equal(done.engine.state.steps.find(s => s.id === 'chrome').status, 'done');
  assert.ok(done.seen.includes('action:manual'));
  assert.ok(!done.calls.includes('accessibility') && !done.calls.includes('native'));
  const failed = engineHarness(async () => ({ ok: false, reason: 'chrome_approval_timeout' }));
  await failed.engine.run();
  assert.deepEqual(failed.engine.state.steps.find(s => s.id === 'chrome'), { id: 'chrome', status: 'error', detail: 'chrome_approval_timeout' });
  assert.deepEqual(failed.calls.filter(c => c.startsWith('report:')), ['report:chrome:chrome_approval_timeout']);
});
