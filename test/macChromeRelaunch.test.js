// macOS step 4 with NO approval at all (owner, 2026-11-04): Chrome closes once (its normal quit) and launchd reopens it
// with all its tabs and a PRIVATE pipe; the extension is loaded persistently; the pipe's paths are deleted afterwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installViaChromeRelaunch, personChromePids, chromeJobPlist, pipeClient, CHROME_BIN } from '../scripts/setup-tool/mac-cdp-install.mjs';

const ID = 'geokjdngpomhdgjamobhgokjgphnjaed';
const UD = '/Users/u/Library/Application Support/Google/Chrome';
const PS_RUNNING = [
  `  101 ${CHROME_BIN} --restore-last-session`,
  `  102 ${CHROME_BIN} --type=renderer --lang=en`,
  `  103 ${CHROME_BIN} --user-data-dir=/tmp/someone-elses-profile`,
  `  104 /usr/bin/other`,
].join('\n');

function fakeCdp(calls) {
  return {
    close: () => calls.push('pipe-closed'),
    send: async (method, params = {}) => {
      if (method === 'Runtime.evaluate') {
        const ex = params.expression;
        calls.push('eval:' + (/updateProfileConfiguration/.test(ex) ? 'devmode' : /\.reload\(/.test(ex) ? 'reload' : /getExtensionInfo/.test(ex) ? 'info' : /pinnedToToolbar/.test(ex) ? 'pin' : 'ready'));
        return { result: { value: /getExtensionInfo/.test(ex) ? { state: 'ENABLED', version: '1.2.3' } : true } };
      }
      calls.push(method);
      if (method === 'Extensions.loadUnpacked') return { id: ID };
      if (method === 'Target.createTarget') return { targetId: 't' };
      if (method === 'Target.attachToTarget') return { sessionId: 's' };
      return {};
    },
  };
}

function harness({ running = true, quits = true, launchFails = false } = {}) {
  const calls = [], waits = []; let alive = running, plist = '';
  const deps = {
    exists: () => true, sleep: async () => {}, now: (() => { let t = 0; return () => (t += 100); })(),
    ps: () => (alive ? PS_RUNNING : '  104 /usr/bin/other'),
    kill: (pid, sig) => { calls.push(`kill:${pid}:${sig}`); if (quits) alive = false; },
    mkdtemp: () => '/tmp/scb-chrome-x', mkfifo: (...p) => calls.push('mkfifo:' + p.join(',')),
    write: (file, text) => { plist = text; calls.push('plist:' + file); },
    launchctl: args => { calls.push('launchctl:' + args.join(' ')); if (launchFails) throw Error('Bootstrap failed: 5'); alive = true; },
    connectPipe: (i, o) => { calls.push(`pipe:${i},${o}`); return fakeCdp(calls); },
    open: args => { calls.push('open:' + args.join(' ')); alive = true; },
    remove: dir => calls.push('removed:' + dir), uid: () => 501,
  };
  const run = options => installViaChromeRelaunch('/Users/u/Documents/SunoCoverBot/extension', { extensionId: ID, expectedVersion: '1.2.3', userData: UD, onWaiting: w => waits.push(w), deps, limits: { quitMs: 1000 }, ...options });
  return { run, calls, waits, plist: () => plist };
}

test('Chrome open: its normal quit, reopened by launchd with all its tabs and a private pipe, loaded persistently, pipe paths deleted', async () => {
  const h = harness();
  const result = await h.run({ profile: 'Profile 1' });
  assert.deepEqual(result, { ok: true, version: '1.2.3', pinned: true, route: 'chrome_relaunch' });
  assert.deepEqual(h.calls.filter(c => c.startsWith('kill:')), ['kill:101:SIGTERM'], 'only the person\'s Chrome, never helpers or other profiles; never SIGKILL');
  assert.ok(h.calls.includes('launchctl:bootstrap gui/501 /tmp/scb-chrome-x/chrome.plist'));
  const p = h.plist();
  assert.match(p, /<string>exec 3&lt;&gt;"\$1" 4&lt;&gt;"\$2"; shift 2; exec "\$@"<\/string>/, 'Chrome holds both FIFOs READ-WRITE: it never sees end-of-file, so it never closes itself');
  for (const arg of ['--user-data-dir=/System/Volumes/Data' + UD, '--remote-debugging-pipe', '--restore-last-session', '--profile-directory=Profile 1']) assert.ok(p.includes(`<string>${arg}</string>`), arg);
  assert.doesNotMatch(p, /remote-debugging-port/, 'no network port, ever');
  assert.match(p, /<key>KeepAlive<\/key><false\/>/, 'launchd must not restart Chrome after the person quits it');
  const c = h.calls;
  assert.ok(c.indexOf('Browser.getVersion') < c.indexOf('Extensions.loadUnpacked') && c.indexOf('eval:devmode') < c.indexOf('eval:reload'));
  assert.deepEqual(c.slice(-2), ['pipe-closed', 'removed:/tmp/scb-chrome-x']);
  assert.deepEqual(h.waits, ['restart', 'installing']);
});

test('Chrome not open: nothing is closed, it simply starts (no session restore flag)', async () => {
  const h = harness({ running: false });
  assert.equal((await h.run()).ok, true);
  assert.ok(!h.calls.some(c => c.startsWith('kill:')));
  assert.ok(!h.plist().includes('--restore-last-session'));
  assert.deepEqual(h.waits, ['starting', 'installing']);
});

test('a Chrome that does not quit is left alone: no force, nothing launched', async () => {
  const h = harness({ quits: false });
  assert.deepEqual(await h.run(), { ok: false, reason: 'chrome_did_not_quit' });
  assert.ok(!h.calls.some(c => /SIGKILL|launchctl|open:/.test(c)));
});

test('if the relaunch fails, Chrome is reopened normally with its tabs - it never stays closed', async () => {
  const h = harness({ launchFails: true });
  const result = await h.run();
  assert.equal(result.reason, 'chrome_relaunch_failed');
  assert.ok(h.calls.includes('open:-a Google Chrome --args --restore-last-session'));
  assert.equal(h.calls.at(-1), 'removed:/tmp/scb-chrome-x');
});

test('the person\'s Chrome is recognised in both spellings of its folder, and only main processes count', () => {
  const ps = [`1 ${CHROME_BIN}`, `2 ${CHROME_BIN} --user-data-dir=/System/Volumes/Data${UD} --remote-debugging-pipe`, `3 ${CHROME_BIN} --user-data-dir=${UD}`, `4 ${CHROME_BIN} --type=gpu-process`, `5 ${CHROME_BIN} --user-data-dir=/tmp/other`].join('\n');
  assert.deepEqual(personChromePids(ps, UD), [1, 2, 3]);
});

test('the pipe speaks NUL-separated JSON', async () => {
  const written = [], readable = new EventEmitter(), writable = { write: t => written.push(t), on() {}, destroy() {} };
  readable.destroy = () => {};
  const cdp = pipeClient(writable, readable);
  const answer = cdp.send('Browser.getVersion');
  assert.equal(written[0], JSON.stringify({ id: 1, method: 'Browser.getVersion', params: {} }) + '\0');
  readable.emit('data', Buffer.from('{"id":1,"result":{"product":"Chrome/156"}}\0'));
  assert.deepEqual(await answer, { product: 'Chrome/156' });
  assert.match(chromeJobPlist('a&b', ['x<y']), /<string>a&amp;b<\/string>.*<string>x&lt;y<\/string>/s);
});
