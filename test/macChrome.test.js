import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CHROME_BIN, dataVolumePath, userChromePids, loadIntoChromeMac } from '../scripts/setup-tool/mac-chrome.mjs';

const USER_DATA = '/Users/u/Library/Application Support/Google/Chrome';
const ALIAS = '/System/Volumes/Data/Users/u/Library/Application Support/Google/Chrome';
const WINDOW = '/Users/u/Library/Application Support/SunoCoverBot/setup/window-profile';
const FOLDER = '/Users/u/Documents/SunoCoverBot/extension';
const posix = value => String(value).split('\\').join('/');

const ps = lines => lines.join('\n');
const USER_MAIN = `${CHROME_BIN}`;
const WINDOW_MAIN = `${CHROME_BIN} --app=http://127.0.0.1:1/ --user-data-dir=${WINDOW} --window-size=540,860`;
const HELPER = '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=renderer';

test('only the USER\'s Chrome main process is picked: not the setup window, not helpers, and our own debug instance is marked', () => {
  const out = userChromePids(ps([` 10 ${USER_MAIN}`, ` 11 ${HELPER}`, ` 12 ${WINDOW_MAIN}`, ` 13 ${CHROME_BIN} --user-data-dir=${ALIAS} --remote-debugging-port=0`, ' 14 /usr/bin/python3 x']), { windowProfile: WINDOW, alias: ALIAS });
  assert.deepEqual(out, [{ pid: 10, ours: false }, { pid: 13, ours: true }]);
});

/** A tiny fake Mac: a process table, a file set, and an event log. */
function world({ marker: markerValue = null, chromeRunning = true, quits = true, portAppears = true, loadResults = [], installs = [], binary = true, spawnThrows = false } = {}) {
  const log = [];
  const live = new Map(chromeRunning ? [[10, USER_MAIN], [12, WINDOW_MAIN]] : [[12, WINDOW_MAIN]]);
  const files = new Set(binary ? [CHROME_BIN, ALIAS] : [ALIAS]);
  const results = [...loadResults];
  let t = 0;
  const realNow = Date.now;
  Date.now = () => (t += 5);
  const deps = {
    run: () => [...live].map(([pid, cmd]) => ` ${pid} ${cmd}`).join('\n'),
    kill: (pid, sig) => { log.push(`kill ${pid} ${sig}`); if (quits || pid === 13) live.delete(pid); },
    sleep: async () => {},
    loadIntoChrome: async () => { log.push('load'); return results.shift() ?? { ok: true, version: '1.2.3' }; },
    closeCdp: () => log.push('closeCdp'),
    chromeInstalls: () => installs,
    session: { relaunched: false }, log: () => {}, // a fresh "process" per test; the real log file is never written
    exists: p => files.has(posix(p)),
    mkdir: () => {}, rm: (p) => { log.push(`rm ${path.basename(p)}`); files.delete(posix(p)); },
    spawnChrome: args => {
      if (spawnThrows) throw new Error('ENOENT');
      log.push('spawn ' + args.join(' '));
      live.set(13, `${CHROME_BIN} ${args.join(' ')}`);
      if (portAppears) files.add(posix(path.join(USER_DATA, 'DevToolsActivePort')));
    },
    openChrome: args => { log.push('open ' + args.join(' ')); live.set(20, USER_MAIN); },
    readFile: () => { if (markerValue === null) throw new Error('none'); return markerValue; },
    writeFile: (_p, text) => { log.push('marker ' + text); },
    now: () => 1_000_000, marker: '/m.json',
    userData: USER_DATA, alias: ALIAS, windowProfile: WINDOW, quitMs: 50, portMs: 50,
  };
  return { deps, log, live, done: () => { Date.now = realNow; } };
}

test('already drivable: the normal step succeeds and Chrome is never restarted', async () => {
  const w = world();
  try {
    const r = await loadIntoChromeMac(FOLDER, { expectedVersion: '1.2.3', deps: w.deps });
    assert.equal(r.ok, true);
    assert.deepEqual(w.log, ['load']);
  } finally { w.done(); }
});

test('extension already loaded AND pinned from this folder: success without touching Chrome', async () => {
  const w = world({ loadResults: [{ ok: false, reason: 'debugging_off' }], installs: [{ profile: 'Default', path: FOLDER, pinned: true }] });
  try {
    const r = await loadIntoChromeMac(FOLDER, { expectedVersion: '1.2.3', deps: w.deps });
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'already_installed');
    assert.deepEqual(w.log, ['load']);
  } finally { w.done(); }
});

test('debugging off: quit the user\'s Chrome, start it on the alias with a port + session restore, load, then restore Chrome normally', async () => {
  const w = world({ loadResults: [{ ok: false, reason: 'debugging_off' }, { ok: true, version: '1.2.3' }] });
  try {
    const r = await loadIntoChromeMac(FOLDER, { expectedVersion: '1.2.3', deps: w.deps });
    assert.equal(r.ok, true);
    assert.equal(r.relaunched, true);
    const L = w.log;
    // The setup window (pid 12) is never signalled.
    assert.equal(L.some(l => l.startsWith('kill 12')), false);
    const at = needle => L.findIndex(l => l.startsWith(needle));
    assert.ok(at('kill 10 SIGTERM') >= 0, 'graceful quit of the user Chrome');
    assert.equal(ALIAS, dataVolumePath(USER_DATA), 'the alias is the data-volume spelling of the real profile');
    assert.ok(at('kill 10') < at('spawn'), 'quit before the debug start');
    const spawnLine = L[at('spawn')];
    assert.ok(spawnLine.includes(`--user-data-dir=${ALIAS}`) && spawnLine.includes('--remote-debugging-port=0') && spawnLine.includes('--enable-unsafe-extension-debugging') && spawnLine.includes('--restore-last-session'));
    assert.ok(at('spawn') < L.indexOf('closeCdp'), 'load happens while the debug instance is up');
    assert.ok(L.indexOf('closeCdp') < at('kill 13 SIGTERM'), 'debug instance is closed after the load');
    assert.ok(at('kill 13') < at('open'), 'normal Chrome starts only after the debug instance is gone');
    assert.equal(L[at('open')], 'open --restore-last-session');
    assert.equal(w.live.has(13), false, 'no debugging instance left behind');
    assert.ok(L.filter(l => l === 'rm DevToolsActivePort').length >= 2, 'stale port file removed before and after');
  } finally { w.done(); }
});

test('Chrome was not running: it is not started again afterwards', async () => {
  const w = world({ chromeRunning: false, loadResults: [{ ok: false, reason: 'debugging_off' }, { ok: true, version: '1.2.3' }] });
  try {
    const r = await loadIntoChromeMac(FOLDER, { expectedVersion: '1.2.3', deps: w.deps });
    assert.equal(r.ok, true);
    assert.equal(w.log.some(l => l.startsWith('open ')), false);
    assert.equal(w.log.some(l => l === 'kill 10 SIGTERM'), false);
  } finally { w.done(); }
});

test('no Chrome binary: nothing is quit', async () => {
  const w = world({ binary: false, loadResults: [{ ok: false, reason: 'debugging_off' }] });
  try {
    const r = await loadIntoChromeMac(FOLDER, { deps: w.deps });
    assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: 'chrome_not_found' });
    assert.equal(w.log.some(l => l.startsWith('kill')), false);
  } finally { w.done(); }
});

test('Chrome refuses to quit: give up, do not start a second instance, fall back to the manual step', async () => {
  const w = world({ quits: false, loadResults: [{ ok: false, reason: 'debugging_off' }] });
  try {
    const r = await loadIntoChromeMac(FOLDER, { deps: w.deps });
    assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: 'chrome_did_not_quit' });
    assert.equal(w.log.some(l => l.startsWith('spawn')), false);
  } finally { w.done(); }
});

test('the debug start fails: the user\'s Chrome is brought back, not left closed', async () => {
  const w = world({ spawnThrows: true, loadResults: [{ ok: false, reason: 'debugging_off' }] });
  try {
    const r = await loadIntoChromeMac(FOLDER, { deps: w.deps });
    assert.equal(r.ok, false);
    assert.match(r.reason, /^chrome_start_failed/);
    assert.ok(w.log.includes('open --restore-last-session'));
  } finally { w.done(); }
});

test('debug port never appears: still restores Chrome and reports it', async () => {
  const w = world({ portAppears: false, loadResults: [{ ok: false, reason: 'debugging_off' }] });
  try {
    const r = await loadIntoChromeMac(FOLDER, { deps: w.deps });
    assert.deepEqual({ ok: r.ok, reason: r.reason, relaunched: r.relaunched }, { ok: false, reason: 'debug_port_missing', relaunched: true });
    assert.ok(w.log.includes('open --restore-last-session'));
    assert.equal(w.log.filter(l => l === 'load').length, 1, 'no load attempt without a port');
  } finally { w.done(); }
});

test('an unrelated failure (e.g. extension not enabled) is returned as is, with no restart', async () => {
  const w = world({ loadResults: [{ ok: false, reason: 'not_enabled' }] });
  try {
    const r = await loadIntoChromeMac(FOLDER, { deps: w.deps });
    assert.equal(r.reason, 'not_enabled');
    assert.deepEqual(w.log, ['load']);
  } finally { w.done(); }
});

test('a debug port that never opened is remembered: the next run does not restart Chrome again', async () => {
  const first = world({ portAppears: false, loadResults: [{ ok: false, reason: 'debugging_off' }] });
  try {
    await loadIntoChromeMac(FOLDER, { deps: first.deps });
    const written = first.log.find(l => l.startsWith('marker '));
    assert.ok(written, 'marker written');
    const again = world({ marker: written.slice('marker '.length), loadResults: [{ ok: false, reason: 'debugging_off' }] });
    const r = await loadIntoChromeMac(FOLDER, { deps: again.deps });
    assert.equal(r.reason, 'relaunch_disabled');
    assert.deepEqual(again.log, ['load'], 'Chrome untouched');
  } finally { first.done(); }
});

test('an old marker expires and a transient failure (Chrome did not quit) never leaves one', async () => {
  const old = world({ marker: JSON.stringify({ reason: 'debug_port_missing', at: 1_000_000 - 15 * 24 * 3600 * 1000 }), loadResults: [{ ok: false, reason: 'debugging_off' }, { ok: true, version: '1.2.3' }] });
  try {
    const r = await loadIntoChromeMac(FOLDER, { deps: old.deps });
    assert.equal(r.ok, true);
  } finally { old.done(); }
  const stuck = world({ quits: false, loadResults: [{ ok: false, reason: 'debugging_off' }] });
  try {
    await loadIntoChromeMac(FOLDER, { deps: stuck.deps });
    assert.equal(stuck.log.some(l => l.startsWith('marker ')), false);
  } finally { stuck.done(); }
});

test('without the data-volume path nothing is quit', async () => {
  const w = world({ loadResults: [{ ok: false, reason: 'debugging_off' }] });
  w.deps.exists = p => posix(p) === CHROME_BIN;
  try {
    const r = await loadIntoChromeMac(FOLDER, { deps: w.deps });
    assert.equal(r.reason, 'data_volume_path_missing');
    assert.deepEqual(w.log, ['load']);
  } finally { w.done(); }
});

test('THE POLLING LOOP: the engine calls this step again and again; Chrome is quit and restarted exactly ONCE, never per poll', async () => {
  // Every probe says "not drivable", the extension can never be accepted: the worst case that used to restart Chrome on every poll.
  const w = world({ loadResults: [{ ok: false, reason: 'debugging_off' }, { ok: false, reason: 'not_enabled' }, ...Array.from({ length: 40 }, () => ({ ok: false, reason: 'debugging_off' }))] });
  try {
    const reasons = [];
    for (let i = 0; i < 25; i++) reasons.push((await loadIntoChromeMac(FOLDER, { expectedVersion: '1.2.3', deps: w.deps })).reason);
    assert.equal(w.log.filter(l => l.startsWith('spawn')).length, 1, 'one debug start in 25 polls');
    assert.equal(w.log.filter(l => l === 'kill 10 SIGTERM').length, 1, 'the user Chrome was quit once');
    assert.equal(w.log.filter(l => l === 'open --restore-last-session').length, 1, 'and brought back once');
    assert.equal(reasons[0], 'not_enabled');
    assert.ok(reasons.slice(1).every(r => r === 'relaunch_already_done'), 'every later poll leaves Chrome alone: ' + [...new Set(reasons.slice(1))]);
    assert.equal(w.live.has(13), false, 'no debug instance left running');
  } finally { w.done(); }
});

test('a restart that did not end in success is remembered across runs for hours, then forgotten', async () => {
  const first = world({ loadResults: [{ ok: false, reason: 'debugging_off' }, { ok: false, reason: 'not_enabled' }] });
  let written;
  try {
    await loadIntoChromeMac(FOLDER, { deps: first.deps });
    written = first.log.find(l => l.startsWith('marker '));
    assert.ok(written && JSON.parse(written.slice('marker '.length)).reason === 'relaunch_failed');
  } finally { first.done(); }
  const soon = world({ marker: JSON.stringify({ ...JSON.parse(written.slice('marker '.length)), at: 1_000_000 - 3 * 3600 * 1000 }), loadResults: [{ ok: false, reason: 'debugging_off' }] });
  try {
    const r = await loadIntoChromeMac(FOLDER, { deps: soon.deps });
    assert.equal(r.reason, 'relaunch_disabled');
    assert.deepEqual(soon.log, ['load'], 'a new run within 6 hours does not touch Chrome');
  } finally { soon.done(); }
  const later = world({ marker: JSON.stringify({ reason: 'relaunch_failed', at: 1_000_000 - 7 * 3600 * 1000 }), loadResults: [{ ok: false, reason: 'debugging_off' }, { ok: true, version: '1.2.3' }] });
  try {
    assert.equal((await loadIntoChromeMac(FOLDER, { deps: later.deps })).ok, true, 'after 6 hours it may try again');
  } finally { later.done(); }
});

test('a successful restart marks nothing and leaves no failure marker', async () => {
  const w = world({ loadResults: [{ ok: false, reason: 'debugging_off' }, { ok: true, version: '1.2.3' }] });
  try {
    assert.equal((await loadIntoChromeMac(FOLDER, { deps: w.deps })).ok, true);
    assert.equal(w.log.some(l => l.startsWith('marker ')), false);
  } finally { w.done(); }
});
