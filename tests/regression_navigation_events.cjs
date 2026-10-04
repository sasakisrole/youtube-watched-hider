'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.YWH_TEST_ROOT || path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const fn = name => source.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  }`))?.[0] || '';
function boot() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  const card = { isConnected: true, dataset: {}, style: {}, id: 'aaaaaaaaaaa',
    querySelector: () => ({ href: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' }) };
  const scope = { URL, console: { log() {}, warn() {}, error(error) { throw error; } },
    DBClient: { contextInvalidated: false }, contextInvalidated: false, enabled: true,
    location: { pathname: '/watch', href: 'https://www.youtube.com/watch?v=current' },
    document: { hidden: false, querySelectorAll: () => [card] },
    ALL_CARD_SELECTORS: 'cards', SELECTORS: { videoLink: 'a' },
    processRunning: false, processQueued: false, recoChecking: false,
    isPlaylistCard: () => false, getCurrentVideoId: () => 'current', getCardVideoId: c => c.id,
    getVideoIdFromHref: href => new URL(href).searchParams.get('v'),
    hasYouTubeSeekbar: () => false, getCachedWatchedState: () => undefined,
    lookupWatchedForIds: () => promise, rememberWatched() {}, rememberNotWatched() {},
    hideCard(c, id) { c.dataset.watchedVideoId = id; c.style.display = 'none'; },
    harvest: { running: false }, harvestMode: false, resetPlaylistAllWatched() {}, stopHarvest() {},
    ensureQueueAllButton() {}, ensureWatchLaterButton() {}, showAllShorts() {}, showAllMovies() {},
    hideShortsCards() {}, hideMovieCards() {}, attachVideoEndedListener() {}, startRecoPolling() {}, stopRecoPolling() {},
    isHistoryPage: () => false, removeHarvestUI() {}, setTimeout() {},
    queueRunGeneration: 0, watchLaterRunGeneration: 0, queueAbort: false, watchLaterAbort: false,
    queueInProgress: false, watchLaterInProgress: false,
  };
  vm.createContext(scope);
  const lifecycle = source.match(/  \/\/ Page response lifecycle: begin[^]*?  \/\/ Page response lifecycle: end/);
  if (lifecycle) vm.runInContext(lifecycle[0], scope);
  vm.runInContext(fn('cancelBulkOperations') + fn('onNavigateStart') + fn('onNavigateFinish') + fn('processPage') + fn('checkRecommendations'), scope);
  return { scope, card, resolve };
}
for (const operation of ['processPage', 'checkRecommendations']) {
  for (const event of ['start', 'finish-same-url']) {
    test(`${operation} rejects pending results after the production navigation ${event} handler`, async () => {
      const h = boot(); const running = h.scope[operation]();
      if (event === 'start') h.scope.onNavigateStart?.();
      else h.scope.onNavigateFinish();
      h.resolve({ aaaaaaaaaaa: true }); await running;
      assert.equal(h.card.dataset.watchedVideoId, undefined);
      assert.equal(h.card.style.display, undefined);
      assert.equal(h.scope.processRunning, false);
      assert.equal(h.scope.recoChecking, false);
    });
  }
}
