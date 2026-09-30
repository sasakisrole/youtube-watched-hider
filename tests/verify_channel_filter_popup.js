const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const popup = read('popup.js'), html = read('popup.html');
const elements = {}, stored = {}, sent = [];
const element = id => elements[id] ||= { addEventListener(type, cb) { this[type] = cb; } };
const context = { document: { getElementById: element }, chrome: {
  runtime: {}, storage: { local: {
    get(defaults, cb) { cb({ ...defaults, ...stored }); },
    set(values, cb) { Object.assign(stored, values); cb(); },
  } }, tabs: {
    query(filter, cb) { cb([{ id: 1 }, { id: 2 }]); },
    sendMessage(id, message) { sent.push({ id, message }); return Promise.resolve(); },
  },
} };
vm.createContext(context);
vm.runInContext(popup.slice(popup.indexOf('// Watched display settings'), popup.indexOf('// Load settings')), context);
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message); }
}
test('REQ-1 channel toggle order and live broadcast', () => {
  assert(html.indexOf('id="hideOnChannel"') > html.indexOf('id="hideOnSubscriptions"'));
  assert(html.indexOf('id="hideOnChannel"') < html.indexOf('id="hideOnSearch"'));
  assert.equal(elements.hideOnChannel.checked, true);
  elements.hideOnChannel.change({ target: { checked: false } });
  assert.equal(stored.hideOnChannel, false);
  assert.equal(sent.length, 2);
  assert(sent.every(x => x.message.settings.hideOnChannel === false));
});
test('REQ-4 localized channel label and help scope', () => {
  for (const lang of ['ja', 'en']) {
    const messages = JSON.parse(read(`_locales/${lang}/messages.json`));
    assert.equal(messages.popup_hideChannel.message, lang === 'ja' ? '各チャンネルページで隠す' : 'Hide on channel pages');
    const help = messages.popup_pageVisibilityHelp.message;
    assert(help.includes(lang === 'ja' ? '各チャンネルページは' : 'Channel pages means'), 'channel scope sentence');
    assert(html.includes('data-i18n="popup_hideChannel"'));
  }
});
test('REQ-5 search toggle default save and localized help', () => {
  assert(html.indexOf('id="showSearchFilter"') > html.indexOf('id="hideMoviesToggle"'));
  assert.equal(elements.showSearchFilter.checked, true);
  elements.showSearchFilter.change({ target: { checked: false } });
  assert.equal(stored.showSearchFilter, false);
  for (const lang of ['ja', 'en']) {
    const messages = JSON.parse(read(`_locales/${lang}/messages.json`));
    for (const key of ['popup_showSearchFilter', 'popup_showSearchFilterHelp']) {
      assert(messages[key].message);
      assert(html.includes(`data-i18n="${key}"`));
    }
  }
});
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
