// Extract production settings and card operations; no browser or dependencies required.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = file => fs.readFileSync(path.join(process.env.YWH_TEST_ROOT || path.join(__dirname, '..'), file), 'utf8');
const source = read('content.js');
function block(a, b) {
  const start = source.indexOf(a), end = source.indexOf(b, start);
  assert(start >= 0 && end > start, a);
  return source.slice(start, end);
}
function fn(name) {
  const match = source.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  }`));
  assert(match, name);
  return match[0];
}
function card(id = 'seen') {
  return { id, dataset: {}, style: { display: '' }, offsetParent: {},
    querySelector: sel => sel.includes('/watch?v=') ? { href: `https://www.youtube.com/watch?v=${id}` } : null };
}
function boot(cards = [card()]) {
  const scope = { location: { pathname: '/' }, enabled: true, calls: 0,
    document: { querySelectorAll: selector => cards.filter(c =>
      selector === 'cards' || selector.split(',').some(s => {
        const m = s.match(/\[data-([\w-]+)(?:="([^"]+)")?\]/);
        if (!m) return false;
        const key = m[1].replace(/-([a-z])/g, (_, x) => x.toUpperCase());
        return m[2] ? c.dataset[key] === m[2] : key in c.dataset;
      })) },
    ALL_CARD_SELECTORS: 'cards', RELATED_CARD_SELECTORS: 'cards',
    SHORTS_SELECTORS: { reelShelf: 'shelf', richShelf: 'shelf' }, hideShorts: true, hideMovies: true,
    isCardShorts: c => !!c.short, isCardMovie: c => !!c.movie,
    processPage() { scope.calls++; }, stopRecoPolling() {}, startRecoPolling() {},
    isPlaylistCard: () => false, hasLiveBadge: () => false,
    getVideoIdFromHref: href => new URL(href).searchParams.get('v'), getCurrentVideoId: () => 'playing',
    console: { error() {} }, DBClient: { addWatched: () => Promise.reject(new Error('offline')) },
    rememberWatched() {}, forgetWatched() {}, showImportToast() {},
  };
  vm.createContext(scope);
  vm.runInContext(block('  // Watched display settings', '  let recordWhileOff') +
    ['hideCard', 'showAllCards', 'showCardsForVideoIds', 'hideShortsCards', 'hideMovieCards',
      'showAllShorts', 'showAllMovies', 'isChannelBulkActionCard', 'findQueueableCards',
      'findWatchLaterableCards', 'recordSeekbarWatched'].map(fn).join('\n') +
    '\nfunction receive(message) {\n' + block("    if (message.type === 'ENABLED_CHANGED')",
      "    if (message.type === 'RECORD_WHILE_OFF_CHANGED')") + '\n}', scope);
  return scope;
}
let passed = 0, failed = 0;
async function test(name, run) {
  try { await run(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message); }
}
(async () => {
  await test('REQ-1 strict saved-value validation', () => {
    const s = boot();
    for (const value of [undefined, null, false, 'true', 1, {}, []]) {
      s.applyWatchedDisplaySettings({ dimWatched: value });
      assert.equal(vm.runInContext('watchedDisplaySettings.dimWatched', s), false);
    }
    s.applyWatchedDisplaySettings({ dimWatched: true });
    assert.equal(vm.runInContext('watchedDisplaySettings.dimWatched', s), true);
  });
  await test('REQ-2 dim and hover CSS, default hiding, category priority', () => {
    const c = card(), s = boot([c]);
    s.hideCard(c, c.id); assert.equal(c.style.display, 'none');
    s.receive({ type: 'WATCHED_DISPLAY_SETTINGS_CHANGED', settings: { dimWatched: true } });
    s.hideCard(c, c.id);
    assert.equal(c.style.display, ''); assert.equal(c.dataset.watchedDimmed, 'true');
    assert.equal(c.dataset.watchedHidden, undefined);
    const manifest = JSON.parse(read('manifest.json'));
    assert(manifest.content_scripts[0].css.includes('content.css'));
    const css = read('content.css');
    assert.match(css, /\[data-watched-dimmed="true"\]\s*\{[^}]*opacity:\s*0\.35/);
    assert.match(css, /\[data-watched-dimmed="true"\]:hover\s*\{[^}]*opacity:\s*1/);
    c.short = true; s.hideShortsCards(); s.hideCard(c, c.id);
    assert.equal(c.style.display, 'none');
    c.short = false; s.showAllShorts(); c.movie = true; s.hideMovieCards(); s.hideCard(c, c.id);
    assert.equal(c.style.display, 'none');
    s.showAllCards(); assert.equal(c.style.display, 'none', 'watched reset preserves movie hiding');
  });
  await test('REQ-3 page opt-outs restore normal cards', () => {
    const c = card(), s = boot([c]);
    for (const [pathname, key] of [['/', 'hideOnHome'], ['/feed/subscriptions', 'hideOnSubscriptions'],
      ['/results', 'hideOnSearch'], ['/watch', 'hideOnRelated'], ['/@channel/videos', 'hideOnChannel']]) {
      s.location.pathname = pathname;
      s.applyWatchedDisplaySettings({ dimWatched: true }); s.hideCard(c, c.id);
      assert.equal(c.dataset.watchedDimmed, 'true');
      s.receive({ type: 'WATCHED_DISPLAY_SETTINGS_CHANGED', settings: { dimWatched: true, [key]: false } });
      s.hideCard(c, c.id);
      assert.equal(c.style.display, ''); assert.equal(c.dataset.watchedDimmed, undefined);
      assert.equal(c.dataset.watchedHidden, undefined);
    }
  });
  await test('REQ-4 live hide-dim-hide and restore paths', () => {
    const c = card(), other = card('other'), s = boot([c, other]);
    for (const dimWatched of [true, false, true]) {
      s.receive({ type: 'WATCHED_DISPLAY_SETTINGS_CHANGED', settings: { dimWatched } });
      s.hideCard(c, c.id); s.hideCard(other, other.id);
      assert.equal(c.style.display, dimWatched ? '' : 'none');
      assert.equal(c.dataset.watchedDimmed, dimWatched ? 'true' : undefined);
    }
    assert.equal(s.calls, 3);
    s.showCardsForVideoIds(['seen']);
    assert.equal(c.dataset.watchedDimmed, undefined); assert.equal(other.dataset.watchedDimmed, 'true');
    s.receive({ type: 'ENABLED_CHANGED', enabled: false });
    assert.equal(other.dataset.watchedDimmed, undefined); assert.equal(other.dataset.watchedVideoId, undefined);
  });
  await test('REQ-5 visible dim cards remain bulk targets and counts', () => {
    const c = card(), s = boot([c]);
    s.applyWatchedDisplaySettings({ dimWatched: true }); s.hideCard(c, c.id);
    assert(s.isChannelBulkActionCard(c));
    assert.equal(s.findQueueableCards('watch').length, 1);
    assert.equal(s.findWatchLaterableCards('watch').length, 1);
    s.showAllCards(); s.applyWatchedDisplaySettings({}); s.hideCard(c, c.id);
    assert.equal(s.findQueueableCards('watch').length, 0);
    assert.equal(s.findWatchLaterableCards('watch').length, 0);
  });
  await test('REQ-5 failed recording clears dim marker', async () => {
    const c = card(), s = boot([c]); s.applyWatchedDisplaySettings({ dimWatched: true });
    // Ensure this case detects an implementation missing dim support as well.
    s.hideCard(c, c.id); assert.equal(c.dataset.watchedDimmed, 'true');
    await s.recordSeekbarWatched(c, c.id, '', '', 10);
    assert.equal(c.dataset.watchedDimmed, undefined); assert.equal(c.dataset.watchedVideoId, undefined);
  });

  await test('REQ-4 REQ-5 recycled cards, SPA navigation and cache resets', async () => {
    for (const operation of ['processPage', 'checkRecommendations']) {
      const c = card(), s = boot([c]);
      Object.assign(s, {
        processRunning: false, processQueued: false, recoChecking: false,
        SELECTORS: { videoLink: 'a[href*="/watch?v="]' },
        getCardVideoId: c => c.id, hasYouTubeSeekbar: () => false,
        getCachedWatchedState: id => id === 'seen',
      });
      s.console.log = () => {};
      s.location.pathname = '/watch';
      vm.runInContext(fn(operation), s);
      s.applyWatchedDisplaySettings({ dimWatched: true });
      await s[operation](); assert.equal(c.dataset.watchedDimmed, 'true');
      await s[operation](); assert.equal(c.dataset.watchedDimmed, 'true');
      c.id = 'fresh'; c.querySelector = () => ({ href: 'https://www.youtube.com/watch?v=fresh' });
      await s[operation]();
      assert.equal(c.dataset.watchedDimmed, undefined);
      assert.equal(c.dataset.watchedCheckedId, 'fresh');
    }
    const c = card(), s = boot([c]);
    s.applyWatchedDisplaySettings({ dimWatched: true }); s.hideCard(c, c.id);
    assert.equal(c.dataset.watchedDimmed, 'true');
    Object.assign(s, { contextInvalidated: false, setTimeout() {},
      ensureQueueAllButton() {}, ensureWatchLaterButton() {}, isHistoryPage: () => false,
      removeHarvestUI() {}, watchedPositive: new Set(), recentLookup: new Map(), pendingLookup: new Map(),
      loadCache() {}, cacheLoaded: true,
    });
    vm.runInContext(fn('onNavigateFinish'), s); s.onNavigateFinish();
    assert.equal(c.dataset.watchedDimmed, undefined);
    s.hideCard(c, c.id);
    const cacheReset = block("      if (mode === 'reload') {", "      } else {");
    vm.runInContext("const mode = 'reload';\n" + cacheReset + '\n}', s);
    assert.equal(c.dataset.watchedDimmed, undefined);
  });
  await test('REQ-5 button labels count visible dim cards', () => {
    const c = card(), s = boot([c]);
    Object.assign(s, { queueAllBtn: { style: {} }, watchLaterBtn: { style: {} },
      queueInProgress: false, watchLaterInProgress: false,
      queueButtonContext: 'watch', watchLaterButtonContext: 'watch', contentMessage: (_, fallback) => fallback,
    });
    vm.runInContext(fn('updateQueueButtonLabel') + fn('updateWatchLaterButtonLabel'), s);
    s.applyWatchedDisplaySettings({ dimWatched: true }); s.hideCard(c, c.id);
    s.updateQueueButtonLabel(); s.updateWatchLaterButtonLabel();
    assert.match(s.queueAllBtn.textContent, /\(1\)/); assert.equal(s.queueAllBtn.disabled, false);
    assert.match(s.watchLaterBtn.textContent, /\(1\)/); assert.equal(s.watchLaterBtn.disabled, false);
  });

  await test('REQ-4 main OFF while watched lookup is pending leaves no dimming', async () => {
    for (const operation of ['processPage', 'checkRecommendations']) {
      const c = card(), s = boot([c]);
      let resolve;
      Object.assign(s, { processRunning: false, processQueued: false, recoChecking: false,
        SELECTORS: { videoLink: 'a[href*="/watch?v="]' }, getCardVideoId: c => c.id,
        hasYouTubeSeekbar: () => false, getCachedWatchedState: () => undefined,
        lookupWatchedForIds: () => new Promise(done => { resolve = done; }),
      });
      s.console.log = () => {}; s.location.pathname = '/watch';
      vm.runInContext(fn(operation), s);
      s.applyWatchedDisplaySettings({ dimWatched: true });
      const running = s[operation]();
      s.receive({ type: 'ENABLED_CHANGED', enabled: false });
      resolve({ seen: true }); await running;
      assert.equal(c.dataset.watchedDimmed, undefined);
      assert.equal(c.dataset.watchedHidden, undefined);
      assert.equal(c.style.display, '');
    }
  });
  console.log(`Result: ${passed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0;
})();
