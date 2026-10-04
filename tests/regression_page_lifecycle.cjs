'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.YWH_TEST_ROOT || path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const fn = name => {
  const match = source.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  }`));
  assert.ok(match, name);
  return match[0];
};
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function card(id) {
  return { id, isConnected: true, dataset: {}, style: {},
    querySelector: () => ({ href: 'https://www.youtube.com/watch?v=' + id }),
    remove() { this.isConnected = false; this.removed = true; } };
}
function boot(cards) {
  const pending = deferred(), imports = [];
  const scope = {
    console: { log() {}, error(e) { throw e; }, warn() {} }, URL,
    enabled: true, contextInvalidated: false,
    location: { pathname: '/watch', href: 'https://www.youtube.com/watch?v=current' },
    document: { hidden: false, querySelectorAll: () => cards },
    SELECTORS: { videoLink: 'a', seekbar: 'progress', progressBarNew: 'segment', resumeOverlay: 'resume' },
    ALL_CARD_SELECTORS: 'cards', HISTORY_CARD_SELECTOR: 'history',
    processRunning: false, processQueued: false, recoChecking: false,
    hideShortsCards() {}, hideMovieCards() {}, applyPlaylistCardDisplay() {}, isPlaylistCard: c => c.playlist === true,
    getCurrentVideoId: () => 'current', getCardVideoId: c => c.id,
    getVideoIdFromHref: href => new URL(href).searchParams.get('v'),
    getCachedWatchedState: () => undefined, hasYouTubeSeekbar: () => false,
    lookupWatchedForIds: () => pending.promise,
    rememberWatched() {}, rememberNotWatched() {},
    hideCard(c, id) { c.style.display = 'none'; c.dataset.watchedHidden = 'true'; c.dataset.watchedVideoId = id; },
    DBClient: { contextInvalidated: false, checkMultiple: () => pending.promise,
      importData: async records => { imports.push(...records); } },
    getHistoryVideoLink: c => c.id ? { href: 'https://www.youtube.com/watch?v=' + c.id } : null,
    getHistoryTitle: c => 'Title ' + c.id, getHistoryChannel: () => 'Channel', getHistorySectionDate: () => 1,
    isHistoryCardCompleted: c => c.complete !== false,
    isHistoryPage: () => scope.location.pathname === '/feed/history',
    showImportToast() {},
  };
  vm.createContext(scope);
  const lifecycle = source.match(/  \/\/ Page response lifecycle: begin[^]*?  \/\/ Page response lifecycle: end/);
  vm.runInContext(lifecycle ? lifecycle[0] : 'let pageGeneration = 0, pageNavigating = false, pageDisposed = false;', scope);
  scope.advance = () => vm.runInContext('pageGeneration++', scope);
  vm.runInContext(fn('processPage') + fn('checkRecommendations'), scope);
  const history = source.match(/  const HISTORY_STATE = \{[^]*?(?=  \/\/ ---- History Harvest ----)/)[0];
  // Metadata extraction is exercised separately by the existing history suite.
  const states = history.slice(0, history.indexOf('  function getHistoryTitle('));
  vm.runInContext(states + fn('scrapeHistoryPage'), scope);
  return { scope, pending, imports };
}
for (const entry of ['processPage', 'checkRecommendations']) {
  for (const watched of [true, false]) {
    test(`${entry} ignores ${watched ? 'watched' : 'unwatched'} response after card reuse`, async () => {
      const c = card('aaaaaaaaaaa'), h = boot([c]);
      const work = h.scope[entry](); c.id = 'bbbbbbbbbbb';
      c.querySelector = () => ({ href: 'https://www.youtube.com/watch?v=' + c.id });
      h.pending.resolve({ aaaaaaaaaaa: watched }); await work;
      assert.deepEqual(c.dataset, {});
      assert.equal(c.style.display, undefined);
    });
  }
  for (const change of ['same-url-generation', 'url-before-event', 'detached', 'playlist-reuse']) {
    test(`${entry} ignores response after ${change}`, async () => {
      const c = card('aaaaaaaaaaa'), h = boot([c]);
      const work = h.scope[entry]();
      if (change === 'same-url-generation') h.scope.advance();
      if (change === 'url-before-event') h.scope.location.href += '&new=1';
      if (change === 'detached') c.isConnected = false;
      if (change === 'playlist-reuse') c.playlist = true;
      h.pending.resolve({ aaaaaaaaaaa: true }); await work;
      assert.deepEqual(c.dataset, {});
      assert.equal(h.scope.processRunning, false);
      assert.equal(h.scope.recoChecking, false);
    });
  }
  test(`${entry} still applies a matching response`, async () => {
    const c = card('aaaaaaaaaaa'), h = boot([c]);
    const work = h.scope[entry](); h.pending.resolve({ aaaaaaaaaaa: true }); await work;
    assert.equal(c.dataset.watchedVideoId, 'aaaaaaaaaaa');
  });
}
test('harvest prunes cards completed or exhausted by an earlier non-harvest pass', async () => {
  const cards = [card('aaaaaaaaaaa'), card('bbbbbbbbbbb')], h = boot(cards);
  h.scope.location.pathname = '/feed/history'; h.scope.location.href = 'https://www.youtube.com/feed/history';
  cards[0].dataset.historyState = 'completed'; cards[1].dataset.historyState = 'exhausted';
  for (const c of cards) c.dataset.historyVideoId = c.id;
  await h.scope.scrapeHistoryPage({ removeProcessed: true });
  assert.ok(cards.every(c => c.removed));
});
for (const change of ['reuse', 'navigation', 'detached']) {
  test(`history ignores lookup response after ${change} without importing mixed metadata`, async () => {
    const c = card('aaaaaaaaaaa'), h = boot([c]);
    h.scope.location.pathname = '/feed/history'; h.scope.location.href = 'https://www.youtube.com/feed/history';
    const work = h.scope.scrapeHistoryPage({ removeProcessed: true });
    if (change === 'reuse') c.id = 'bbbbbbbbbbb';
    if (change === 'navigation') h.scope.advance();
    if (change === 'detached') c.isConnected = false;
    h.pending.resolve({}); await work;
    assert.equal(h.imports.length, 0); assert.equal(c.removed, undefined);
    assert.notEqual(c.dataset.historyState, 'completed');
  });
}
test('recycled terminal history cards are examined for their new video', async () => {
  const c = card('bbbbbbbbbbb'), h = boot([c]);
  h.scope.location.pathname = '/feed/history'; h.scope.location.href = 'https://www.youtube.com/feed/history';
  Object.assign(c.dataset, { historyState: 'completed', historyVideoId: 'aaaaaaaaaaa' });
  const work = h.scope.scrapeHistoryPage({ removeProcessed: true });
  h.pending.resolve({}); await work;
  assert.equal(h.imports.length, 1); assert.equal(h.imports[0].videoId, 'bbbbbbbbbbb');
  assert.equal(h.imports[0].title, 'Title bbbbbbbbbbb'); assert.equal(c.removed, true);
});
test('a late import success does not complete or prune a recycled history card', async () => {
  const c = card('aaaaaaaaaaa'), h = boot([c]), imported = deferred();
  h.scope.location.pathname = '/feed/history'; h.scope.location.href = 'https://www.youtube.com/feed/history';
  h.scope.DBClient.importData = async records => { h.imports.push(...records); await imported.promise; };
  const work = h.scope.scrapeHistoryPage({ removeProcessed: true });
  h.pending.resolve({}); await new Promise(done => setImmediate(done));
  c.id = 'bbbbbbbbbbb'; imported.resolve(); await work;
  assert.equal(h.imports[0].videoId, 'aaaaaaaaaaa');
  assert.equal(h.imports[0].title, 'Title aaaaaaaaaaa');
  assert.notEqual(c.dataset.historyState, 'completed'); assert.equal(c.removed, undefined);
});
