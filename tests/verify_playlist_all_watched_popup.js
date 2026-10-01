const { assert, read } = require('./playlist_all_watched_harness');
const vm = require('vm');
const popup = read('popup.js'), html = read('popup.html');
const elements = {}, stored = {}, sent = [];
const scope = { document: { getElementById: id => elements[id] ||= { addEventListener(type, cb) { this[type] = cb; } } },
  chrome: { runtime: {}, storage: { local: {
    get(defaults, cb) { cb({ ...defaults, ...stored }); }, set(values, cb) { Object.assign(stored, values); cb(); },
  } }, tabs: { query(filter, cb) { assert.equal(filter.url, '*://*.youtube.com/*'); cb([{ id: 1 }, { id: 2 }]); },
    sendMessage(id, message) { sent.push({ id, message }); return Promise.resolve(); } } } };
const start = popup.indexOf('// Watched display settings');
vm.runInNewContext(popup.slice(start, popup.indexOf('// Load settings', start)), scope);
assert.equal(elements.hideCompletedPlaylists?.checked, false);
console.log('PASS REQ-5 new switch defaults off');
for (const checked of [true, false]) {
  elements.hideCompletedPlaylists.change({ target: { checked } });
  assert.equal(stored.hideCompletedPlaylists, checked);
  assert.deepEqual(sent.slice(-2).map(x => x.id), [1, 2]);
  assert.equal(sent.at(-1).message.type, 'WATCHED_DISPLAY_SETTINGS_CHANGED');
  assert.equal(sent.at(-1).message.settings.hideCompletedPlaylists, checked);
}
console.log('PASS REQ-5 save and notify every YouTube tab');
assert.match(html, /<input[^>]*id="hideCompletedPlaylists"[^>]*aria-labelledby="hideCompletedPlaylistsLabel"[^>]*aria-describedby="hideCompletedPlaylistsDesc"/);
assert.doesNotMatch(html.match(/<input[^>]*id="hideCompletedPlaylists"[^>]*>/)[0], /\bchecked\b/);
for (const lang of ['ja', 'en']) {
  const locale = JSON.parse(read(`_locales/${lang}/messages.json`));
  assert.match(locale.popup_hideCompletedPlaylists.message, lang === 'ja' ? /試験中/ : /experimental/i);
  assert(locale.popup_hideCompletedPlaylistsHelp.message);
}
console.log('PASS REQ-5 accessible Japanese English experimental labels');
