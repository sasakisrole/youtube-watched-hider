// Run: node tests/verify_i18n_history_maintenance.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const source = read('history.js');
const ja = JSON.parse(read('_locales/ja/messages.json'));
const en = JSON.parse(read('_locales/en/messages.json'));
const visited = new Set();
const golden = {
  history_maintenance_running: ['実行中…', 'Running…'],
  history_maintenance_cancel_hint: ['クリックして中止', 'Click to cancel'],
  history_maintenance_locked: ['実行中は閉じられません', 'Cannot close while a task is running'],
  history_maintenance_never: ['最終実行: 未実行', 'Last run: Never'],
  history_maintenance_last_repair: ['最終実行: $1 · $2件（$3動画）を修復', 'Last run: $1 · Repaired credit values: $2 (videos: $3)'],
  history_maintenance_last_restore: ['最終実行: $1 · $2件（$3動画）を元に戻した', 'Last run: $1 · Restored credit values: $2 (videos: $3)'],
  history_enrich_busy: ['他のメンテナンス処理が実行中', 'Another maintenance task is running'],
};
const format = (text, values = []) => text.replace(/\$(\d+)/g, (_, n) => String(values[n - 1]));
const translate = (catalog, key, values) => {
  const entry = catalog[key];
  return format((entry?.message || '').replace(/\$([a-z_]+)\$/gi,
    (_, name) => entry.placeholders[name.toLowerCase()].content), values);
};

function boot(locale, language) {
  const elements = {}, calls = new Set(), numberLocales = [];
  const ctx = {
    persistedRunningMaintenance: null,
    document: { getElementById(id) {
      return elements[id] ||= {
        textContent: id, title: id + ' title', hidden: true,
        span: id === 'fixChannels' ? { textContent: id } : null,
        querySelector() { return this.span; },
        setAttribute() {}, addEventListener() {},
      };
    } },
    localStorage: { getItem() { return '0'; }, setItem() {} },
    recordLocale(value) { numberLocales.push(value); },
  };
  if (locale !== null) ctx.chrome = { i18n: {
    getUILanguage: () => language,
    getMessage: (key, values) => translate(locale, key, values),
  } };
  vm.createContext(ctx);
  vm.runInContext(`
    const originalNumberFormat = Number.prototype.toLocaleString;
    Number.prototype.toLocaleString = function(language) {
      recordLocale(language);
      return originalNumberFormat.call(this, language);
    };
  `, ctx);
  vm.runInContext(source.slice(source.indexOf('function historyMessage('), source.indexOf('function updateTotalCount(')), ctx);
  const original = ctx.historyMessage;
  ctx.historyMessage = (key, fallback, values = []) => {
    assert(golden[key], 'unexpected maintenance key: ' + key);
    assert.strictEqual(fallback, format(golden[key][0], values), 'original Japanese: ' + key);
    calls.add(key);
    visited.add(key);
    return original(key, fallback, values);
  };
  vm.runInContext(source.slice(source.indexOf('const maintenanceButtons ='), source.indexOf('async function loadStoredJobState()')), ctx);
  return { ctx, elements, calls, numberLocales,
    text(id) { const e = elements[id]; return e.span ? e.span.textContent : e.textContent; },
    evaluate(code) { return vm.runInContext(code, ctx); },
  };
}

assert.deepStrictEqual(Object.keys(ja).sort(), Object.keys(en).sort(), 'REQ-1 locale key sets');
for (const [locale, language] of [[null, 'ja'], [ja, 'ja'], [en, 'en'], [{}, 'ja'], [en, 'en-GB']]) {
  const a = boot(locale, language), c = a.ctx, e = a.elements;
  const english = locale === en;
  const expected = key => golden[key][english ? 1 : 0];
  assert.strictEqual(a.evaluate('runningMaintenanceActiveText'), expected('history_maintenance_running'), 'initial running text');
  c.updateMaintenanceButtons();
  assert.strictEqual(a.text('fixChannels'), 'fixChannels');
  assert.strictEqual(c.beginMaintenance('fixChannels', { allowAbort: true }), true);
  assert.strictEqual(a.text('fixChannels'), expected('history_maintenance_running'), 'begin running text');
  assert.strictEqual(e.fixChannels.title, expected('history_maintenance_cancel_hint'), 'cancel hint');
  assert.strictEqual(e.fixCredits.title, expected('history_enrich_busy'), 'busy hint');
  assert.strictEqual(e.fixCredits.disabled, true);
  assert.strictEqual(e.maintToggle.title, expected('history_maintenance_locked'), 'locked hint');
  assert.strictEqual(e.maintPanel.hidden, false);
  assert.strictEqual(c.beginMaintenance('fixCredits'), false);
  c.updateRunningMaintenance('fixChannels', { activeText: 'Custom $1', allowAbort: false });
  assert.strictEqual(a.text('fixChannels'), 'Custom $1');
  assert.strictEqual(e.fixChannels.disabled, true);
  assert.strictEqual(e.fixChannels.title, 'fixChannels title');
  c.endMaintenance('fixChannels');
  assert.strictEqual(a.evaluate('runningMaintenanceActiveText'), expected('history_maintenance_running'), 'reset running text');
  assert.strictEqual(a.text('fixChannels'), 'fixChannels');
  assert.strictEqual(e.maintToggle.title, '');
  c.persistedRunningMaintenance = 'fixCredits';
  c.updateMaintenanceButtons();
  assert.strictEqual(a.text('fixCredits'), expected('history_maintenance_running'), 'persisted running text');
  assert.strictEqual(e.fixCredits.disabled, true);
  c.persistedRunningMaintenance = null;
  c.beginMaintenance('scanWatchLater');
  assert.strictEqual(e.maintToggle.disabled, false);
  assert.strictEqual(e.maintToggle.title, '');
  c.endMaintenance('scanWatchLater');

  for (const record of [null, {}, { kind: 'other' }, ...[undefined, 0, -1, NaN, Infinity, 'bad'].map(at => ({ kind: 'repair', at }))]) {
    c.renderCreditRepairLastRun(record);
    assert.strictEqual(e.repairLastRun.textContent, expected('history_maintenance_never'), 'never run');
  }
  const at = new Date(2026, 8, 27, 9, 5).getTime();
  for (const kind of ['repair', 'restore']) {
    for (const [values, videos, formattedValues, formattedVideos] of [
      [0, 0, '0', '0'], [1, 2, '1', '2'], [12345, 6789, '12,345', '6,789'],
      [-5, 'bad', '0', '0'], ['1234.9', 56.8, '1,234', '56'],
    ]) {
      c.renderCreditRepairLastRun({ kind, at, values, videos });
      const key = 'history_maintenance_last_' + kind;
      assert.strictEqual(e.repairLastRun.textContent,
        format(expected(key), ['2026-09-27 09:05', formattedValues, formattedVideos]),
        'last run wording and count substitutions: ' + kind);
    }
  }
  assert.strictEqual(a.numberLocales.length, 20);
  assert(a.numberLocales.every(value => value === language), 'counts must use historyUILanguage()');
  for (const key of Object.keys(golden)) assert(a.calls.has(key), 'unexercised message: ' + key);
}
module.exports = { visited };
console.log('PASS REQ-1/2/3: maintenance states, ja/fallback/en, repair/restore, count substitutions and UI number locale');
