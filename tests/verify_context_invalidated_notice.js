// Run: node tests/verify_context_invalidated_notice.js [--control]
// Execute production blocks with fake Chrome/DOM; --control disables only detection.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const control = process.argv.includes('--control');

function sliceBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  assert.notEqual(start, -1, 'start marker not found: ' + startMarker);
  const end = text.indexOf(endMarker, start);
  assert.notEqual(end, -1, 'end marker not found: ' + endMarker);
  return text.slice(start, end);
}
const block = (start, end) => sliceBetween(source, start, end);
let lifecycle = block('  // Extension context lifecycle', '  // End extension context lifecycle.');
if (control) {
  const predicate = /const invalidated = [^\r\n]+;/;
  assert.equal((lifecycle.match(/const invalidated = /g) || []).length, 1);
  lifecycle = lifecycle.replace(predicate, 'const invalidated = false;');
}
const rpc = block('  function dbRpc(', '  function trimRecentLookup(');
const scrape = block('  async function scrapeHistoryPage(', '  // ---- History Harvest ----');
const historyState = block('  const HISTORY_STATE = {', '  // UNKNOWN/PARTIAL/FAILED');
const seekbar = block('  function recordSeekbarWatched(', '  function getCachedWatchedState(');
const recording = block('  async function recordCurrentVideo(', '  // Attach ended listener');
const backfill = block('  function backfillTitleChannel(', '  // Record current video as watched');
const harvestBlock = block('  function removeHarvestUI()', '  function isHistoryPage()');
const cleanupBlock = block('  function cleanup(', '  return { cleanup };');

function element(tag) {
  return {
    tag, id: '', dataset: {}, style: {}, children: [], listeners: {},
    setAttribute(name, value) { this[name] = value; },
    appendChild(child) { child.parent = this; this.children.push(child); return child; },
    addEventListener(name, fn) { this.listeners[name] = fn; },
    click() { this.listeners.click(); },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); },
  };
}

function makeHarness(mode = 'throw', failOp = null) {
  const calls = { sends: [], errors: [], warns: [], reloads: 0, disconnected: 0, clearedIntervals: 0, scrolls: 0 };
  const body = element('body');
  const cards = [element('card')];
  const timers = new Map();
  let nextTimer = 0;
  const document = {
    body, documentElement: body, createElement: element,
    getElementById: id => body.children.find(c => c.id === id),
    querySelectorAll: () => cards,
    removeEventListener() {},
  };
  const error = new Error(mode === 'ordinary' ? 'DB unavailable' : 'Extension context invalidated');
  const runtime = {
    id: 'fake-extension', lastError: null, onMessage: { removeListener() {} },
    sendMessage(message, callback) {
      calls.sends.push(message);
      if (failOp && message.op !== failOp) return callback({ success: true, result: {} });
      if (mode === 'pending') { calls.pending.push(callback); return; }
      if (mode === 'callback') {
        runtime.lastError = error;
        try { callback(); } finally { runtime.lastError = null; }
        return;
      }
      if (mode === 'response') return callback({ success: false, error: error.message });
      if (mode === 'success') return callback({ success: true, result: {} });
      throw error;
    },
  };
  calls.pending = [];
  if (mode === 'missing-id') delete runtime.id;
  const observer = { disconnect() { calls.disconnected++; } };
  const deps = {
    chrome: { runtime }, document,
    location: { pathname: '/feed/history', reload() { calls.reloads++; } },
    console: { log() {}, info() {}, error(...args) { calls.errors.push(args); }, warn(...args) { calls.warns.push(args); } },
    window: {
      setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; },
      clearTimeout(id) { timers.delete(id); },
      scrollTo() { calls.scrolls++; },
    },
    clearInterval() { calls.clearedIntervals++; },
    observer,
    HISTORY_CARD_SELECTOR: 'card',
    getHistoryVideoLink: () => ({ href: 'https://www.youtube.com/watch?v=video' }),
    getVideoIdFromHref: () => 'video', isHistoryCardCompleted: () => true,
    getHistoryTitle: () => 'title', getHistoryChannel: () => 'channel', getHistorySectionDate: () => 1,
    computeHistoryRetryOutcome: () => ({ retries: 1, exhausted: false }),
    rememberWatched() {}, forgetWatched() {}, showImportToast() {},
    hideCard(card, videoId) { card.style.display = 'none'; card.dataset.watchedHidden = 'true'; card.dataset.watchedVideoId = videoId; },
    getCurrentVideoId: () => 'video', watchMetadataMatches: () => true,
    getWatchPageTitle: () => 'title', getWatchPageChannel: () => 'channel',
    getCurrentVideoDurationSec: () => 30, getCurrentVideoCategory: () => '',
    removeHarvestStyle() {}, renderHarvestStatus() {}, injectHarvestStyle() {}, isHistoryPage: () => true,
    onNavigateFinish() {}, onMessage() {},
  };
  const context = vm.createContext(deps);
  vm.runInContext(`
    let enabled = true, recordWhileOff = false, processQueued = true;
    let queueAbort = false, watchLaterAbort = false, recoInterval = 7;
    let currentVideoElement = null, endedHandler = null;
    let queueBtnObserver = observer, watchLaterBtnObserver = observer;
    let queueAllBtn = null, watchLaterBtn = null, bulkButtonBar = null;
    const toastState = { el: null };
    const harvest = { running: true, timer: null, ui: null, added: 0, scanned: 0 };
    ${lifecycle}\n${rpc}\n${historyState}\n${scrape}\n${seekbar}\n${recording}\n${backfill}\n${harvestBlock}\n${cleanupBlock}
    contextReady = true;
    globalThis.api = { detectContextInvalidation, sendRuntimeMessage, DBClient, scrapeHistoryPage,
      recordSeekbarWatched, recordCurrentVideo, backfillTitleChannel, HISTORY_STATE, harvest,
      harvestTick, startHarvest, setTimeout, startContextHeartbeat, cleanup };
  `, context);
  return { ...context.api, calls, body, cards, runtime, timers, context };
}

let passed = 0, failed = 0;
async function test(id, fn) {
  try { await fn(); passed++; console.log('PASS ' + id); }
  catch (e) { failed++; console.log('FAIL ' + id + ': ' + e.message); }
}

async function run() {
  await test('REQ-1::invalidation warns once without errors', async () => {
    for (const mode of ['throw', 'callback', 'response', 'missing-id']) {
      const h = makeHarness(mode);
      await h.scrapeHistoryPage();
      await h.recordCurrentVideo();
      await h.recordSeekbarWatched(h.cards[0], 'video', '', '', 30);
      assert.equal(h.calls.errors.length, 0, mode + ': console.error was called');
      assert.equal(h.calls.warns.length, 1, mode + ': expected exactly one console.warn');
    }
  });
  await test('REQ-2::one notice with reload and close buttons', async () => {
    const h = makeHarness();
    await h.scrapeHistoryPage();
    h.detectContextInvalidation(new Error('Extension context invalidated'));
    assert.equal(h.body.children.length, 1, 'expected one reload notice');
    const notice = h.body.children[0];
    assert.equal(notice.children[0].textContent, 'YT-Watched-Hider が更新されました。このページを再読み込みしてください');
    assert.match(notice.style.cssText, /position:fixed/);
    notice.children.find(c => c.textContent === '再読み込み').click();
    assert.equal(h.calls.reloads, 1);
    notice.children.find(c => c.textContent === '閉じる').click();
    h.detectContextInvalidation(new Error('Extension context invalidated'));
    assert.equal(h.body.children.length, 0, 'dismissed notice reappeared');
  });
  await test('REQ-3::no new sends after invalidation', async () => {
    const h = makeHarness();
    await h.scrapeHistoryPage();
    const before = h.calls.sends.length;
    await h.DBClient.checkMultiple(['video']).catch(() => {});
    h.sendRuntimeMessage({ type: 'FIX_CHANNELS' }, () => {});
    await h.scrapeHistoryPage();
    assert.equal(h.calls.sends.length, before, 'sendMessage count increased after invalidation');
  });
  await test('REQ-4::invalidated check and import never mark FAILED', async () => {
    for (const op of ['DB_CHECK_MULTIPLE', 'IMPORT_DATA']) {
      const h = makeHarness('throw', op);
      await h.scrapeHistoryPage({ removeProcessed: true });
      assert.notEqual(h.cards[0].dataset.historyState, h.HISTORY_STATE.FAILED, op + ': card was marked FAILED');
      assert.equal(h.cards[0].dataset.historyRetries, undefined, op + ': retry budget changed');
    }
  });

  await test('REQ-5::idle page notices the reload without sending anything', async () => {
    const h = makeHarness('success');
    const fireTimers = () => {
      for (const [id, fn] of [...h.timers]) { h.timers.delete(id); fn(); }
    };
    h.startContextHeartbeat();
    fireTimers();
    assert.equal(h.body.children.length, 0, 'notice appeared while the context was alive');
    assert.notEqual(h.timers.size, 0, 'heartbeat stopped rescheduling itself');
    delete h.runtime.id;
    fireTimers();
    assert.equal(h.body.children.length, 1, 'idle page never showed the notice');
    assert.equal(h.calls.warns.length, 1, 'expected exactly one console.warn');
    assert.equal(h.calls.errors.length, 0, 'console.error was called');
    assert.equal(h.calls.sends.length, 0, 'heartbeat sent a runtime message');
    fireTimers();
    assert.equal(h.timers.size, 0, 'heartbeat kept running after invalidation');
  });

  if (!control) {
    await test('REQ-1::recording and metadata paths can each detect invalidation first', async () => {
      for (const operation of ['seekbar', 'recording', 'metadata']) {
        const h = makeHarness();
        if (operation === 'seekbar') await h.recordSeekbarWatched(h.cards[0], 'video', '', '', 30);
        if (operation === 'recording') await h.recordCurrentVideo();
        if (operation === 'metadata') h.backfillTitleChannel('video');
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(h.calls.errors.length, 0, operation);
        assert.equal(h.calls.warns.length, 1, operation);
      }
    });
    await test('REQ-1::full script handles a missing runtime during initialization', async () => {
      const h = makeHarness();
      delete h.context.chrome.runtime;
      Object.assign(h.context.document, { querySelector: () => null, querySelectorAll: () => [], addEventListener() {} });
      Object.assign(h.context, {
        performance: { now: () => 0 },
        MutationObserver: class { observe() {} disconnect() {} },
      });
      vm.runInContext(source, h.context);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(h.calls.errors.length, 0);
      assert.equal(h.calls.warns.length, 1);
      assert.equal(h.calls.sends.length, 0);
      assert.equal(h.body.children.length, 1);
      assert.equal(h.timers.size, 0);
    });
    await test('REQ-1::concurrent pending responses remain silent', async () => {
      const h = makeHarness('pending');
      const work = [h.scrapeHistoryPage(), h.recordCurrentVideo(), h.recordSeekbarWatched(h.cards[0], 'video', '', '', 30)];
      h.runtime.lastError = new Error('Extension context invalidated');
      h.calls.pending[0]();
      h.runtime.lastError = null;
      for (const cb of h.calls.pending.slice(1)) cb({ success: true, result: { isNew: true } });
      await Promise.all(work);
      assert.equal(h.calls.warns.length, 1);
      assert.equal(h.calls.errors.length, 0);
      assert.equal(h.cards[0].style.display, '');
    });
    await test('REQ-3::observers timers and harvest are stopped', async () => {
      const h = makeHarness();
      h.setTimeout(() => assert.fail('cancelled timer ran'), 100);
      const tick = h.harvestTick(); // paused at its render-settle timer
      assert.equal(h.calls.scrolls, 1);
      await h.scrapeHistoryPage();
      assert.equal(h.timers.size, 0);
      assert.equal(h.calls.disconnected, 3);
      assert.equal(h.calls.clearedIntervals, 1);
      assert.equal(h.harvest.running, false);
      h.startHarvest();
      await h.harvestTick();
      h.setTimeout(() => {}, 100);
      assert.equal(h.timers.size, 0);
      assert.equal(h.calls.scrolls, 1);
      void tick; // cancelled timer deliberately cannot resume the old loop
    });
    await test('REQ-4::ordinary check and import failures retain FAILED and error log', async () => {
      for (const op of ['DB_CHECK_MULTIPLE', 'IMPORT_DATA']) {
        const h = makeHarness('ordinary', op);
        await h.scrapeHistoryPage();
        assert.equal(h.cards[0].dataset.historyState, h.HISTORY_STATE.FAILED);
        assert.equal(h.calls.errors.length, 1);
        assert.equal(h.calls.warns.length, 0);
        assert.equal(h.body.children.length, 0);
        await h.scrapeHistoryPage();
        assert.ok(h.calls.sends.length >= 2);
      }
    });
    await test('REQ-3::every production runtime send uses the guarded boundary', () => {
      assert.equal((source.match(/chrome\.runtime\.sendMessage\(/g) || []).length, 1);
      assert.match(lifecycle, /chrome\.runtime\.sendMessage\(/);
    });
    await test('REQ-3::polling cannot restart when its first check detects invalidation', () => {
      const h = makeHarness();
      let intervals = 0;
      Object.assign(h.context, {
        checkRecommendations: () => h.detectContextInvalidation(new Error('Extension context invalidated')),
        ensureQueueAllButton() {}, ensureWatchLaterButton() {},
        setInterval() { intervals++; },
      });
      vm.runInContext(block('  function startRecoPolling()', '  function stopRecoPolling()') + '\nstartRecoPolling();', h.context);
      assert.equal(intervals, 0);
    });
    await test('background::expected disconnects share one warning; other failures stay errors', async () => {
      const warnings = [], errors = [];
      const listeners = {};
      let outcome;
      const chrome = {
        tabs: { onUpdated: { addListener(fn) { listeners.updated = fn; } }, sendMessage: () => Promise.reject(new Error(outcome)) },
        contextMenus: { onClicked: { addListener(fn) { listeners.menu = fn; } } },
      };
      const ctx = vm.createContext({ chrome, console: { warn: (...a) => warnings.push(a), error: (...a) => errors.push(a) }, extractVideoId: () => 'video' });
      vm.runInContext(sliceBetween(background, 'const recentlyRecorded = new Set();', '// Clean up recentlyRecorded periodically')
        + sliceBetween(background, '// Context menu click handler', '// Handle messages from content script and popup'), ctx);
      for (outcome of ['Could not establish connection. Receiving end does not exist.', 'Extension context invalidated']) {
        listeners.updated(1, { url: 'watch' }, {});
        listeners.menu({ menuItemId: 'yt-queue', linkUrl: 'watch' }, { id: 1 });
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.equal(warnings.length, 1);
      assert.equal(errors.length, 0);
      outcome = 'unexpected failure';
      listeners.updated(1, { url: 'watch' }, {});
      listeners.menu({ menuItemId: 'yt-queue', linkUrl: 'watch' }, { id: 1 });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(errors.length, 2);
    });
  }
  console.log(`${passed} passed, ${failed} failed${control ? ' (detection disabled control)' : ''}`);
  process.exitCode = failed ? 1 : 0;
}
run().catch(e => { console.error(e); process.exitCode = 1; });
