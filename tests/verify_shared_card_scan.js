const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
function block(start, end) {
  const a = src.indexOf(start), b = src.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start);
  return src.slice(a, b);
}
function setup(cards, shorts, movies, allowed = true) {
  let scans = 0;
  const shelf = { dataset: {}, style: {} };
  const scope = {
    cards, hideShorts: shorts, hideMovies: movies,
    shouldHideOnCurrentPage: () => allowed,
    ALL_CARD_SELECTORS: 'cards', SHORTS_SELECTORS: { reelShelf: 'reels', richShelf: 'rich', shortsLink: 'shorts' },
    document: { hidden: false, querySelectorAll(selector) {
      if (selector === 'cards') { scans++; return cards; }
      return selector === 'reels' ? [shelf] : [];
    } },
    isCardShorts: card => card.kind === 'short', isCardMovie: card => card.kind === 'movie',
    DBClient: { contextInvalidated: false }, enabled: true,
    processRunning: false, processQueued: false, recoChecking: false,
    location: { pathname: '/watch' }, getCurrentVideoId: () => 'current',
    isPlaylistCard: () => true, applyPlaylistCardDisplay() {}, console,
  };
  vm.createContext(scope);
  require('./page_lifecycle_harness').install(scope, src);
  vm.runInContext(block('  function hideShortsCards(', '  function showAllShorts(') +
    block('  function hideMovieCards(', '  function showAllMovies(') +
    block('  async function processPage()', '  function hideCard(') +
    block('  async function checkRecommendations()', '  // Shared selector for related video cards'), scope);
  return { scope, shelf, scans: () => scans };
}
function cards() {
  return ['short', 'movie', 'regular'].map(kind => ({ kind, style: {}, dataset: {} }));
}
(async () => {
  for (const entry of ['processPage', 'checkRecommendations']) {
    for (const shorts of [false, true]) for (const movies of [false, true]) {
      for (const allowed of [false, true]) {
        const rows = cards(), h = setup(rows, shorts, movies, allowed);
        await h.scope[entry]();
        assert.equal(h.scans(), 1, entry + ' shares one document scan');
        assert.equal(rows[0].dataset.shortsHidden === 'true', shorts && allowed);
        assert.equal(rows[1].dataset.movieHidden === 'true', movies && allowed);
        assert.equal(rows[2].style.display, undefined);
        assert.equal(h.shelf.dataset.shortsHidden === 'true', shorts && allowed);
      }
    }
    const empty = setup([], true, true);
    await empty.scope[entry]();
    assert.equal(empty.scans(), 1);
    assert.equal(empty.shelf.style.display, 'none', 'empty card list still hides shelves');
  }
  const standalone = setup(cards(), true, true);
  standalone.scope.hideShortsCards(); standalone.scope.hideMovieCards();
  assert.equal(standalone.scans(), 2, 'standalone callers still query their own snapshot');
  const off = setup(cards(), false, false);
  off.scope.hideShortsCards(); off.scope.hideMovieCards();
  assert.equal(off.scans(), 0, 'disabled standalone filters do not scan');
  console.log('PASS: shared scans, all settings, page exclusion, empty cards, standalone calls');
})().catch(error => { console.error(error); process.exitCode = 1; });
