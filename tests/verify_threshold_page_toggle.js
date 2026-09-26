// Run with node; extracted production code, no browser/network/real DB.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const src = fs.readFileSync(process.argv.includes('--baseline-stdin') ? 0 : path.join(__dirname, '..', 'content.js'), 'utf8');
function between(a, b) {
  const start = src.indexOf(a), end = src.indexOf(b, start);
  assert(start >= 0 && end > start, `Missing production block: ${a}`);
  return src.slice(start, end);
}
const settings = src.includes('  // Watched display settings')
  ? between('  // Watched display settings', '  let recordWhileOff')
  : 'const WATCHED_THRESHOLD = 95; function applyWatchedDisplaySettings() {}';
const context = {
  location: { pathname: '/' },
  SELECTORS: { resumeOverlay: 'resume', seekbar: 'old', progressBarNew: 'new' },
  DBClient: { addWatched: async () => { context.writes++; return {}; } },
  writes: 0, rememberWatched() {}, forgetWatched() {}, showImportToast() {}, console,
};
vm.createContext(context);
vm.runInContext(settings + '\n' +
  between('  function hasYouTubeSeekbar(', '  // Get current video ID') +
  between('  function isHistoryCardCompleted(', '  async function scrapeHistoryPage(') +
  between('  function hideCard(', '  function showAllCards(') +
  between('  function recordSeekbarWatched(', '  function getCachedWatchedState('), context);
function configure(value = {}) {
  context.input = value;
  vm.runInContext('applyWatchedDisplaySettings(input)', context);
}
function card(width, kind = 'old', overlay = false) {
  return { style: {}, dataset: {}, querySelector(s) {
    if (s === 'resume') return overlay ? {} : null;
    return s === kind ? { style: { width: width + '%' } } : null;
  } };
}
(async () => {
  if (!process.argv.includes('--pages-only')) for (const fn of ['hasYouTubeSeekbar', 'isHistoryCardCompleted']) {
    for (const kind of ['old', 'new']) {
      configure();
      assert.equal(context[fn](card(94, kind)), false);
      assert.equal(context[fn](card(95, kind)), true);
      configure({ watchedThreshold: 80 });
      assert.equal(context[fn](card(79, kind)), false);
      assert.equal(context[fn](card(80, kind)), true);
      assert.equal(context[fn](card(79, kind, true)), false, 'overlay must not override measured progress');
      assert.equal(context[fn](card(NaN, kind, true)), true, 'overlay-only fallback');
      for (const invalid of [-1, 0, 101, NaN, Infinity, '80', '', null, {}, true]) {
        configure({ watchedThreshold: invalid });
        assert.equal(context[fn](card(94, kind)), false, String(invalid));
        assert.equal(context[fn](card(95, kind)), true);
      }
      for (const valid of [1, 100]) {
        configure({ watchedThreshold: valid });
        assert.equal(context[fn](card(valid, kind)), true);
        assert.equal(context[fn](card(valid - 1, kind)), false);
      }
    }
  }
  const pages = { hideOnHome: '/', hideOnSubscriptions: '/feed/subscriptions', hideOnSearch: '/results', hideOnRelated: '/watch' };
  for (const [key, pathname] of Object.entries(pages)) {
    configure({ [key]: false });
    for (const current of [...Object.values(pages), '/feed/history', '/@channel/videos']) {
      context.location.pathname = current;
      const c = card(100);
      context.hideCard(c, 'id');
      assert.equal(c.style.display === 'none', current !== pathname, `${key}: ${current}`);
    }
    context.location.pathname = pathname;
    const c = card(100), before = context.writes;
    await context.recordSeekbarWatched(c, 'id', 'title', 'channel', 60);
    assert.equal(c.style.display, undefined);
    assert.equal(context.writes, before + 1, 'recording must continue when hiding is off');
    configure();
    context.hideCard(c, 'id');
    assert.equal(c.style.display, 'none', 'missing setting defaults to hide');
  }
  // A failed write must be retryable even on a page that stays visible.
  configure({ hideOnHome: false });
  context.location.pathname = '/';
  context.DBClient.addWatched = async () => { throw { contextInvalidated: true }; };
  const failedCard = card(100);
  await context.recordSeekbarWatched(failedCard, 'failed', 'title', 'channel', 60);
  assert.equal(failedCard.dataset.watchedCheckedId, undefined);

  // Page switches suppress category hiding too, without querying/mutating cards.
  context.hideShorts = true;
  context.hideMovies = true;
  context.SHORTS_SELECTORS = { reelShelf: 'reel', richShelf: 'rich' };
  context.ALL_CARD_SELECTORS = 'cards';
  let queries = 0;
  context.document = { querySelectorAll() { queries++; return []; } };
  vm.runInContext(between('  function hideShortsCards(', '  function showAllShorts(') +
    between('  function hideMovieCards(', '  function showAllMovies('), context);
  context.hideShortsCards();
  context.hideMovieCards();
  assert.equal(queries, 0);
  context.location.pathname = '/results';
  context.hideShortsCards();
  context.hideMovieCards();
  assert(queries > 0);
  console.log('PASS threshold defaults, validation, old/new UI, history, four page toggles, recording');
})().catch(e => { console.error(e); process.exitCode = 1; });
