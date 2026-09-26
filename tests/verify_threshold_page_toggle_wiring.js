const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const content = process.argv.includes('--baseline-stdin') ? fs.readFileSync(0, 'utf8') : read('content.js');
const popup = read('popup.js'), html = read('popup.html');
function block(src, a, b) {
  const start = src.indexOf(a), end = src.indexOf(b, start);
  assert(start >= 0 && end > start, a);
  return src.slice(start, end);
}
const stored = {}, elements = {}, sent = [];
const element = id => elements[id] ||= { addEventListener(type, cb) { this[type] = cb; } };
const sandbox = {
  document: { getElementById: element },
  showStatus() { throw new Error('unexpected storage error'); },
  chrome: {
    runtime: {},
    storage: { local: {
      get(defaults, cb) { cb({ ...defaults, ...stored }); },
      set(values, cb) { Object.assign(stored, values); cb(); },
    } },
    tabs: {
      query(filter, cb) { assert.equal(filter.url, '*://*.youtube.com/*'); cb([{ id: 11 }, { id: 22 }]); },
      sendMessage(id, message) { sent.push({ id, message }); return Promise.resolve(); },
    },
  },
};
vm.createContext(sandbox);
vm.runInContext(block(popup, '// Watched display settings', '// Load settings'), sandbox);
assert.equal(elements.watchedThreshold.value, 95);
for (const key of ['hideOnHome', 'hideOnSubscriptions', 'hideOnSearch', 'hideOnRelated']) {
  assert.equal(elements[key].checked, true);
  assert(html.includes(`aria-labelledby="${key}Label"`));
}
elements.watchedThreshold.valueAsNumber = 80;
elements.watchedThreshold.change();
assert.equal(stored.watchedThreshold, 80);
elements.hideOnSearch.change({ target: { checked: false } });
assert.equal(stored.hideOnSearch, false);
assert.equal(sent.length, 4);
assert.equal(sent[3].message.settings.watchedThreshold, 80);
assert.equal(sent[3].message.settings.hideOnSearch, false);
assert.equal(sent[3].message.settings.hideOnHome, true);
elements.watchedThreshold.valueAsNumber = NaN;
elements.watchedThreshold.change();
assert.equal(stored.watchedThreshold, 95);
assert.equal(elements.watchedThreshold.value, 95);

const cards = [{ style: { display: 'none' }, dataset: { watchedHidden: 'true', watchedVideoId: 'x', watchedCheckedId: 'x' } }];
const page = {
  location: { pathname: '/results' }, enabled: true, calls: 0,
  document: { querySelectorAll: () => cards },
  showAllShorts() {}, showAllMovies() {}, hideShortsCards() {}, hideMovieCards() {},
  processPage() { page.calls++; },
};
vm.createContext(page);
vm.runInContext(block(content, '  // Watched display settings', '  let recordWhileOff') +
  block(content, '  function hideCard(', '  function showCardsForVideoIds(') +
  'function receive(message) {\n' + block(content,
    "    if (message.type === 'WATCHED_DISPLAY_SETTINGS_CHANGED')",
    "    if (message.type === 'RECORD_WHILE_OFF_CHANGED')") + '\n}', page);
page.receive(sent[3].message);
assert.equal(cards[0].style.display, '');
assert.equal(cards[0].dataset.watchedCheckedId, undefined);
page.hideCard(cards[0], 'x');
assert.equal(cards[0].style.display, '');
assert.equal(page.calls, 1);
page.receive({ type: 'WATCHED_DISPLAY_SETTINGS_CHANGED', settings: {} });
page.hideCard(cards[0], 'x');
assert.equal(cards[0].style.display, 'none');
page.enabled = false;
page.receive(sent[3].message);
assert.equal(page.calls, 2, 'main OFF must not start page processing');

// Exercise the actual initial storage callback, not just the normalizer.
page.chrome = { storage: { local: { get(defaults, cb) { cb({ ...defaults, watchedThreshold: 80, hideOnHome: false }); } } } };
page.contextInvalidated = false;
page.detectContextInvalidation = () => false;
page.isHistoryPage = () => false;
vm.runInContext(block(content, '  if (!contextInvalidated) chrome.storage.local.get(', '  // Returns true if the card'), page);
assert.equal(vm.runInContext('WATCHED_THRESHOLD', page), 80);
page.location.pathname = '/';
page.hideCard(cards[0], 'x');
assert.equal(cards[0].style.display, '');
console.log('PASS popup load/save/validation, broadcast to all tabs, live restore/re-hide, main OFF, content storage load');
