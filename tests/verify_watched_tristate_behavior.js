// Behavioral verification for content.js §8.2 / §8.4 / §8.5.
// Production functions are extracted verbatim and run with fake dependencies.
// No real network, Chrome API, or browser DOM is used.
// Run: node tests/verify_watched_tristate_behavior.js
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

function sliceBetween(startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error('start marker not found: ' + startMarker);
  const end = src.indexOf(endMarker, start);
  if (end === -1) throw new Error('end marker not found: ' + endMarker);
  return src.slice(start, end);
}

const proxyFetchBlock = sliceBetween(
  'const PROXY_FETCH_TIMEOUT_MS', '\n  chrome.runtime.onMessage.addListener(onMessage);');
const recordCurrentVideoBlock = sliceBetween(
  'async function recordCurrentVideo(boundVideoId)', '\n  // Attach ended listener');
const attachVideoEndedListenerBlock = sliceBetween(
  'let videoRetryCount = 0;', '\n  // Find the card element');
const historyBlock = sliceBetween(
  'const HISTORY_STATE = {', '\n  // ---- History Harvest ----');

function makeProxyFetchModule(deps) {
  // eslint-disable-next-line no-eval
  return eval('(function(deps) {\n' +
    'const { fetch, AbortController, setTimeout, clearTimeout, computeSapisidHash } = deps;\n' +
    proxyFetchBlock + '\nreturn { onMessage, PROXY_FETCH_TIMEOUT_MS };\n})')(deps);
}

function makeVideoEndedModule(deps) {
  // eslint-disable-next-line no-eval
  return eval('(function(deps) {\n' +
    'let enabled = true, recordWhileOff = false, currentVideoElement = null, endedHandler = null;\n' +
    'const { document, setTimeout, getCurrentVideoId, watchMetadataMatches, getWatchPageTitle,\n' +
    ' getWatchPageChannel, getCurrentVideoDurationSec, getCurrentVideoCategory, DBClient,\n' +
    ' rememberWatched, backfillTitleChannel, console } = deps;\n' +
    recordCurrentVideoBlock + '\n' + attachVideoEndedListenerBlock +
    '\nreturn { attachVideoEndedListener, recordCurrentVideo };\n})')(deps);
}

function makeHistoryModule(deps) {
  // eslint-disable-next-line no-eval
  return eval('(function(deps) {\n' +
    'const { document, DBClient, SELECTORS, WATCHED_THRESHOLD, HISTORY_CARD_SELECTOR,\n' +
    ' getVideoIdFromHref, getTitleFromCard, getChannelFromCard, rememberWatched,\n' +
    ' showImportToast, console } = deps;\n' + historyBlock +
    '\nreturn { HISTORY_STATE, HISTORY_RETRY_LIMIT, scrapeHistoryPage };\n})')(deps);
}

class ManualClock {
  constructor() {
    this.now = 0;
    this.nextId = 1;
    this.timers = new Map();
    this.clearCalls = 0;
  }
  setTimeout(fn, delay) {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + delay, fn });
    return id;
  }
  clearTimeout(id) {
    this.clearCalls++;
    this.timers.delete(id);
  }
  advanceBy(ms) {
    this.now += ms;
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.at <= this.now)
      .sort((a, b) => a[1].at - b[1].at);
    for (const [id, timer] of due) {
      if (this.timers.delete(id)) timer.fn();
    }
  }
  get pendingCount() { return this.timers.size; }
}

const fetchMessages = {
  FETCH_WATCH_HTML: { type: 'FETCH_WATCH_HTML', videoId: 'video-id' },
  FETCH_PLAYLIST_HTML: { type: 'FETCH_PLAYLIST_HTML', listId: 'LL', authUser: '0' },
  FETCH_INNERTUBE_BROWSE: { type: 'FETCH_INNERTUBE_BROWSE', authUser: '0', body: {} },
};

async function exerciseFetchHandler(type, mode) {
  const clock = new ManualClock();
  let abortCalls = 0;
  class TrackingAbortController {
    constructor() {
      this.delegate = new globalThis.AbortController();
      this.signal = this.delegate.signal;
    }
    abort() {
      abortCalls++;
      this.delegate.abort();
    }
  }
  const fakeFetch = (_url, options) => {
    if (mode === 'timeout') {
      return new Promise((_resolve, reject) => {
        if (options.signal.aborted) {
          const error = new Error('manual-clock abort');
          error.name = 'AbortError';
          reject(error);
          return;
        }
        options.signal.addEventListener('abort', () => {
          const error = new Error('manual-clock abort');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    }
    if (mode === 'error') return Promise.reject(new Error('synthetic network failure'));
    return Promise.resolve({
      ok: true,
      status: 200,
      url: 'https://www.youtube.com/final',
      text: async () => '<html>ok</html>',
      json: async () => ({ ok: true }),
    });
  };
  const mod = makeProxyFetchModule({
    fetch: fakeFetch,
    AbortController: TrackingAbortController,
    setTimeout: clock.setTimeout.bind(clock),
    clearTimeout: clock.clearTimeout.bind(clock),
    computeSapisidHash: async () => '',
  });
  let listenerReturn;
  const responsePromise = new Promise((resolve) => {
    listenerReturn = mod.onMessage(fetchMessages[type], {}, resolve);
  });
  if (mode === 'timeout') clock.advanceBy(mod.PROXY_FETCH_TIMEOUT_MS);
  const response = await responsePromise;
  return { response, listenerReturn, abortCalls, clock };
}

class FakeVideo {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }
  fire(type) {
    const listener = this.listeners.get(type);
    if (listener) listener();
  }
}

function makeVideoHarness() {
  const video = new FakeVideo();
  const recordedIds = [];
  let currentVideoId = 'attach-time-id';
  const mod = makeVideoEndedModule({
    document: { querySelector: (selector) => selector === 'video' ? video : null },
    setTimeout: () => 1,
    getCurrentVideoId: () => currentVideoId,
    watchMetadataMatches: () => false,
    getWatchPageTitle: () => '',
    getWatchPageChannel: () => '',
    getCurrentVideoDurationSec: () => null,
    getCurrentVideoCategory: () => '',
    DBClient: { addWatched: async (videoId) => { recordedIds.push(videoId); } },
    rememberWatched() {},
    backfillTitleChannel() {},
    console: { log() {}, error() {} },
  });
  return {
    mod,
    video,
    recordedIds,
    setCurrentVideoId(videoId) { currentVideoId = videoId; },
  };
}

const HISTORY_SELECTORS = {
  resumeOverlay: '__resume_overlay__',
  seekbar: '__seekbar__',
  progressBarNew: '__progress_bar_new__',
};

class FakeHistoryCard {
  constructor(name, options = {}) {
    this.name = name;
    this.dataset = { ...(options.dataset || {}) };
    this.href = options.href || null;
    this.progressWidth = options.progressWidth == null ? null : options.progressWidth;
    this.removed = false;
    this.linkQueries = 0;
  }
  querySelector(selector) {
    if (selector.includes('a[href*="watch"]')) {
      this.linkQueries++;
      return this.href ? { href: this.href } : null;
    }
    if (selector === HISTORY_SELECTORS.resumeOverlay) return null;
    if (selector === HISTORY_SELECTORS.seekbar) return null;
    if (selector === HISTORY_SELECTORS.progressBarNew) {
      return this.progressWidth == null
        ? null : { style: { width: String(this.progressWidth) + '%' } };
    }
    if (selector.includes('video-title')) return { textContent: this.name + ' title' };
    if (selector.includes('metadata-text') || selector.includes('ytd-channel-name')) {
      return { textContent: this.name + ' channel' };
    }
    return null;
  }
  closest() { return null; }
  remove() { this.removed = true; }
}

function videoHref(videoId) {
  return 'https://www.youtube.com/watch?v=' + encodeURIComponent(videoId);
}

function makeHistoryHarness(cards, overrides = {}) {
  const calls = { check: 0, import: 0, remembered: [] };
  const DBClient = {
    checkMultiple: async (videoIds) => {
      calls.check++;
      return overrides.checkMultiple ? overrides.checkMultiple(videoIds) : {};
    },
    importData: async (records) => {
      calls.import++;
      if (overrides.importData) return overrides.importData(records);
    },
  };
  const mod = makeHistoryModule({
    document: { querySelectorAll: () => cards.filter((card) => !card.removed) },
    DBClient,
    SELECTORS: HISTORY_SELECTORS,
    WATCHED_THRESHOLD: 95,
    HISTORY_CARD_SELECTOR: '__history_cards__',
    getVideoIdFromHref: (href) => new URL(href).searchParams.get('v'),
    getTitleFromCard: (card) => card.name + ' fallback title',
    getChannelFromCard: (card) => card.name + ' fallback channel',
    rememberWatched: (videoId) => calls.remembered.push(videoId),
    showImportToast() {},
    console: { log() {}, error() {} },
  });
  return { mod, calls };
}

let pass = 0;
let fail = 0;
function check(name, condition) {
  if (condition) {
    pass++;
    console.log('  PASS ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name);
  }
}
async function runCase(name, body) {
  try {
    check(name, await body());
  } catch (error) {
    fail++;
    console.log('  FAIL ' + name + ' (' + error.message + ')');
  }
}

async function run() {
  console.log('§8.2 proxied fetch timeout/abort — real extracted onMessage handlers');
  for (const type of Object.keys(fetchMessages)) {
    await runCase('behavior: ' + type + ' timeout aborts and responds reason=timeout', async () => {
      const result = await exerciseFetchHandler(type, 'timeout');
      return result.listenerReturn === true && result.abortCalls === 1
        && result.response.reason === 'timeout';
    });
  }
  for (const type of Object.keys(fetchMessages)) {
    await runCase('behavior: ' + type + ' non-AbortError responds reason=fetch-error', async () => {
      const result = await exerciseFetchHandler(type, 'error');
      return result.listenerReturn === true && result.abortCalls === 0
        && result.response.reason === 'fetch-error';
    });
  }
  for (const type of Object.keys(fetchMessages)) {
    await runCase('behavior: ' + type + ' success clears its timeout with zero timers remaining', async () => {
      const result = await exerciseFetchHandler(type, 'success');
      return result.response.success === true && result.clock.clearCalls === 1
        && result.clock.pendingCount === 0;
    });
  }

  console.log('\n§8.4 ended-listener videoId binding — real extracted functions');
  await runCase('behavior: attachVideoEndedListener records the attach-time videoId after SPA navigation', async () => {
    const harness = makeVideoHarness();
    harness.mod.attachVideoEndedListener();
    harness.setCurrentVideoId('spa-next-id');
    harness.video.fire('ended');
    await Promise.resolve();
    return harness.recordedIds.length === 1 && harness.recordedIds[0] === 'attach-time-id';
  });
  await runCase('behavior: recordCurrentVideo without boundVideoId falls back to getCurrentVideoId()', async () => {
    const harness = makeVideoHarness();
    harness.setCurrentVideoId('fallback-current-id');
    await harness.mod.recordCurrentVideo();
    return harness.recordedIds.length === 1 && harness.recordedIds[0] === 'fallback-current-id';
  });

  console.log('\n§8.5 history-card state machine and pruning — real extracted scraper with fake DOM');
  await runCase('behavior: videoId-less card stays UNKNOWN and is retried on the next scrape pass', async () => {
    const card = new FakeHistoryCard('late-link');
    const { mod } = makeHistoryHarness([card]);
    await mod.scrapeHistoryPage();
    const firstPassUnknown = card.dataset.historyState === mod.HISTORY_STATE.UNKNOWN
      && card.dataset.historyRetries === '1' && card.linkQueries === 1 && !card.removed;
    card.href = videoHref('late-link-id');
    card.progressWidth = 25;
    await mod.scrapeHistoryPage();
    return firstPassUnknown && card.linkQueries === 2
      && card.dataset.historyState === mod.HISTORY_STATE.PARTIAL && !card.removed;
  });

  await runCase('behavior: retry limit transitions an unresolved card to EXHAUSTED, never COMPLETED', async () => {
    const card = new FakeHistoryCard('never-resolves');
    const { mod } = makeHistoryHarness([card]);
    for (let i = 0; i < mod.HISTORY_RETRY_LIMIT; i++) await mod.scrapeHistoryPage();
    return card.dataset.historyState === mod.HISTORY_STATE.EXHAUSTED
      && card.dataset.historyState !== mod.HISTORY_STATE.COMPLETED
      && card.dataset.historyRetries === undefined && !card.removed;
  });

  await runCase('behavior: harvest pruning removes only newly COMPLETED/EXHAUSTED cards and retains UNKNOWN/PARTIAL/FAILED', async () => {
    const completed = new FakeHistoryCard('completed',
      { href: videoHref('completed-id'), progressWidth: 100 });
    const exhausted = new FakeHistoryCard('exhausted');
    const unknown = new FakeHistoryCard('unknown');
    const partial = new FakeHistoryCard('partial',
      { href: videoHref('partial-id'), progressWidth: 25 });
    const failed = new FakeHistoryCard('failed',
      { href: videoHref('failed-id'), progressWidth: 100 });
    const cards = [completed, exhausted, unknown, partial, failed];
    const { mod } = makeHistoryHarness(cards, {
      checkMultiple: () => ({ 'completed-id': true, 'failed-id': false }),
      importData: async () => { throw new Error('synthetic import failure'); },
    });
    exhausted.dataset.historyRetries = String(mod.HISTORY_RETRY_LIMIT - 1);
    await mod.scrapeHistoryPage({ removeProcessed: true });
    return completed.removed && exhausted.removed
      && !unknown.removed && !partial.removed && !failed.removed
      && completed.dataset.historyState === mod.HISTORY_STATE.COMPLETED
      && exhausted.dataset.historyState === mod.HISTORY_STATE.EXHAUSTED
      && unknown.dataset.historyState === mod.HISTORY_STATE.UNKNOWN
      && partial.dataset.historyState === mod.HISTORY_STATE.PARTIAL
      && failed.dataset.historyState === mod.HISTORY_STATE.FAILED;
  });

  await runCase('behavior: EXHAUSTED is terminal bookkeeping and never enters a watched/import path', async () => {
    const card = new FakeHistoryCard('exhausted-not-watched');
    const { mod, calls } = makeHistoryHarness([card]);
    for (let i = 0; i < mod.HISTORY_RETRY_LIMIT; i++) await mod.scrapeHistoryPage();
    card.href = videoHref('must-not-be-recorded');
    card.progressWidth = 100;
    await mod.scrapeHistoryPage();
    return card.dataset.historyState === mod.HISTORY_STATE.EXHAUSTED
      && calls.check === 0 && calls.import === 0 && calls.remembered.length === 0;
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
}

run().catch((error) => {
  console.error('harness error:', error);
  process.exitCode = 1;
});
