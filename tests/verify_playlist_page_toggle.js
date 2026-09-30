const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = file => fs.readFileSync(path.join(process.env.YWH_TEST_ROOT || path.join(__dirname, '..'), file), 'utf8');
const source = read('content.js'), popup = read('popup.js'), html = read('popup.html');
function fn(name) {
  const match = source.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  }`));
  assert(match, name); return match[0];
}
let passed = 0, failed = 0;
function test(name, run) {
  try { run(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message); }
}
test('REQ-2 playlist opt-out restores hidden and dimmed rows live', () => {
  for (const dimWatched of [false, true]) {
    const c = { dataset: {}, style: { display: '' } };
    const s = { location: { pathname: '/playlist' }, document: { querySelectorAll: () => [c] },
      enabled: true, processPage() {}, hideShortsCards() {}, hideMovieCards() {}, showAllShorts() {}, showAllMovies() {} };
    const start = source.indexOf("    if (message.type === 'WATCHED_DISPLAY_SETTINGS_CHANGED')");
    const end = source.indexOf("    if (message.type === 'RECORD_WHILE_OFF_CHANGED')", start);
    vm.createContext(s);
    vm.runInContext(source.slice(source.indexOf('  // Watched display settings'), source.indexOf('  let recordWhileOff')) +
      fn('hideCard') + fn('showAllCards') + '\nfunction receive(message) {\n' + source.slice(start, end) + '\n}', s);
    s.applyWatchedDisplaySettings({ dimWatched }); s.hideCard(c, 'seen');
    assert.equal(c.style.display, dimWatched ? '' : 'none');
    s.receive({ type: 'WATCHED_DISPLAY_SETTINGS_CHANGED', settings: { hideOnPlaylist: false, dimWatched } });
    s.hideCard(c, 'seen');
    assert.equal(c.style.display, ''); assert.equal(c.dataset.watchedDimmed, undefined);
    assert.equal(c.dataset.watchedHidden, undefined);
    for (const pathname of ['/playlist', '/playlist/']) {
      s.location.pathname = pathname; assert.equal(s.shouldHideOnCurrentPage(), false);
    }
    for (const pathname of ['/', '/feed/playlists', '/watch', '/results', '/@name/playlists', '/feed/subscriptions']) {
      s.location.pathname = pathname; assert.equal(s.shouldHideOnCurrentPage(), true, pathname);
    }
    s.location.pathname = '/playlist';
    for (const value of [undefined, null, 0, 1, '', 'false', {}, [], true]) {
      s.applyWatchedDisplaySettings({ hideOnPlaylist: value }); assert.equal(s.shouldHideOnCurrentPage(), true);
    }
    s.receive({ type: 'WATCHED_DISPLAY_SETTINGS_CHANGED', settings: { hideOnPlaylist: true, dimWatched } });
    s.hideCard(c, 'seen'); assert.equal(c.style.display, dimWatched ? '' : 'none');
    assert.equal(c.dataset.watchedDimmed, dimWatched ? 'true' : undefined);
  }
});
test('REQ-2 popup order accessible help and matching ja en labels', () => {
  const input = html.match(/<input[^>]*id="hideOnPlaylist"[^>]*>/);
  assert(input); assert.match(input[0], /checked/); assert.match(input[0], /aria-describedby="hideOnPlaylistDesc"/);
  assert(html.indexOf('id="hideOnPlaylist"') > html.indexOf('id="hideOnChannel"'));
  assert(html.indexOf('id="hideOnPlaylistDesc"') < html.indexOf('id="hideOnSearch"'));
  for (const [lang, label] of [['ja', 'プレイリストで隠す'], ['en', 'Hide in playlists']]) {
    const locale = JSON.parse(read(`_locales/${lang}/messages.json`));
    assert.equal(locale.popup_hidePlaylist.message, label); assert(locale.popup_hidePlaylistHelp.message);
    assert(html.includes('data-i18n="popup_hidePlaylistHelp"'));
  }
});
test('REQ-2 popup validates loads saves and broadcasts playlist setting', () => {
  for (const value of [undefined, null, 0, '', 'false', {}, [], false, true]) {
    const elements = {}, stored = { hideOnPlaylist: value }, sent = [];
    const s = { document: { getElementById: id => elements[id] ||= { addEventListener(type, cb) { this[type] = cb; } } },
      chrome: { runtime: {}, storage: { local: {
        get(defaults, cb) { assert.equal(defaults.hideOnPlaylist, true); cb({ ...defaults, ...stored }); },
        set(values, cb) { Object.assign(stored, values); cb(); },
      } }, tabs: { query(filter, cb) { cb([{ id: 1 }]); }, sendMessage(id, message) { sent.push(message); return Promise.resolve(); } } } };
    const start = popup.indexOf('// Watched display settings');
    vm.runInNewContext(popup.slice(start, popup.indexOf('// Load settings', start)), s);
    assert.equal(elements.hideOnPlaylist.checked, value !== false);
    for (const checked of [false, true]) {
      elements.hideOnPlaylist.change({ target: { checked } }); assert.equal(stored.hideOnPlaylist, checked);
      assert.equal(sent.at(-1).settings.hideOnPlaylist, checked); assert.equal(sent.at(-1).settings.hideOnChannel, true);
    }
  }
});
console.log(`${passed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0;
