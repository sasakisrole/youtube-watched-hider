// Behavioral verification for watched-recording failure recovery.
// Production blocks are extracted verbatim and run with fake Chrome/DOM dependencies.
// Run: node tests/verify_recording_failure_recovery.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const backgroundSource = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start === -1) throw new Error('start marker not found: ' + startMarker);
  const end = source.indexOf(endMarker, start);
  if (end === -1) throw new Error('end marker not found: ' + endMarker);
  return source.slice(start, end);
}

const detectionBlock = sliceBetween(
  backgroundSource,
  'const recentlyRecorded = new Set();',
  '// Clean up recentlyRecorded periodically');
const seekbarHelperBlock = sliceBetween(
  contentSource,
  'function recordSeekbarWatched(',
  '\n  function getCachedWatchedState(');
const processPageBlock = sliceBetween(
  contentSource,
  'async function processPage()',
  '\n  function hideCard(');
const recommendationsBlock = sliceBetween(
  contentSource,
  'async function checkRecommendations()',
  '\n  // Shared selector for related video cards');
const backfillBlock = sliceBetween(
  contentSource,
  'function backfillTitleChannel(',
  '\n  // Record current video as watched');
const contextMenuBlock = sliceBetween(
  backgroundSource,
  '// Context menu click handler',
  '// Handle messages from content script and popup');

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeDetectionHarness(outcomes) {
  let listener = null;
  const calls = [];
  const errors = [];
  const chrome = {
    tabs: {
      onUpdated: { addListener(fn) { listener = fn; } },
      sendMessage(tabId, message) {
        calls.push({ tabId, message });
        const outcome = outcomes.shift();
        return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
      },
    },
  };
  const console = { error(...args) { errors.push(args); } };
  const extractVideoId = (url) => new URL(url).searchParams.get('v');
  const state = new Function('chrome', 'console', 'extractVideoId',
    detectionBlock + '\nreturn { recentlyRecorded, recordingInProgress };')(
      chrome, console, extractVideoId);
  return { listener, calls, errors, ...state };
}

function makeCard() {
  return { style: { display: '' }, dataset: {} };
}

function makeSeekbarHarness(addWatched) {
  const calls = { remembered: [], forgotten: [], toasts: [], errors: [] };
  const deps = {
    hideCard(card, videoId) {
      card.style.display = 'none';
      card.dataset.watchedHidden = 'true';
      card.dataset.watchedVideoId = videoId;
    },
    rememberWatched(videoId) { calls.remembered.push(videoId); },
    forgetWatched(videoId) { calls.forgotten.push(videoId); },
    DBClient: { addWatched },
    showImportToast(n) { calls.toasts.push(n); },
    console: { error(...args) { calls.errors.push(args); } },
  };
  const recordSeekbarWatched = new Function('deps',
    'const { hideCard, rememberWatched, forgetWatched, DBClient, showImportToast, console } = deps;\n'
    + seekbarHelperBlock + '\nreturn recordSeekbarWatched;')(deps);
  return { recordSeekbarWatched, calls };
}

function makeBackfillHarness() {
  const errors = [];
  const deps = {
    Date: { now: () => 100 },
    setTimeout() {},
    watchMetadataMatches: () => true,
    getWatchPageTitle: () => 'title',
    getWatchPageChannel: () => 'channel',
    DBClient: { updateTitleAndChannel: () => Promise.reject(new Error('metadata write failed')) },
    chrome: { runtime: { sendMessage() {} } },
    console: { error(...args) { errors.push(args); } },
  };
  const backfillTitleChannel = new Function('deps',
    'const { Date, setTimeout, watchMetadataMatches, getWatchPageTitle, getWatchPageChannel, DBClient, chrome, console } = deps;\n'
    + backfillBlock + '\nreturn backfillTitleChannel;')(deps);
  return { backfillTitleChannel, errors };
}

function makeContextMenuHarness() {
  let listener = null;
  const errors = [];
  const chrome = {
    contextMenus: { onClicked: { addListener(fn) { listener = fn; } } },
    tabs: { sendMessage: () => Promise.reject(new Error('tab unavailable')) },
  };
  const console = { error(...args) { errors.push(args); } };
  const extractVideoId = (url) => new URL(url).searchParams.get('v');
  new Function('chrome', 'console', 'extractVideoId', contextMenuBlock)(
    chrome, console, extractVideoId);
  return { listener, errors };
}

let passed = 0;
let failed = 0;

async function test(nodeid, body) {
  try {
    await body();
    passed++;
    console.log('  PASS ' + nodeid);
  } catch (error) {
    failed++;
    console.log('  FAIL ' + nodeid + ' (' + error.message + ')');
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function run() {
  await test('REQ-1::failed detection send clears suppression and permits retry', async () => {
    const h = makeDetectionHarness([new Error('no receiver'), { ok: true }]);
    h.listener(7, { url: 'https://www.youtube.com/watch?v=retry-id' }, {});
    await flushPromises();
    assert(!h.recentlyRecorded.has('retry-id'), 'failed ID remained recently recorded');
    assert(!h.recordingInProgress.has('retry-id'), 'failed ID remained in progress');
    h.listener(7, { url: 'https://www.youtube.com/watch?v=retry-id' }, {});
    await flushPromises();
    assert(h.calls.length === 2, 'same video was not retried');
  });

  await test('REQ-2::successful detection send alone commits suppression', async () => {
    const h = makeDetectionHarness([{ ok: true }]);
    h.listener(8, { url: 'https://www.youtube.com/watch?v=success-id' }, {});
    assert(!h.recentlyRecorded.has('success-id'), 'ID committed before send resolved');
    await flushPromises();
    assert(h.recentlyRecorded.has('success-id'), 'successful ID was not committed');
    h.listener(8, { url: 'https://www.youtube.com/watch?v=success-id' }, {});
    await flushPromises();
    assert(h.calls.length === 1, 'successful ID was sent twice');
  });

  for (const [reqId, block, label] of [
    ['REQ-3', processPageBlock, 'processPage'],
    ['REQ-4', recommendationsBlock, 'checkRecommendations'],
  ]) {
    await test(reqId + '::' + label + ' seekbar failure restores card and cache', async () => {
      assert(block.includes('recordSeekbarWatched(card, videoId, title, channel, durationSec);'),
        label + ' does not use the recovery helper');
      const h = makeSeekbarHarness(() => Promise.reject(new Error('DB unavailable')));
      const card = makeCard();
      await h.recordSeekbarWatched(card, 'seekbar-id', 'title', 'channel', 42);
      assert(card.style.display === '', 'card remained hidden');
      assert(card.dataset.watchedHidden === undefined, 'hidden marker remained');
      assert(card.dataset.watchedVideoId === undefined, 'hidden video ID remained');
      assert(h.calls.forgotten.join() === 'seekbar-id', 'watched cache was not cleared');
    });
  }

  await test('REQ-5::detection and seekbar failures are logged', async () => {
    const detection = makeDetectionHarness([new Error('no receiver')]);
    detection.listener(9, { url: 'https://www.youtube.com/watch?v=log-id' }, {});
    await flushPromises();
    const seekbar = makeSeekbarHarness(() => Promise.reject(new Error('DB unavailable')));
    await seekbar.recordSeekbarWatched(makeCard(), 'log-id', '', '', null);
    assert(detection.errors.length === 1, 'detection failure was not logged');
    assert(seekbar.calls.errors.length === 1, 'seekbar failure was not logged');
  });

  await test('REQ-5::metadata update failure is logged', async () => {
    const h = makeBackfillHarness();
    h.backfillTitleChannel('metadata-id');
    await flushPromises();
    assert(h.errors.length === 1, 'metadata update failure was not logged');
  });

  await test('REQ-5::context menu send failure is logged', async () => {
    const h = makeContextMenuHarness();
    h.listener({ menuItemId: 'yt-queue', linkUrl: 'https://www.youtube.com/watch?v=menu-id' }, { id: 10 });
    await flushPromises();
    assert(h.errors.length === 1, 'context menu failure was not logged');
  });

  await test('REQ-6::successful seekbar write keeps prior UI and toast behavior', async () => {
    const h = makeSeekbarHarness(() => Promise.resolve({ isNew: true }));
    const card = makeCard();
    await h.recordSeekbarWatched(card, 'success-id', 'title', 'channel', 42);
    assert(card.style.display === 'none', 'successful card was restored');
    assert(card.dataset.watchedVideoId === 'success-id', 'successful hidden marker changed');
    assert(h.calls.remembered.join() === 'success-id', 'successful cache behavior changed');
    assert(h.calls.forgotten.length === 0, 'successful cache was cleared');
    assert(h.calls.toasts.join() === '1', 'new-record toast behavior changed');
    assert(h.calls.errors.length === 0, 'successful write logged an error');
  });

  console.log('\n' + (passed + failed) + ' collected, ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
