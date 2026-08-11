// Executes the real runWatchLaterBatch source with fake I/O dependencies.
// Run all: node tests/verify_watch_later_batch_behavior.js
// Run one mutation case: node tests/verify_watch_later_batch_behavior.js 1
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const Core = require('../watch_later_core.js');

// Copied from verify_liked_sync_behavior.js: braces are counted only to extract
// the production function. Every assertion below is based on calls made at runtime.
function fn(name, src) {
  let start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function not found: ' + name);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let i = src.indexOf('(', start), p = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') p++;
    else if (src[i] === ')' && --p === 0) { i++; break; }
  }
  i = src.indexOf('{', i);
  let d = 0, q = '', line = false, block = false;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (line) { if (c === '\n') line = false; continue; }
    if (block) { if (c === '*' && n === '/') { block = false; i++; } continue; }
    if (q) { if (c === '\\') i++; else if (c === q) q = ''; continue; }
    if (c === '/' && n === '/') { line = true; i++; continue; }
    if (c === '/' && n === '*') { block = true; i++; continue; }
    if ('"\''.includes(c) || c.charCodeAt(0) === 96) { q = c; continue; }
    if (c === '{') d++;
    else if (c === '}' && --d === 0) return src.slice(start, i + 1);
  }
  throw new Error('unterminated function: ' + name);
}

const batchSource = fn('runWatchLaterBatch', background);
const NOW = 2000000000000;
const SESSION = 'wl7q-session';

function row(n, videoId) {
  const suffix = String(n).padStart(3, '0');
  return {
    videoId: videoId || 'video-' + suffix,
    setVideoId: 'set-' + suffix,
    title: 'title-' + n,
    channel: 'channel-' + n,
  };
}
function rows(count) {
  return Array.from({ length: count }, (_, i) => row(i + 1));
}
function snapshot(candidates, scannedAt) {
  return {
    syncSessionId: SESSION,
    scannedAt: scannedAt === undefined ? NOW : scannedAt,
    candidates: candidates.slice(),
  };
}

function makeRunner(initialScan, send, scan) {
  return new Function('deps',
    'const globalThis = { WatchLaterCore: deps.Core };\n'
    + 'const Date = deps.Date;\n'
    + 'let lastWatchLaterScan = deps.initialScan;\n'
    + 'const sendWatchLaterRemoval = deps.send;\n'
    + 'const scanWatchLater = async (options) => {\n'
    + '  const step = await deps.scan(options);\n'
    + '  if (step && step.snapshot) lastWatchLaterScan = step.snapshot;\n'
    + '  return step && step.result;\n'
    + '};\n'
    + batchSource + '\nreturn runWatchLaterBatch;')({
      Core: Core,
      Date: { now: () => NOW },
      initialScan: initialScan,
      send: send,
      scan: scan,
    });
}

async function execute(options) {
  const initialRows = options.initialRows;
  const sends = [], scans = [], events = [];
  let currentRows = initialRows.slice();

  const send = async (scanValue, target) => {
    const call = {
      number: sends.length + 1,
      videoId: target.videoId,
      setVideoId: target.setVideoId,
    };
    sends.push(call);
    events.push(Object.assign({ type: 'remove' }, call));
    const result = options.onSend
      ? await options.onSend(call, { scan: scanValue, sends: sends, scans: scans, events: events })
      : { ok: true };
    if (result && result.ok) {
      currentRows = currentRows.filter((candidate) => candidate.videoId !== target.videoId);
    }
    return result;
  };

  const scan = async (scanOptions) => {
    const call = { number: scans.length + 1, afterRemovals: sends.length };
    scans.push(call);
    events.push(Object.assign({ type: 'scan' }, call));
    const state = {
      options: scanOptions,
      sends: sends,
      scans: scans,
      events: events,
      currentRows: currentRows.slice(),
    };
    const custom = options.onScan ? await options.onScan(call, state) : null;
    const nextRows = custom && custom.rows ? custom.rows.slice() : currentRows.slice();
    if (custom && custom.rows) currentRows = nextRows.slice();
    const result = custom && custom.result ? custom.result : {
      success: true,
      counts: { total: nextRows.length, candidates: nextRows.length },
      drift: { compared: nextRows.length, changed: 0 },
    };
    return {
      result: result,
      snapshot: result.success ? snapshot(nextRows) : null,
    };
  };

  const run = makeRunner(snapshot(initialRows, options.scannedAt), send, scan);
  const result = await run({
    syncSessionId: SESSION,
    videoIds: options.approved || initialRows.map((candidate) => candidate.videoId),
    limit: options.limit,
  });
  return { result: result, sends: sends, scans: scans, events: events };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function same(actual, expected, message) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  assert(a === e, message + ': expected ' + e + ', got ' + a);
}

const cases = [
  {
    id: 1,
    name: '36 successes rescan at each Core.BATCH_CHUNK and once at the end',
    run: async () => {
      const candidates = rows(Core.BATCH_CHUNK * 3 + 6);
      assert(candidates.length === 36, 'fixture must contain 36 candidates');
      const h = await execute({ initialRows: candidates, limit: candidates.length });
      assert(h.result.removed.length === candidates.length, 'all approved rows must be removed');
      same(
        h.scans.map((call) => call.afterRemovals),
        [Core.BATCH_CHUNK, Core.BATCH_CHUNK * 2, Core.BATCH_CHUNK * 3, candidates.length],
        'rescan boundaries'
      );
      same(
        h.sends.map((call) => call.videoId),
        candidates.map((candidate) => candidate.videoId),
        'removal order'
      );
    },
  },
  {
    id: 2,
    name: 'five candidates bypass chunk rescans and receive only the final rescan',
    run: async () => {
      const candidates = rows(5);
      const h = await execute({ initialRows: candidates, limit: candidates.length });
      same(h.scans.map((call) => call.afterRemovals), [5], 'rescan calls');
      assert(h.result.removed.length === 5, 'all five rows must be removed');
    },
  },
  {
    id: 3,
    name: 'drift on the second chunk rescan stops all later removals',
    run: async () => {
      const candidates = rows(Core.BATCH_CHUNK * 3);
      const h = await execute({
        initialRows: candidates,
        onScan: (call, state) => call.number === 2 ? {
          result: { success: true, counts: {}, drift: { compared: 1, changed: 1 } },
          rows: state.currentRows,
        } : null,
      });
      assert(h.result.stopped === 'setvideoid-reassigned', 'unexpected stop: ' + h.result.stopped);
      assert(h.sends.length === Core.BATCH_CHUNK * 2, 'removal leaked past drift stop');
      same(h.events.slice(-2).map((event) => event.type), ['scan', 'scan'],
        'drift stop must be followed only by final scan');
    },
  },
  {
    id: 4,
    name: 'failed chunk rescan stops all later removals',
    run: async () => {
      const candidates = rows(Core.BATCH_CHUNK * 2);
      const h = await execute({
        initialRows: candidates,
        onScan: (call) => call.number === 1 ? { result: { success: false } } : null,
      });
      assert(h.result.stopped === 'rescan-failed', 'unexpected stop: ' + h.result.stopped);
      assert(h.sends.length === Core.BATCH_CHUNK, 'removal leaked past failed rescan');
      same(h.events.slice(-2).map((event) => event.type), ['scan', 'scan'],
        'failed chunk rescan must be followed only by final scan');
    },
  },
  {
    id: 5,
    name: 'third removal failure stops immediately and reports only two removals',
    run: async () => {
      const candidates = rows(6);
      const h = await execute({
        initialRows: candidates,
        onSend: (call) => call.number === 3
          ? { ok: false, reason: 'edit-not-confirmed' }
          : { ok: true },
      });
      assert(h.result.stopped === 'edit-not-confirmed', 'unexpected stop: ' + h.result.stopped);
      assert(h.result.removed.length === 2, 'reported removed count was not two');
      assert(h.sends.length === 3, 'removal was called after the failure');
      same(
        h.sends.map((call) => call.videoId),
        candidates.slice(0, 3).map((candidate) => candidate.videoId),
        'called removal rows'
      );
    },
  },
  {
    id: 6,
    name: 'a scan older than Core.SCAN_MAX_AGE_MS stops before any removal',
    run: async () => {
      const h = await execute({
        initialRows: rows(3),
        scannedAt: NOW - Core.SCAN_MAX_AGE_MS - 60 * 1000,
      });
      assert(h.result.stopped === 'scan-expired', 'unexpected stop: ' + h.result.stopped);
      assert(h.sends.length === 0, 'expired scan removed rows');
      assert(h.scans.length === 1, 'expected only the final scan');
    },
  },
  {
    id: 7,
    name: 'a newly eligible but unapproved rescan row is never sent for removal',
    run: async () => {
      const candidates = rows(Core.BATCH_CHUNK + 1);
      const approved = candidates.map((candidate) => candidate.videoId);
      const intruder = row(999, 'new-unapproved-video');
      let injected = false;
      const h = await execute({
        initialRows: candidates,
        approved: approved,
        onScan: (call, state) => {
          if (call.number !== 1) return null;
          injected = true;
          return { rows: [intruder].concat(state.currentRows) };
        },
      });
      assert(injected, 'chunk rescan did not inject the unapproved row');
      assert(!h.sends.some((call) => call.videoId === intruder.videoId),
        'unapproved row reached sendWatchLaterRemoval');
      same(h.sends.map((call) => call.videoId), approved, 'only approved rows may be removed');
    },
  },
  {
    id: 8,
    name: 'every exercised stop path final-rescans and keeps failed counts unknown',
    run: async () => {
      const stopCases = [
        {
          name: 'drift',
          rows: rows(Core.BATCH_CHUNK + 1),
          onScan: (call, state) => call.number === 1 ? {
            rows: state.currentRows,
            result: { success: true, drift: { compared: 1, changed: 1 }, counts: {} },
          } : { result: { success: false } },
        },
        {
          name: 'rescan-failed',
          rows: rows(Core.BATCH_CHUNK + 1),
          onScan: () => ({ result: { success: false } }),
        },
        {
          name: 'remove-failed',
          rows: rows(3),
          onSend: () => ({ ok: false, reason: 'edit-not-confirmed' }),
          onScan: () => ({ result: { success: false } }),
        },
        {
          name: 'scan-expired',
          rows: rows(3),
          scannedAt: NOW - Core.SCAN_MAX_AGE_MS - 60 * 1000,
          onScan: () => ({ result: { success: false } }),
        },
      ];
      for (const stop of stopCases) {
        const h = await execute({
          initialRows: stop.rows,
          scannedAt: stop.scannedAt,
          onSend: stop.onSend,
          onScan: stop.onScan,
        });
        assert(h.scans.length >= 1, stop.name + ': final scan was not called');
        assert(h.events[h.events.length - 1].type === 'scan',
          stop.name + ': final event was not a scan');
        assert(h.result.finalScanFailed === true,
          stop.name + ': finalScanFailed was not true');
        assert(h.result.counts === null,
          stop.name + ': counts were guessed after failed final scan');
      }
    },
  },
];

const selected = process.argv[2] === undefined
  ? cases
  : cases.filter((testCase) => String(testCase.id) === process.argv[2]);
if (!selected.length) {
  console.error('unknown case: ' + process.argv[2]);
  process.exit(2);
}

(async () => {
  let passed = 0, failed = 0;
  for (const testCase of selected) {
    try {
      await testCase.run();
      passed++;
      console.log('  PASS ' + testCase.id + '. ' + testCase.name);
    } catch (error) {
      failed++;
      console.log('  FAIL ' + testCase.id + '. ' + testCase.name);
      console.log('       ' + error.message);
    }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error('harness error:', error);
  process.exit(1);
});
