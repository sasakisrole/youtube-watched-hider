const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
function block(a, b) {
  const start = src.indexOf(a), end = src.indexOf(b, start);
  assert(start >= 0 && end > start, a);
  return src.slice(start, end);
}
const page = { location: { pathname: '/' }, writes: 0, queries: 0,
  DBClient: { addWatched: async () => { page.writes++; return {}; } },
  rememberWatched() {}, forgetWatched() {}, showImportToast() {}, console,
  hideShorts: true, hideMovies: true,
  document: { querySelectorAll() { page.queries++; return []; } },
};
vm.createContext(page);
vm.runInContext(block('  // Watched display settings', '  let recordWhileOff') +
  block('  function hideCard(', '  function showAllCards(') +
  block('  function recordSeekbarWatched(', '  function getCachedWatchedState(') +
  block('  function hideShortsCards(', '  function showAllShorts(') +
  block('  function hideMovieCards(', '  function showAllMovies('), page);
function configure(value) {
  page.input = value;
  vm.runInContext('applyWatchedDisplaySettings(input)', page);
}
const roots = ['/@name', '/channel/UC123', '/c/name', '/user/name'];
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message); }
}
(async () => {
  await test('REQ-1 channel roots and tabs stop all hiding but keep recording', async () => {
    configure({ hideOnChannel: false });
    for (const root of roots) for (const tab of ['', '/', '/videos', '/shorts', '/streams', '/playlists', '/community']) {
      page.location.pathname = root + tab;
      const card = { style: {}, dataset: {} };
      page.hideCard(card, 'id');
      assert.notEqual(card.style.display, 'none', root + tab);
      page.hideShortsCards(); page.hideMovieCards();
      assert.equal(page.queries, 0);
      const before = page.writes;
      await page.recordSeekbarWatched(card, 'id', 'title', 'channel', 60);
      assert.equal(page.writes, before + 1);
    }
  });
  await test('REQ-2 missing and invalid channel settings default on', () => {
    assert(src.includes('hideOnChannel: true'), 'explicit channel default');
    for (const value of [undefined, null, 0, 1, '', 'false', {}, [], true]) {
      configure({ hideOnChannel: value });
      for (const root of roots) {
        page.location.pathname = root;
        assert.equal(page.shouldHideOnCurrentPage(), true);
      }
    }
  });
  await test('REQ-3 subscriptions and channel switches are independent', () => {
    configure({ hideOnSubscriptions: false });
    page.location.pathname = '/feed/subscriptions';
    assert.equal(page.shouldHideOnCurrentPage(), false);
    page.location.pathname = '/@name/videos';
    assert.equal(page.shouldHideOnCurrentPage(), true);
    configure({ hideOnChannel: false });
    page.location.pathname = '/@name/videos';
    assert.equal(page.shouldHideOnCurrentPage(), false);
    for (const pathname of ['/feed/subscriptions', '/results', '/watch', '/', '/channel', '/c', '/user', '/@', '/channelish/name']) {
      page.location.pathname = pathname;
      assert.equal(page.shouldHideOnCurrentPage(), true, pathname);
    }
  });
  console.log(`${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
