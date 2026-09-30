const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = file => fs.readFileSync(path.join(process.env.YWH_TEST_ROOT || path.join(__dirname, '..'), file), 'utf8');
const popup = read('popup.js'), html = read('popup.html');
let passed = 0, failed = 0;
function test(name, run) {
  try { run(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message); }
}
test('REQ-1 accessible selector order and three localized choices', () => {
  const select = html.match(/<select[^>]*id="playlistCardMode"[^>]*>([^]*?)<\/select>/);
  assert(select); assert.match(select[0], /aria-labelledby="playlistCardModeLabel"/);
  assert.match(select[0], /aria-describedby="playlistCardModeDesc"/);
  assert(html.indexOf('id="playlistCardMode"') > html.indexOf('data-i18n="popup_hideRelatedHelp"'));
  assert(html.indexOf('id="playlistCardMode"') < html.indexOf('id="hideShortsLabel"'));
  assert.deepEqual([...select[1].matchAll(/value="([^"]+)"/g)].map(m => m[1]), ['never', 'search_related', 'everywhere']);
  for (const [lang, label, choices] of [['ja', 'プレイリストのカード', ['隠さない', '検索結果・関連動画でだけ隠す', 'どこでも隠す']],
    ['en', 'Playlist cards', ["Don't hide", 'Hide only in search results and related videos', 'Hide everywhere']]]) {
    const locale = JSON.parse(read(`_locales/${lang}/messages.json`));
    assert.equal(locale.popup_playlistCards.message, label);
    for (const [i, key] of ['popup_playlistCardsNever', 'popup_playlistCardsSearchRelated', 'popup_playlistCardsEverywhere'].entries()) {
      assert.equal(locale[key].message, choices[i]); assert(select[1].includes(`data-i18n="${key}"`));
    }
    assert(locale.popup_playlistCardsHelp.message);
  }
});
test('REQ-1 REQ-2 selector validates loads saves and broadcasts all tabs', () => {
  for (const value of [undefined, null, false, 1, '', 'invalid', {}, [], 'never', 'search_related', 'everywhere']) {
    const elements = {}, stored = { playlistCardMode: value }, sent = [];
    const s = { document: { getElementById: id => elements[id] ||= { addEventListener(type, cb) { this[type] = cb; } } },
      chrome: { runtime: {}, storage: { local: {
        get(defaults, cb) { assert.equal(defaults.playlistCardMode, 'never'); cb({ ...defaults, ...stored }); },
        set(values, cb) { Object.assign(stored, values); cb(); },
      } }, tabs: { query(filter, cb) { assert.equal(filter.url, '*://*.youtube.com/*'); cb([{ id: 1 }, { id: 2 }]); },
        sendMessage(id, message) { sent.push({ id, message }); return Promise.resolve(); } } } };
    const start = popup.indexOf('// Watched display settings');
    vm.runInNewContext(popup.slice(start, popup.indexOf('// Load settings', start)), s);
    assert.equal(elements.playlistCardMode.value, ['search_related', 'everywhere'].includes(value) ? value : 'never');
    for (const mode of ['search_related', 'everywhere', 'never', 'invalid']) {
      elements.playlistCardMode.change({ target: { value: mode } });
      const expected = mode === 'invalid' ? 'never' : mode;
      assert.equal(stored.playlistCardMode, expected);
      assert.deepEqual(sent.slice(-2).map(x => x.id), [1, 2]);
      assert.equal(sent.at(-1).message.type, 'WATCHED_DISPLAY_SETTINGS_CHANGED');
      assert.equal(sent.at(-1).message.settings.playlistCardMode, expected);
      assert.equal(sent.at(-1).message.settings.hideOnPlaylist, true);
    }
  }
});
test('REQ-4 playlist page label help and unchanged storage key', () => {
  for (const [lang, label, help] of [['ja', 'プレイリストのページで隠す', 'プレイリストのページに並ぶ視聴済みの動画が対象です。'],
    ['en', 'Hide in playlist pages', 'Applies to watched videos listed on playlist pages.']]) {
    const locale = JSON.parse(read(`_locales/${lang}/messages.json`));
    assert.equal(locale.popup_hidePlaylist.message, label); assert.equal(locale.popup_hidePlaylistHelp.message, help);
    if (lang === 'ja') { assert(html.includes(label)); assert(html.includes(help)); }
  }
  assert.match(html, /id="hideOnPlaylist"[^>]*aria-describedby="hideOnPlaylistDesc"/);
  assert(popup.includes("'hideOnPlaylist'"));
});
console.log(`${passed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0;
