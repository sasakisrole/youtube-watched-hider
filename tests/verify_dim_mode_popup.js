const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = file => fs.readFileSync(path.join(process.env.YWH_TEST_ROOT || path.join(__dirname, '..'), file), 'utf8');
const popup = read('popup.js'), html = read('popup.html');
const start = popup.indexOf('// Watched display settings');
const source = popup.slice(start, popup.indexOf('// Load settings', start));
let passed = 0, failed = 0;
function test(name, run) {
  try { run(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message); }
}
test('REQ-1 popup position, accessible toggle and ja/en help', () => {
  const input = html.match(/<input[^>]*id="dimWatched"[^>]*>/);
  assert(input); assert.match(input[0], /type="checkbox"/); assert(!input[0].includes('checked'));
  assert.match(input[0], /aria-labelledby="dimWatchedLabel"/);
  assert.match(input[0], /aria-describedby="dimWatchedDesc"/);
  assert(html.indexOf('id="dimWatched"') > html.indexOf('id="watchedThresholdDesc"'));
  assert(html.indexOf('id="dimWatched"') < html.indexOf('data-i18n="popup_pageVisibility"'));
  for (const lang of ['ja', 'en']) {
    const locale = JSON.parse(read(`_locales/${lang}/messages.json`));
    assert(locale.popup_dimWatched.message);
    assert(locale.popup_dimWatchedHelp.message);
    assert(html.includes('data-i18n="popup_dimWatchedHelp"'));
    if (lang === 'en') assert.equal(locale.popup_dimWatched.message, 'Dim watched videos instead of hiding');
    else assert.equal(locale.popup_dimWatched.message, '視聴済みを半透明で表示する');
  }
});
test('REQ-1 REQ-4 popup strict load and save broadcasts complete settings', () => {
  for (const value of [undefined, null, false, 'true', 1, true]) {
    const elements = {}, stored = { dimWatched: value }, sent = [];
    const scope = {
      document: { getElementById: id => elements[id] ||= { addEventListener(type, cb) { this[type] = cb; } } },
      chrome: { runtime: {}, storage: { local: {
        get(defaults, cb) { cb({ ...defaults, ...stored }); },
        set(values, cb) { Object.assign(stored, values); cb(); },
      } }, tabs: {
        query(filter, cb) { assert.equal(filter.url, '*://*.youtube.com/*'); cb([{ id: 1 }, { id: 2 }]); },
        sendMessage(id, message) { sent.push({ id, message }); return Promise.resolve(); },
      } },
    };
    vm.runInNewContext(source, scope);
    assert.equal(elements.dimWatched.checked, value === true);
    for (const checked of [true, false]) {
      elements.dimWatched.change({ target: { checked } });
      assert.equal(stored.dimWatched, checked);
      assert.equal(sent.at(-1).message.type, 'WATCHED_DISPLAY_SETTINGS_CHANGED');
      assert.equal(sent.at(-1).message.settings.dimWatched, checked);
      assert.equal(sent.at(-1).message.settings.hideOnHome, true);
    }
    assert.equal(sent.length, 4);
  }
});
console.log(`Result: ${passed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0;
