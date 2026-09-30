const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = file => fs.readFileSync(path.join(process.env.YWH_TEST_ROOT || path.join(__dirname, '..'), file), 'utf8');
const popup = read('popup.js'), html = read('popup.html');
const defaults = { home: true, search: true, related: true, subscriptions: false, channel: false, playlists: false };
const keys = Object.keys(defaults);
let passed = 0, failed = 0;
function test(name, run) {
  try { run(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message); }
}
function boot(initial = {}) {
  const elements = {}, stored = { ...initial }, sent = [];
  const s = { document: { getElementById: id => elements[id] ||= { addEventListener(type, cb) { this[type] = cb; } } },
    chrome: { runtime: {}, storage: { local: {
      get(defaults, cb) { cb({ ...defaults, ...stored }); },
      set(values, cb) { Object.assign(stored, values); cb(); },
    } }, tabs: { query(filter, cb) { assert.equal(filter.url, '*://*.youtube.com/*'); cb([{ id: 1 }, { id: 2 }]); },
      sendMessage(id, message) { sent.push({ id, message: JSON.parse(JSON.stringify(message)) }); return Promise.resolve(); } } } };
  const start = popup.indexOf('// Watched display settings');
  vm.runInNewContext(popup.slice(start, popup.indexOf('// Load settings', start)), s);
  return { elements, stored, sent };
}
test('REQ-4 accessible two choices and localized place labels', () => {
  const select = html.match(/<select[^>]*id="playlistCardMode"[^>]*>([^]*?)<\/select>/);
  assert(select); assert.match(select[0], /aria-labelledby="playlistCardModeLabel"/);
  assert.match(select[0], /aria-describedby="playlistCardModeDesc"/);
  assert.match(html, /<label[^>]*for="playlistCardMode"/);
  assert.deepEqual([...select[1].matchAll(/value="([^"]+)"/g)].map(m => m[1]), ['never', 'hide']);
  assert(html.indexOf('id="playlistCardMode"') > html.indexOf('data-i18n="popup_hideRelatedHelp"'));
  assert(html.indexOf('id="playlistCardPlaces"') < html.indexOf('id="hideShortsLabel"'));
  assert.match(html, /id="playlistCardPlaces"[^>]*role="group"[^>]*aria-labelledby="playlistCardPlacesLabel"[^>]*hidden/);
  for (const [lang, labels] of [['ja', ['ホーム', '検索結果', '関連動画', '登録チャンネル', '各チャンネルページ', '再生リスト一覧']],
    ['en', ['Home', 'Search results', 'Related videos', 'Subscriptions', 'Channel pages', 'Playlists list']]]) {
    const locale = JSON.parse(read(`_locales/${lang}/messages.json`));
    assert.equal(locale.popup_playlistCardsHide.message, lang === 'ja' ? '隠す' : 'Hide');
    assert.equal(locale.popup_playlistCardsNever.message, lang === 'ja' ? '隠さない' : "Don't hide");
    assert(locale.popup_playlistCardPlaces.message);
    for (const [i, key] of keys.entries()) {
      const id = `playlistCardPlace_${key}`, msg = `popup_playlistCardPlace_${key}`;
      assert.match(html, new RegExp(`<input[^>]*type="checkbox"[^>]*id="${id}"[^>]*aria-labelledby="${id}Label"`));
      assert.match(html, new RegExp(`<label[^>]*id="${id}Label"[^>]*for="${id}"[^>]*data-i18n="${msg}"`));
      assert.equal(locale[msg].message, labels[i]);
    }
  }
  const css = read('popup.css');
  assert.match(css, /\.toggle input:focus-visible\s*\+\s*\.slider\s*\{[^}]*outline:/);
});
test('REQ-1 places visible only while hiding and defaults checked', () => {
  const { elements, stored } = boot();
  assert.equal(elements.playlistCardMode.value, 'never');
  assert.equal(elements.playlistCardPlaces.hidden, true);
  for (const key of keys) assert.equal(elements[`playlistCardPlace_${key}`].checked, defaults[key]);
  for (const mode of ['hide', 'never', 'hide']) {
    elements.playlistCardMode.change({ target: { value: mode } });
    assert.equal(elements.playlistCardPlaces.hidden, mode === 'never');
    assert.equal(stored.playlistCardMode, mode);
  }
});
test('REQ-2 popup migration validation and reopen preserve places', () => {
  for (const mode of [undefined, null, false, 1, '', 'invalid', {}, [], 'never', 'hide', 'search_related', 'everywhere']) {
    for (const places of [undefined, null, [], {}, { ...defaults, search: 1 }, { ...defaults }, Object.fromEntries(keys.map(k => [k, false]))]) {
      const { elements, stored } = boot({ playlistCardMode: mode, playlistCardPlaces: places });
      const expectedMode = ['hide', 'search_related', 'everywhere'].includes(mode) ? 'hide' : 'never';
      const valid = places && !Array.isArray(places) && keys.every(k => typeof places[k] === 'boolean');
      assert.equal(elements.playlistCardMode.value, expectedMode);
      assert.equal(elements.playlistCardPlaces.hidden, expectedMode === 'never');
      for (const key of keys) assert.equal(elements[`playlistCardPlace_${key}`].checked, valid ? places[key] : mode === 'everywhere' || defaults[key]);
      elements.playlistCardMode.change({ target: { value: 'never' } });
      const reopened = boot(stored).elements;
      reopened.playlistCardMode.change({ target: { value: 'hide' } });
      for (const key of keys) assert.equal(reopened[`playlistCardPlace_${key}`].checked, elements[`playlistCardPlace_${key}`].checked);
    }
  }
});
test('REQ-3 each place saves and broadcasts complete snapshot to every open tab', () => {
  const { elements, stored, sent } = boot({ playlistCardMode: 'everywhere', hideOnChannel: false });
  for (const key of keys) for (const checked of [false, true]) {
    elements[`playlistCardPlace_${key}`].checked = checked;
    elements[`playlistCardPlace_${key}`].change({ target: { checked } });
    assert.equal(stored.playlistCardPlaces[key], checked);
    assert.deepEqual(sent.slice(-2).map(x => x.id), [1, 2]);
    const message = sent.at(-1).message;
    assert.equal(message.type, 'WATCHED_DISPLAY_SETTINGS_CHANGED');
    assert.equal(message.settings.playlistCardPlaces[key], checked);
    assert.equal(message.settings.hideOnChannel, false);
    assert.equal(message.settings.hideOnPlaylist, true);
    for (const other of keys.filter(k => k !== key)) assert.equal(message.settings.playlistCardPlaces[other], true);
  }
  elements.playlistCardMode.change({ target: { value: 'never' } });
  assert.equal(sent.at(-1).message.settings.playlistCardMode, 'never');
});
test('REQ-4 playlist video switch keeps label help and storage key', () => {
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
