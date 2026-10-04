const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = file => fs.readFileSync(path.join(process.env.YWH_TEST_ROOT || path.join(__dirname, '..'), file), 'utf8');
const source = read('content.js');
function fn(name) {
  const match = source.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  }`));
  assert(match, name); return match[0];
}
function card(collection = true, related = true) {
  return { collection, related, dataset: {}, style: { display: '' }, offsetParent: {},
    matches: () => false,
    closest: selector => related && selector.includes('#related') ? {} : null,
    querySelector(selector) {
      if (selector === 'yt-collection-thumbnail-view-model') return this.collection ? {} : null;
      if (selector === 'a[href*="/watch?v="]') return { href: 'https://www.youtube.com/watch?v=seen&list=PL1' };
      return null;
    },
  };
}
function boot(cards, pathname = '/') {
  const accesses = [];
  const forbidden = () => { accesses.push('watched access'); throw new Error('Playlist accessed watched state or network'); };
  const scope = { location: { pathname }, enabled: true, processRunning: false, processQueued: false, recoChecking: false,
    accesses, DBClient: {}, ALL_CARD_SELECTORS: 'cards', RELATED_CARD_SELECTORS: 'cards',
    SELECTORS: { videoLink: 'a[href*="/watch?v="]' },
    document: { querySelectorAll: () => cards }, console: { log() {}, error(...args) { throw args.at(-1); } },
    hideShortsCards() {}, hideMovieCards() {}, showAllShorts() {}, showAllMovies() {},
    stopRecoPolling() {}, startRecoPolling() {},
    getCurrentVideoId: () => 'playing', getCardVideoId: forbidden, getVideoIdFromHref: forbidden,
    hasYouTubeSeekbar: forbidden, getCachedWatchedState: forbidden, lookupWatchedForIds: forbidden,
    recordSeekbarWatched: forbidden, sendRuntimeMessage: forbidden, rememberWatched: forbidden, rememberNotWatched: forbidden,
  };
  vm.createContext(scope);
  require('./page_lifecycle_harness').install(scope, source);
  const start = source.indexOf("    if (message.type === 'ENABLED_CHANGED')");
  const end = source.indexOf("    if (message.type === 'RECORD_WHILE_OFF_CHANGED')", start);
  vm.runInContext(source.slice(source.indexOf('  // Watched display settings'), source.indexOf('  let recordWhileOff')) +
    ['isPlaylistCard', 'processPage', 'checkRecommendations', 'hideCard', 'showAllCards', 'showCardsForVideoIds'].map(fn).join('\n') +
    '\nfunction receive(message) {\n' + source.slice(start, end) + '\n}', scope);
  return scope;
}
function expectDisplay(c, hidden, dim = false) {
  assert.equal(c.style.display, hidden && !dim ? 'none' : '');
  assert.equal(c.dataset.watchedDimmed, hidden && dim ? 'true' : undefined);
  assert.equal(c.dataset.watchedHidden, hidden && !dim ? 'true' : undefined);
}
let passed = 0, failed = 0;
async function test(name, run) {
  try { await run(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message); }
}
(async () => {
  const pages = [['search', '/results', true], ['related', '/watch', true], ['home', '/', true],
    ['channel', '/@name/videos', false], ['playlist-list', '/feed/playlists', false],
    ['subscriptions', '/feed/subscriptions', false], ['playlist-page', '/playlist', false]];
  for (const mode of ['never', 'search_related', 'everywhere']) for (const [name, pathname, limited] of pages) {
    await test(`REQ-1 matrix ${mode} / ${name}`, async () => {
      for (const dim of [false, true]) {
        const c = card(), s = boot([c], pathname);
        s.applyWatchedDisplaySettings({ playlistCardMode: mode, dimWatched: dim });
        await s.processPage(); expectDisplay(c, mode === 'everywhere' && pathname !== '/playlist' || mode === 'search_related' && limited, dim);
        if (pathname === '/watch') {
          s.showAllCards(); await s.checkRecommendations();
          expectDisplay(c, mode !== 'never', dim);
        }
        assert.deepEqual(s.accesses, [], 'no watched state reads or messages');
      }
    });
  }
  await test('REQ-1 missing and invalid modes default to never', async () => {
    const c = card(), s = boot([c], '/results');
    s.applyWatchedDisplaySettings({ playlistCardMode: 'everywhere' }); await s.processPage(); expectDisplay(c, true);
    for (const value of [undefined, null, false, true, 1, '', 'all', {}, []]) {
      s.applyWatchedDisplaySettings({ playlistCardMode: value }); await s.processPage(); expectDisplay(c, false);
    }
  });
  await test('REQ-1 limited mode only targets related area on watch page', async () => {
    const c = card(true, false), s = boot([c], '/watch');
    s.applyWatchedDisplaySettings({ playlistCardMode: 'search_related' });
    await s.processPage(); await s.checkRecommendations(); expectDisplay(c, false);
    s.applyWatchedDisplaySettings({ playlistCardMode: 'everywhere' }); await s.processPage(); expectDisplay(c, false);
  });
  await test('REQ-1 legacy playlist and mix renderers are scanned', () => {
    const start = source.indexOf('  const ALL_CARD_SELECTORS');
    const selectors = source.slice(start, source.indexOf("].join(', ')", start));
    for (const selector of ['ytd-playlist-renderer', 'ytd-grid-playlist-renderer', 'ytd-radio-renderer']) assert(selectors.includes(selector), selector);
  });
  await test('REQ-3 live hide dim restore and main OFF without watched access', async () => {
    const c = card(), s = boot([c], '/results');
    for (const settings of [{ playlistCardMode: 'everywhere' }, { playlistCardMode: 'everywhere', dimWatched: true },
      { playlistCardMode: 'everywhere' }, { playlistCardMode: 'never' }, { playlistCardMode: 'everywhere', dimWatched: true }]) {
      s.receive({ type: 'WATCHED_DISPLAY_SETTINGS_CHANGED', settings });
      expectDisplay(c, settings.playlistCardMode !== 'never', !!settings.dimWatched);
      assert.equal(c.dataset.watchedVideoId, undefined); assert.equal(c.dataset.watchedCheckedId, undefined);
    }
    s.receive({ type: 'ENABLED_CHANGED', enabled: false }); expectDisplay(c, false);
    s.receive({ type: 'WATCHED_DISPLAY_SETTINGS_CHANGED', settings: { playlistCardMode: 'everywhere' } }); expectDisplay(c, false);
    s.receive({ type: 'ENABLED_CHANGED', enabled: true }); expectDisplay(c, true);
    const css = read('content.css');
    assert.match(css, /\[data-watched-dimmed="true"\]\s*\{[^}]*opacity:\s*0\.35/);
    assert.match(css, /\[data-watched-dimmed="true"\]:hover\s*\{[^}]*opacity:\s*1/);
  });
  await test('REQ-3 live page change and video history restore keep card policy', async () => {
    const c = card(), s = boot([c], '/results');
    s.applyWatchedDisplaySettings({ playlistCardMode: 'search_related' }); await s.processPage(); expectDisplay(c, true);
    s.showCardsForVideoIds(['seen']); expectDisplay(c, true);
    s.location.pathname = '/'; await s.processPage(); expectDisplay(c, true);
    s.location.pathname = '/watch'; await s.checkRecommendations(); expectDisplay(c, true);
  });
  await test('REQ-3 page switches do not control playlist cards', async () => {
    for (const [pathname, key] of [['/', 'hideOnHome'], ['/results', 'hideOnSearch'], ['/watch', 'hideOnRelated'],
      ['/@name/videos', 'hideOnChannel'], ['/feed/subscriptions', 'hideOnSubscriptions'], ['/feed/playlists', 'hideOnPlaylist']]) {
      const c = card(), s = boot([c], pathname);
      for (const dimWatched of [false, true]) {
        s.receive({ type: 'WATCHED_DISPLAY_SETTINGS_CHANGED', settings: { playlistCardMode: 'everywhere', [key]: false, dimWatched } });
        expectDisplay(c, true, dimWatched);
      }
    }
  });
  await test('REQ-3 playlist videos and bulk predicates keep their behavior', async () => {
    const c = card(false), s = boot([c], '/playlist');
    Object.assign(s, { getVideoIdFromHref: () => 'seen', getCardVideoId: () => 'seen', hasYouTubeSeekbar: () => false,
      getCachedWatchedState: () => true, hasLiveBadge: () => false, isCardShorts: () => false });
    vm.runInContext(fn('isChannelBulkActionCard'), s);
    for (const mode of ['never', 'search_related', 'everywhere']) {
      s.receive({ type: 'WATCHED_DISPLAY_SETTINGS_CHANGED', settings: { playlistCardMode: mode, hideOnPlaylist: false } });
      expectDisplay(c, false); assert.equal(s.isChannelBulkActionCard(c), true);
      s.receive({ type: 'WATCHED_DISPLAY_SETTINGS_CHANGED', settings: { playlistCardMode: mode, hideOnPlaylist: true } });
      expectDisplay(c, true);
      const collection = card(); assert.equal(s.isChannelBulkActionCard(collection), false);
    }
  });
  await test('REQ-3 recycled collection returns to normal video handling', async () => {
    for (const operation of ['processPage', 'checkRecommendations']) {
      const c = card(), s = boot([c], '/watch');
      s.applyWatchedDisplaySettings({ playlistCardMode: 'everywhere', dimWatched: true });
      await s[operation](); expectDisplay(c, true, true);
      c.collection = false;
      Object.assign(s, { getVideoIdFromHref: () => 'fresh', getCardVideoId: () => 'fresh', hasYouTubeSeekbar: () => false, getCachedWatchedState: () => false });
      await s[operation](); expectDisplay(c, false); assert.equal(c.dataset.watchedCheckedId, 'fresh');
    }
  });

  const placePages = { home: '/', search: '/results', related: '/watch', subscriptions: '/feed/subscriptions', channel: '/@name/videos', playlists: '/feed/playlists' };
  const keys = Object.keys(placePages);
  const defaults = { home: true, search: true, related: true, subscriptions: false, channel: false, playlists: false };
  for (let mask = 0; mask < 64; mask++) for (const [place, pathname] of Object.entries(placePages)) {
    await test(`REQ-1 places mask=${mask} page=${place} hide and never`, async () => {
      const places = Object.fromEntries(keys.map((key, i) => [key, !!(mask & (1 << i))]));
      for (const mode of ['hide', 'never']) for (const dim of [false, true]) {
        const c = card(), s = boot([c], pathname);
        s.applyWatchedDisplaySettings({ playlistCardMode: mode, playlistCardPlaces: places, dimWatched: dim });
        await s.processPage(); expectDisplay(c, mode === 'hide' && places[place], dim);
        if (place === 'related') { s.showAllCards(); await s.checkRecommendations(); expectDisplay(c, mode === 'hide' && places[place], dim); }
        assert.deepEqual(s.accesses, []);
      }
    });
  }
  await test('REQ-2 migration defaults invalid and explicit places', async () => {
    const invalidPlaces = [undefined, null, false, 1, '', [], {}, { ...defaults, home: 'true' }, { home: true }];
    for (const mode of ['hide', 'search_related', 'everywhere', 'never', undefined, 'bad', true, {}, []]) {
      for (const places of [...invalidPlaces, defaults, Object.fromEntries(keys.map(k => [k, false]))]) {
        for (const [place, pathname] of Object.entries(placePages)) {
          const c = card(), s = boot([c], pathname);
          s.applyWatchedDisplaySettings({ playlistCardMode: mode, playlistCardPlaces: places });
          await s.processPage();
          const expected = invalidPlaces.includes(places) ? (mode === 'everywhere' || defaults[place]) : places[place];
          expectDisplay(c, ['hide', 'search_related', 'everywhere'].includes(mode) && expected);
        }
      }
    }
  });
  await test('REQ-3 live place changes restore excluded pages in both display modes', async () => {
    for (const dimWatched of [false, true]) for (const [place, pathname] of Object.entries(placePages)) {
      const c = card(), s = boot([c], pathname);
      const settings = { playlistCardMode: 'hide', dimWatched, playlistCardPlaces: Object.fromEntries(keys.map(k => [k, true])),
        hideOnHome: false, hideOnSearch: false, hideOnRelated: false, hideOnSubscriptions: false, hideOnChannel: false, hideOnPlaylist: false };
      s.receive({ type: 'WATCHED_DISPLAY_SETTINGS_CHANGED', settings }); expectDisplay(c, true, dimWatched);
      settings.playlistCardPlaces[place] = false;
      s.receive({ type: 'WATCHED_DISPLAY_SETTINGS_CHANGED', settings }); expectDisplay(c, false);
      settings.playlistCardPlaces[place] = true;
      s.receive({ type: 'WATCHED_DISPLAY_SETTINGS_CHANGED', settings }); expectDisplay(c, true, dimWatched);
      s.location.pathname = '/feed/history'; await s.processPage(); expectDisplay(c, false);
    }
  });
  await test('REQ-1 channel aliases trailing slash and watch area boundaries', async () => {
    for (const pathname of ['/@name', '/@name/shorts/', '/channel/UC123/live', '/c/name', '/user/name/videos', '/feed/playlists/', '/results/']) {
      const c = card(), s = boot([c], pathname);
      s.applyWatchedDisplaySettings({ playlistCardMode: 'hide', playlistCardPlaces: Object.fromEntries(keys.map(k => [k, true])) });
      await s.processPage(); expectDisplay(c, true);
    }
    for (const pathname of ['/watch', '/playlist', '/feed/history', '/feed/trending', '/channel', '/watching']) {
      const c = card(true, false), s = boot([c], pathname);
      s.applyWatchedDisplaySettings({ playlistCardMode: 'hide', playlistCardPlaces: Object.fromEntries(keys.map(k => [k, true])) });
      await s.processPage(); expectDisplay(c, false);
    }
  });
  console.log(`${passed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0;
})();
