// Run: node tests/verify_i18n_content.js
// Execute shipped display functions with a small DOM and Chrome catalog stub.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const source = read('content.js');
const ja = JSON.parse(read('_locales/ja/messages.json'));
const en = JSON.parse(read('_locales/en/messages.json'));
const keys = [...new Set([...source.matchAll(/contentMessage\('([^']+)'/g)].map(m => m[1]))];
assert(keys.length > 0, 'content.js must use localized display keys');
const slots = s => [...s.matchAll(/\$(\d+)/g)].map(m => m[1]).sort();
for (const key of keys) {
  assert(ja[key] && en[key], `missing ja/en key: ${key}`);
  assert.deepEqual(slots(ja[key].message), slots(en[key].message), key);
}
function fn(name) {
  const match = source.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  }`));
  assert(match, `missing function ${name}`);
  return match[0];
}
const names = ['contentMessage', 'showReloadNotice', 'showImportToast', 'renderHarvestStatus',
  'ensureHarvestUI', 'buildBulkConfirmMessage', 'updateQueueButtonLabel', 'onQueueAllClick',
  'updateWatchLaterButtonLabel', 'onWatchLaterClick'];
function boot(locale) {
  const output = [], calls = new Set(), nodes = [];
  function element() {
    const children = {}, el = { style: {}, appendChild() {}, setAttribute() {}, addEventListener() {}, remove() {},
      querySelector: s => children[s] ||= element() };
    for (const prop of ['textContent', 'innerHTML']) Object.defineProperty(el, prop, {
      set(value) { this['_' + prop] = value; output.push(value); }, get() { return this['_' + prop]; }
    });
    nodes.push(el);
    return el;
  }
  const scope = { document: { createElement: element, getElementById: () => null, body: element(), head: element() },
    chrome: {}, location: { reload() {} }, console, setTimeout() {}, clearTimeout() {}, requestAnimationFrame: cb => cb(),
    confirm: text => { output.push(text); return true; }, sleep: async () => {},
    getBulkPageContext: () => 'watch', findQueueableCards: () => [1, 2], findWatchLaterableCards: () => [1, 2],
    seedQueueWithCurrentVideo: async () => {}, queueOneCard: async c => ({ ok: c === 1 }),
    watchLaterOneCard: async c => ({ ok: c === 1 }), isHistoryPage: () => true,
    startHarvest() {}, stopHarvest() {}, element };
  if (locale !== null) scope.chrome.i18n = { getMessage(key, values = []) {
    calls.add(key);
    if (locale === 'throws') throw new Error('Extension context invalidated');
    if (!locale[key]) return '';
    assert.equal(values.length, Math.max(0, ...slots(locale[key].message).map(Number)), key);
    assert(values.every(v => typeof v === 'string'));
    return locale[key].message.replace(/\$(\d+)/g, (_, n) => values[n - 1]);
  } };
  vm.createContext(scope);
  vm.runInContext(`
    let contextInvalidated = false, harvestMode = true;
    const reloadNoticeId = 'reload', BULK_LARGE_COUNT_THRESHOLD = 100;
    const toastState = { el: null, count: 0, timer: null };
    const harvest = { ui: null, running: false, added: 0, scanned: 0, noNewStreak: 0 };
    let queueAllBtn = element(), watchLaterBtn = element();
    let queueInProgress = false, watchLaterInProgress = false, queueAbort = false, watchLaterAbort = false;
    let queueButtonContext = null, watchLaterButtonContext = null;
    ${names.map(fn).join('\n')}
    const originalMessage = contentMessage;
    contentMessage = (key, fallback, values) => {
      const result = originalMessage(key, fallback, values);
      if (${locale !== en}) {
        if (result !== fallback) throw new Error('Legacy fallback changed: ' + key);
      }
      return result;
    };
  `, scope);
  return { scope, output, calls, run: s => vm.runInContext(s, scope) };
}
(async () => {
  for (const locale of [en, ja, {}, null, 'throws']) {
    const app = boot(locale);
    app.run('showReloadNotice(); ensureHarvestUI();');
    for (const n of [0, 1, 2, 1234]) {
      app.run(`showImportToast(${n}); harvest.added = ${n}; harvest.scanned = ${n};
        harvest.running = true; harvest.noNewStreak = 0; renderHarvestStatus();
        harvest.noNewStreak = 2; renderHarvestStatus(); harvest.running = false;
        harvest.endReason = 'auto'; renderHarvestStatus(); harvest.endReason = 'user'; renderHarvestStatus();
        updateQueueButtonLabel(); updateWatchLaterButtonLabel();
        queueButtonContext = watchLaterButtonContext = 'playlist';
        updateQueueButtonLabel(); updateWatchLaterButtonLabel();
        queueButtonContext = watchLaterButtonContext = null;`);
      for (const kind of ['queue', 'watchLater']) for (const context of ['watch', 'channel', 'playlist']) {
        app.output.push(app.run(`buildBulkConfirmMessage('${kind}', ${n}, '${context}')`));
      }
    }
    await app.run('onQueueAllClick()');
    await app.run('onWatchLaterClick()');
    app.scope.queueOneCard = app.scope.watchLaterOneCard = async () => ({ ok: true });
    await app.run('onQueueAllClick()');
    await app.run('onWatchLaterClick()');
    await app.run('queueInProgress = true; onQueueAllClick()');
    await app.run('watchLaterInProgress = true; onWatchLaterClick()');
    if (locale === en) {
      for (const text of app.output) assert(!/[\u3040-\u30ff\u3400-\u9fff]|undefined|\$\d/.test(text), text);
      for (const key of keys) assert(app.calls.has(key), `display key not exercised: ${key}`);
      assert(app.output.includes('Added to watched: +1'));
      assert(app.output.includes('Done: 1 added / 1 failed'));
      assert(app.output.includes('Done: 2 added'));
    } else {
      assert(app.output.includes('+1件 視聴済みに取り込み'));
      assert(app.output.includes('追加中 1/2(クリックで中止)'));
      assert(app.output.includes('追加中 1/2（クリックで中止）'));
      assert(app.output.includes('完了: 1件追加 / 1件失敗'));
      assert(app.output.includes('完了: 2件追加'));
      assert(app.output.includes('再読み込み'));
      assert(app.output.includes('中止中...'));
    }
  }
  console.log(`PASS content i18n: ${keys.length} keys, substitutions, real displays, Japanese fallbacks`);
})().catch(error => { console.error(error); process.exitCode = 1; });
