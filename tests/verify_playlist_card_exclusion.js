const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(process.env.YWH_TEST_ROOT || path.join(__dirname, '..'), 'content.js'), 'utf8');
function fn(name) {
  const match = source.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  }`));
  assert(match, name); return match[0];
}
function card({ self = '', child = '', href = '/watch?v=seen&list=PL1' } = {}) {
  const matches = (selector, value) => selector.split(',').some(s => s.trim() === value);
  return { dataset: {}, style: { display: '' },
    matches: s => matches(s, self),
    querySelector(s) {
      if (s === 'a[href*="/watch?v="]') return { href };
      return matches(s, child) ? {} : null;
    },
  };
}
function boot(cards, pathname = '/', dimWatched = false) {
  const scope = { location: { pathname }, enabled: true, processRunning: false, processQueued: false,
    recoChecking: false, DBClient: {}, ALL_CARD_SELECTORS: 'cards',
    SELECTORS: { videoLink: 'a[href*="/watch?v="]' },
    document: { querySelectorAll: () => cards },
    console: { log() {}, error(e) { throw e; } },
    hideShortsCards() {}, hideMovieCards() {}, getCurrentVideoId: () => null,
    getVideoIdFromHref: href => new URL(href, 'https://www.youtube.com').searchParams.get('v'),
    getCardVideoId: () => 'seen', hasYouTubeSeekbar: () => false,
    getCachedWatchedState: () => true, rememberWatched() {}, rememberNotWatched() {},
  };
  vm.createContext(scope);
  require('./page_lifecycle_harness').install(scope, source);
  vm.runInContext(source.slice(source.indexOf('  // Watched display settings'), source.indexOf('  let recordWhileOff')) +
    ['isPlaylistCard', 'processPage', 'hideCard', 'checkRecommendations'].map(fn).join('\n'), scope);
  scope.applyWatchedDisplaySettings({ dimWatched });
  return scope;
}
let passed = 0, failed = 0;
async function test(name, run) {
  try { await run(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message); }
}
(async () => {
  await test('REQ-1 collection thumbnails and collection lockups stay visible on every page', async () => {
    for (const pathname of ['/', '/feed/playlists', '/results', '/watch', '/@name/videos', '/feed/subscriptions', '/playlist']) {
      for (const method of ['processPage', 'checkRecommendations']) for (const dim of [false, true]) for (const shape of [
        { child: 'yt-collection-thumbnail-view-model' },
        { self: '.yt-lockup-view-model--collection' },
        { child: '.yt-lockup-view-model--collection' },
        { child: '[overlay-style="MIX"]' },
        { child: '[overlay-style="SHOW"]' },
        { self: 'ytd-playlist-renderer' },
      ]) {
        const c = card(shape), s = boot([c], method === 'checkRecommendations' ? '/watch' : pathname, dim);
        assert.equal(s.isPlaylistCard(c), true, JSON.stringify(shape));
        await s[method]();
        assert.equal(c.style.display, ''); assert.equal(c.dataset.watchedDimmed, undefined);
      }
    }
  });
  await test('REQ-1 ordinary videos including list links remain hide and dim targets', async () => {
    for (const pathname of ['/', '/results', '/watch', '/@name/videos', '/feed/subscriptions', '/playlist']) {
      for (const href of ['/watch?v=seen', '/watch?v=seen&list=PL1', '/watch?v=seen&list=RDseen&index=2']) {
        for (const child of ['yt-thumbnail-view-model', '#overlays .thumbnail-overlay-badge-shape[aria-label]']) for (const dim of [false, true]) {
          const c = card({ href, child }), s = boot([c], pathname, dim);
          assert.equal(s.isPlaylistCard(c), false);
          await s.processPage();
          assert.equal(c.style.display, dim ? '' : 'none');
          assert.equal(c.dataset.watchedDimmed, dim ? 'true' : undefined);
        }
      }
    }
  });
  await test('REQ-1 recycled collection cards clear watched state and preserve category hiding', async () => {
    for (const category of [null, 'shortsHidden', 'movieHidden']) {
      const c = card({ child: 'yt-collection-thumbnail-view-model' });
      Object.assign(c.dataset, { watchedHidden: 'true', watchedDimmed: 'true', watchedVideoId: 'seen', watchedCheckedId: 'seen' });
      c.style.display = 'none'; if (category) c.dataset[category] = 'true';
      await boot([c]).processPage();
      assert.equal(c.style.display, category ? 'none' : '');
      for (const key of ['watchedHidden', 'watchedDimmed', 'watchedVideoId', 'watchedCheckedId']) assert.equal(c.dataset[key], undefined);
    }
  });
  console.log(`${passed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0;
})();
