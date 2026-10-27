import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AGENT_LABEL, UPDATE_INTERVAL_SECONDS, agentPlistPath, plistFor, describeAgent,
  registerLaunchAgent, unregisterLaunchAgent, agentStatus,
} from '../scripts/setup-tool/launchagent.mjs';
import { desktopRegistered } from '../scripts/setup-tool/telegram.mjs';
import { createEngine } from '../scripts/setup-tool/engine.mjs';
import { UPDATE_INTERVAL } from '../scripts/setup-pilot/scheduler.mjs';

const CORE = '/Users/u/Library/Application Support/SunoCoverBot/setup/SunoCoverBotSetup-core';
const HOME = '/Users/u/Library/Application Support/SunoCoverBot/setup';
// The code under test uses the host's path separators; these tests also run on a Windows dev machine.
const posix = value => String(value).split('\\').join('/');

test('the macOS updater runs at the same cadence as the Windows task and runs `--update`', () => {
  assert.equal(`PT${UPDATE_INTERVAL_SECONDS / 60}M`, UPDATE_INTERVAL);
  const plist = plistFor({ corePath: CORE, logPath: HOME + '/launchd.log' });
  assert.ok(plist.includes(`<string>${AGENT_LABEL}</string>`));
  assert.match(plist, /<array><string>[^<]*SunoCoverBotSetup-core<\/string><string>--update<\/string><\/array>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, new RegExp(`<key>StartInterval</key><integer>${UPDATE_INTERVAL_SECONDS}</integer>`));
  // Quiet by construction: no terminal, no shell, nothing elevated.
  assert.doesNotMatch(plist, /\/bin\/sh|\/bin\/bash|osascript|sudo|RunAtLoad<\/key><false/);
});

test('plist text is XML-escaped so a path with & or < cannot break the file', () => {
  const plist = plistFor({ corePath: '/Users/a&b/<x>/core', logPath: '/tmp/l' });
  assert.ok(plist.includes('/Users/a&amp;b/&lt;x&gt;/core'));
});

test('registering writes the plist under ~/Library/LaunchAgents and loads it, replacing an older registration first', () => {
  const calls = [], writes = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (args[0] === 'print') return `${AGENT_LABEL} = {\n\tprogram = ${CORE}\n\targuments = {\n\t\t${CORE}\n\t\t--update\n\t}\n\trun interval = ${UPDATE_INTERVAL_SECONDS} seconds\n}`;
    return '';
  };
  const result = registerLaunchAgent({ corePath: CORE, home: HOME, userHome: '/Users/u', uid: 501, run, write: (f, t) => writes.push([f, t]), mkdir: () => {} });
  assert.equal(writes.length, 1);
  assert.equal(posix(writes[0][0]), posix(agentPlistPath('/Users/u')));
  assert.equal(posix(writes[0][0]), `/Users/u/Library/LaunchAgents/${AGENT_LABEL}.plist`);
  assert.deepEqual(calls.map(c => c.split(' ').slice(0, 3).join(' ')), [
    `/bin/launchctl bootout gui/501/${AGENT_LABEL}`,
    '/bin/launchctl bootstrap gui/501',
    `/bin/launchctl print gui/501/${AGENT_LABEL}`,
  ]);
  assert.deepEqual({ loaded: result.loaded, runsUpdate: result.runsUpdate, interval: result.interval }, { loaded: true, runsUpdate: true, interval: true });
});

test('an older macOS without `bootstrap` falls back to `load -w`, and a failed bootout (not loaded yet) is ignored', () => {
  const calls = [];
  const run = (cmd, args) => {
    calls.push(args[0]);
    if (args[0] === 'bootout' || args[0] === 'bootstrap' || args[0] === 'print') throw new Error('nope');
    return '';
  };
  const result = registerLaunchAgent({ corePath: CORE, home: HOME, userHome: '/Users/u', uid: 501, run, write: () => {}, mkdir: () => {} });
  assert.deepEqual(calls, ['bootout', 'bootstrap', 'load', 'print']);
  assert.equal(result.loaded, false, 'unverifiable registration is reported as not loaded, never as success');
});

test('unregister boots the agent out and deletes the plist; status reports loaded state and last exit code', () => {
  const removed = [], calls = [];
  const out = unregisterLaunchAgent({ userHome: '/Users/u', uid: 501, run: (c, a) => { calls.push(a[0]); return ''; }, remove: f => removed.push(f), exists: () => true });
  assert.equal(out, true);
  assert.deepEqual(calls, ['bootout']);
  assert.deepEqual(removed.map(posix), [`/Users/u/Library/LaunchAgents/${AGENT_LABEL}.plist`]);
  const status = agentStatus({ uid: 501, run: () => `\tstate = not running\n\truns = 3\n\tlast exit code = 0\n\trun interval = ${UPDATE_INTERVAL_SECONDS} seconds\n` });
  assert.deepEqual(status, { label: AGENT_LABEL, loaded: true, state: 'not running', runs: '3', lastExitCode: '0', runInterval: `${UPDATE_INTERVAL_SECONDS} seconds` });
  assert.deepEqual(agentStatus({ uid: 501, run: () => { throw new Error('missing'); } }), { label: AGENT_LABEL, loaded: false });
  assert.deepEqual(describeAgent('', CORE), { loaded: false, runsUpdate: false, interval: false });
});

test('Telegram Desktop on a Mac is an app bundle, not a registry key', () => {
  const seen = [];
  const found = desktopRegistered(() => { throw new Error('reg.exe must not run on a Mac'); }, { platform: 'darwin', exists: p => { seen.push(posix(p)); return posix(p).endsWith('/Applications/Telegram.app'); } });
  assert.equal(found, true);
  assert.ok(seen.every(p => /Telegram( Desktop)?\.app$/.test(p)));
  assert.equal(desktopRegistered(() => {}, { platform: 'darwin', exists: () => false }), false);
});

function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  return Promise.resolve().then(fn).finally(() => Object.defineProperty(process, 'platform', original));
}
function macEngine(overrides = {}) {
  const calls = [];
  const deps = {
    fetchPublicRelease: async () => ({ release: { sha256: 'a'.repeat(64), version: '1.2.3' }, bytes: Buffer.from('zip') }),
    installPackage: () => {}, writeMarker: () => {}, installedVersion: () => '1.0.0',
    registerUpdater: () => calls.push('windows-task'), registerProtocol: () => calls.push('windows-protocol'),
    registerLaunchAgent: o => { calls.push('launchagent:' + o.corePath); return { loaded: true }; },
    chromeInstalls: () => [], connectedTabIds: async () => [], loadIntoChrome: async () => ({ ok: true, version: '1.2.3' }),
    copyFile: () => {}, mkdir: () => {}, write: () => {}, exists: () => true, ...overrides,
  };
  const engine = createEngine({ key: 'K'.repeat(120), home: HOME, exePath: '/tmp/core', sleep: async () => {}, deps, skipChrome: true, limits: { pollMs: 0, pairingMs: 10 } });
  return { engine, calls };
}

test('on a Mac the updates step registers the LaunchAgent for the installed core, never the Windows task', async () => {
  await withPlatform('darwin', async () => {
    const { engine, calls } = macEngine();
    await engine.run();
    assert.deepEqual(calls.map(posix), ['launchagent:' + HOME + '/SunoCoverBotSetup-core']);
    const updates = engine.state.steps.find(s => s.id === 'updates');
    assert.equal(updates.status, 'done');
    assert.equal(updates.detail, '');
  });
});

test('a Mac where launchd refuses still finishes the install, and the step says why', async () => {
  await withPlatform('darwin', async () => {
    const { engine } = macEngine({ registerLaunchAgent: () => { throw new Error('Bootstrap failed: 5'); } });
    await engine.run();
    assert.notEqual(engine.state.phase, 'failed');
    const updates = engine.state.steps.find(s => s.id === 'updates');
    assert.equal(updates.status, 'done');
    assert.match(updates.detail, /^launchagent-failed: Bootstrap failed/);
  });
});

test('Windows behaviour is untouched: the engine still registers the scheduled task and no LaunchAgent', async () => {
  await withPlatform('win32', async () => {
    const { engine, calls } = macEngine({ registerUpdater: () => calls.push('windows-task') });
    await engine.run();
    assert.ok(calls.includes('windows-task'));
    assert.equal(calls.some(c => c.startsWith('launchagent')), false);
  });
});

test('main.mjs: a Mac `--update` exits by itself, and an up-to-date scheduled run never touches Chrome there', () => {
  const main = readFileSync(new URL('../scripts/setup-tool/main.mjs', import.meta.url), 'utf8').split('\r\n').join('\n');
  assert.match(main, /if \(process\.platform === 'darwin'\) \{ closeCdp\(\); process\.exit\(process\.exitCode \?\? 0\); \}/);
  assert.match(main, /if \(reloadChrome && !flag\('no-chrome'\) && process\.platform !== 'darwin'\) \{/);
  assert.match(main, /process\.platform === 'darwin' \? unregisterLaunchAgent\(\) : unregisterUpdater\(\)/);
});

test('the Mac package is a tar.gz built on a Mac runner; the DMG is no longer built', () => {
  const build = readFileSync(new URL('../scripts/setup-tool/build-mac.sh', import.meta.url), 'utf8').split('\r\n').join('\n');
  assert.match(build, /PUBLIC_PKG="\$ROOT\/public\/SunoCoverBotSetup-mac\.tar\.gz"/);
  assert.match(build, /tar -czf "\$PUBLIC_PKG"/);
  assert.doesNotMatch(build, /hdiutil create|hdiutil attach/);
});
