// Verification for persisted long-running job state and cancellation boundaries.
// Run: node tests/verify_job_state.js
const fs = require('fs');
const path = require('path');
const Core = require('../watch_later_core.js');

const root = path.join(__dirname, '..');
const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const history = fs.readFileSync(path.join(root, 'history.js'), 'utf8');

function fn(name, src) {
  let start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function not found: ' + name);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let i = src.indexOf('(', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) { i++; break; }
  }
  i = src.indexOf('{', i);
  let braces = 0, quote = '', line = false, block = false;
  for (; i < src.length; i++) {
    const c = src[i], next = src[i + 1];
    if (line) { if (c === '\n') line = false; continue; }
    if (block) { if (c === '*' && next === '/') { block = false; i++; } continue; }
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '/' && next === '/') { line = true; i++; continue; }
    if (c === '/' && next === '*') { block = true; i++; continue; }
    if ('"\''.includes(c) || c.charCodeAt(0) === 96) { quote = c; continue; }
    if (c === '{') braces++;
    else if (c === '}' && --braces === 0) return src.slice(start, i + 1);
  }
  throw new Error('unterminated function: ' + name);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function makeStorage(initial = {}, options = {}) {
  const state = clone(initial);
  const writes = [];
  return {
    state,
    writes,
    area: {
      async get(keys) {
        if (options.failGet) throw new Error('forced storage get failure');
        if (typeof keys === 'string') return { [keys]: clone(state[keys]) };
        const result = {};
        for (const key of Array.isArray(keys) ? keys : Object.keys(keys || {})) {
          if (Object.prototype.hasOwnProperty.call(state, key)) result[key] = clone(state[key]);
        }
        return result;
      },
      async set(payload) {
        writes.push(clone(payload));
        if (options.failSet) throw new Error('forced storage set failure');
        Object.assign(state, clone(payload));
      },
    },
  };
}

const registryFactory = new Function(
  'const JOB_CURRENT_KEY = "ytwh.job.current";\n'
  + 'const JOB_RECENT_KEY = "ytwh.job.recent";\n'
  + fn('createJobRegistry', background)
  + '\nreturn createJobRegistry;'
)();

const describeStop = new Function(
  fn('describeWatchLaterJobStop', background)
  + '\nreturn describeWatchLaterJobStop;'
)();
const finishWatchLaterJob = new Function(
  'describeWatchLaterJobStop',
  fn('finishWatchLaterJob', background) + '\nreturn finishWatchLaterJob;'
)(describeStop);

const batchSource = fn('runWatchLaterBatch', background);
const NOW = 2000000000000;
const SESSION = 'job-test-session';

function makeBatchRunner(initialScan, send, scan) {
  return new Function('deps',
    'const globalThis = { WatchLaterCore: deps.Core };\n'
    + 'const Date = deps.Date;\n'
    + 'let lastWatchLaterScan = deps.initialScan;\n'
    + 'const sendWatchLaterRemoval = deps.send;\n'
    + 'const scanWatchLater = deps.scan;\n'
    + batchSource + '\nreturn runWatchLaterBatch;')({
      Core,
      Date: { now: () => NOW },
      initialScan,
      send,
      scan,
    });
}

let passed = 0;
let failed = 0;
async function check(name, test) {
  try {
    await test();
    passed++;
    console.log('  PASS ' + name);
  } catch (error) {
    failed++;
    console.log('  FAIL ' + name + ' — ' + error.message);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function registryOptions(storage, overrides = {}) {
  let tick = overrides.startTime || 1000;
  return {
    storageArea: storage.area,
    now: overrides.now || (() => ++tick),
    randomUUID: overrides.randomUUID || (() => 'job-' + tick),
    setTimer: overrides.setTimer || setTimeout,
    clearTimer: overrides.clearTimer || clearTimeout,
    throttleMs: overrides.throttleMs === undefined ? 0 : overrides.throttleMs,
    logger: { warn() {} },
  };
}

(async () => {
  for (const terminalState of ['done', 'aborted', 'error']) {
    await check(`running から ${terminalState} へ遷移し直近履歴へ残る`, async () => {
      const storage = makeStorage();
      const registry = registryFactory(registryOptions(storage));
      await registry.ready;
      const job = await registry.startJob({
        kind: 'fixChannels', label: 'チャンネル名を補完', total: 2,
        counters: { updated: 0 }, message: '処理中', abortable: true,
      });
      assert(job.state === 'running', 'start state was not running');
      registry.updateJob(job, { processed: 1, counters: { updated: 1 }, message: '1件処理' });
      const finished = registry.finishJob(job, terminalState, {
        processed: 1,
        counters: { updated: 1 },
        message: terminalState,
        error: terminalState === 'error' ? 'boom' : null,
      });
      await registry.flush();
      assert(finished.state === terminalState, 'returned terminal state mismatch');
      assert(storage.state['ytwh.job.current'].state === terminalState, 'persisted terminal state mismatch');
      assert(storage.state['ytwh.job.recent'][0].state === terminalState, 'recent state mismatch');
      assert(storage.state['ytwh.job.recent'].length === 1, 'recent should contain one job');
      assert(terminalState !== 'error' || storage.state['ytwh.job.current'].error === 'boom', 'error detail was lost');
    });
  }

  await check('service worker 再起動時に running を interrupted へ掃く', async () => {
    const running = {
      id: 'stale', kind: 'fixDurations', label: '動画の長さを補完', state: 'running',
      startedAt: 10, updatedAt: 20, endedAt: null, total: 9, processed: 4,
      counters: { updated: 3 }, message: '処理中', error: null, abortable: true,
    };
    const storage = makeStorage({ 'ytwh.job.current': running, 'ytwh.job.recent': [] });
    const registry = registryFactory(registryOptions(storage));
    await registry.ready;
    const current = storage.state['ytwh.job.current'];
    assert(current.state === 'interrupted', 'stale running job was not interrupted');
    assert(current.endedAt !== null, 'interrupted job has no endedAt');
    assert(current.message === '中断されました（処理 4/9 件）', 'interrupted message lost progress');
    assert(storage.state['ytwh.job.recent'][0].id === 'stale', 'interrupted job missing from recent');
  });

  await check('storage.local の書き込み失敗がジョブ本体を止めない', async () => {
    const storage = makeStorage({}, { failSet: true });
    const registry = registryFactory(registryOptions(storage));
    await registry.ready;
    const job = await registry.startJob({
      kind: 'fixCredits', label: '概要欄からクレジット補完', total: 5,
      counters: { updated: 0 }, message: '開始', abortable: true,
    });
    let bodySteps = 0;
    for (let i = 1; i <= 5; i++) {
      bodySteps++;
      registry.updateJob(job, { processed: i, counters: { updated: i }, message: `${i}件` });
    }
    const finished = registry.finishJob(job, 'done', {
      processed: bodySteps, counters: { updated: bodySteps }, message: '完了',
    });
    await registry.flush();
    assert(bodySteps === 5, 'job body stopped after a persistence error');
    assert(finished && finished.state === 'done' && finished.processed === 5,
      'in-memory job did not reach done');
    assert(storage.writes.length >= 2, 'failure path did not attempt state writes');
  });

  await check('進捗保存は1秒に1回で、状態変化は即時に保存予約する', async () => {
    const storage = makeStorage();
    let clock = 1000;
    let scheduled = null;
    const options = registryOptions(storage, {
      now: () => clock,
      setTimer: (callback, delay) => { scheduled = { callback, delay, cleared: false }; return scheduled; },
      clearTimer: (timer) => { if (timer) timer.cleared = true; },
    });
    delete options.throttleMs;
    const registry = registryFactory(options);
    await registry.ready;
    const job = await registry.startJob({ kind: 'fixChannels', label: 'チャンネル名を補完', total: 10 });
    await registry.flush();
    assert(storage.writes.length === 1, 'running state was not written immediately');
    clock = 1100;
    registry.updateJob(job, { processed: 1 });
    clock = 1200;
    registry.updateJob(job, { processed: 2 });
    assert(storage.writes.length === 1 && scheduled && scheduled.delay === 900,
      'progress writes were not throttled');
    clock = 2000;
    scheduled.callback();
    await registry.flush();
    assert(storage.writes.length === 2, 'one-second progress write did not run');
    registry.finishJob(job, 'done', { processed: 10, message: '完了' });
    await registry.flush();
    assert(storage.writes.length === 3, 'terminal state was not written immediately');
  });

  await check('削除中断は1件の境界で止まり、削除件数を aborted ジョブへ残す', async () => {
    const rows = [1, 2, 3].map(n => ({
      videoId: 'video-' + n, setVideoId: 'set-' + n, title: 'title-' + n, channel: 'channel-' + n,
    }));
    const signal = { aborted: false };
    let sends = 0;
    const run = makeBatchRunner({ syncSessionId: SESSION, scannedAt: NOW, candidates: rows },
      async () => { sends++; signal.aborted = true; return { ok: true }; },
      async () => { throw new Error('an aborted batch must not rescan'); });

    const storage = makeStorage();
    const registry = registryFactory(registryOptions(storage));
    await registry.ready;
    const job = await registry.startJob({
      kind: 'bulkRemoveWatchLater', label: 'まとめて削除', total: 3,
      counters: { removed: 0 }, message: '削除中', abortable: true,
    });
    const result = await run({ syncSessionId: SESSION, videoIds: rows.map(row => row.videoId), limit: 3 },
      progress => registry.updateJob(job, {
        processed: progress.done,
        counters: { removed: progress.done },
        message: `${progress.done}件を削除`,
      }), signal);
    const patch = finishWatchLaterJob(result, 'aborted');
    registry.finishJob(job, 'aborted', patch);
    await registry.flush();
    const stored = storage.state['ytwh.job.current'];
    assert(sends === 1, 'a second deletion started after abort');
    assert(result.removed.length === 1 && result.processed === 1, 'completed deletion was not reported');
    assert(stored.state === 'aborted' && stored.counters.removed === 1 && stored.processed === 1,
      'aborted job lost the removed count');
    assert(stored.message.includes('1件を削除'), 'aborted message does not say how many were deleted');
  });

  await check('4本の長時間 Port は共通中断ヘルパを使う', async () => {
    const ports = [...background.matchAll(/portName: '([^']+)'/g)].map(match => match[1]);
    for (const expected of ['fix-credits', 'fix-durations', 'watch-later-batch', 'fix-channels']) {
      assert(ports.includes(expected), 'missing shared port registration: ' + expected);
    }
    const helper = fn('registerJobPort', background);
    assert(/port\.onDisconnect\.addListener\(\(\) => \{ abortSignal\.aborted = true; \}\)/.test(helper),
      'disconnect does not abort the shared job');
    assert(/fixChannelsBatch\(videoIds, force, onProgress, abortSignal\)/.test(background),
      'fixChannelsBatch does not accept abortSignal');
    assert(/runWatchLaterBatch\(\{ syncSessionId, videoIds, limit \} = \{\}, onProgress, abortSignal\)/.test(background),
      'runWatchLaterBatch does not accept abortSignal');
  });

  await check('履歴画面の状態文言は renderJob だけが書き、SVG付きボタンは span だけを更新する', async () => {
    const directWrites = history.match(/fixStatus\.textContent\s*=/g) || [];
    assert(directWrites.length === 1, 'fixStatus has direct writes outside renderJob: ' + directWrites.length);
    assert(/function renderJob\(/.test(history), 'renderJob is missing');
    assert(/if \(item\.textEl\) item\.textEl\.textContent = text;/.test(history), 'button span is not updated');
    assert(!/btn\.textContent = item\.defaultText/.test(history), 'button reset still removes SVG icons');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error('harness error:', error);
  process.exit(1);
});
