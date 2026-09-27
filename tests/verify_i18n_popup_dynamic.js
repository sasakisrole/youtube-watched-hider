const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const source = read('popup.js');
const ja = JSON.parse(read('_locales/ja/messages.json'));
const en = JSON.parse(read('_locales/en/messages.json'));
const japanese = /[\u3040-\u30ff\u3400-\u9fff]/;
function boot(locale, language = 'en-US') {
  const elements = {};
  const callbacks = {};
  const calls = [];
  const element = id => elements[id] ||= {
    textContent: '', style: {}, value: '', listeners: {},
    addEventListener(type, cb) { this.listeners[type] = cb; },
    setAttribute() {}, appendChild() {},
  };
  const context = {
    document: { getElementById: element, querySelectorAll: () => [], createElement: element },
    chrome: {
      runtime: { sendMessage(msg, cb) { if (cb) callbacks[msg.type] = cb; }, getManifest: () => ({ version: 'test' }) },
      storage: { local: { get() {}, set() {} } },
    },
    setTimeout() {}, clearTimeout() {}, confirm: () => false,
  };
  if (locale !== null) context.chrome.i18n = {
    getUILanguage: () => language,
    getMessage(key, values = []) {
      calls.push({ key, values });
      // Expand named placeholders first, as Chrome does, then count positional substitutions.
      const entry = locale[key];
      const placeholders = Object.fromEntries(Object.entries(entry?.placeholders || {}).map(([n, v]) => [n.toLowerCase(), v.content]));
      const message = (entry?.message || '').replace(/\$([A-Za-z0-9_@]+)\$/g, (m, n) => placeholders[n.toLowerCase()] ?? m);
      const expected = Math.max(0, ...[...message.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
      if (entry) assert.strictEqual(values.length, expected, `argument count: ${key}`);
      return message.replace(/\$(\d+)/g, (_, n) => String(values[n - 1]));
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { context, elements, callbacks, calls };
}
const english = boot(en);
english.callbacks.GET_STATS({ count: 1, dbStatus: 'ready', positiveCacheSize: 1, cacheMode: 'full' });
assert(!japanese.test(english.elements.dbStatus.textContent), 'English DB status contains Japanese');
assert(!japanese.test(english.context.renderImportDiff({ watched: { add: 1 }, invalid: { watched: 1 } })), 'English counts contain Japanese');
const keys = [...source.matchAll(/(?:popupMessage|message)\('([^']+)'/g)].map(m => m[1]);
assert(keys.length > 0, 'dynamic message keys must exist');
for (const m of read('popup.html').matchAll(/data-i18n(?:-[\w-]+)?="([^"]+)"/g)) keys.push(m[1]);
for (const m of source.matchAll(/chrome\.i18n\.getMessage\('([^']+)'/g)) keys.push(m[1]);
for (const key of new Set(keys)) assert(ja[key] && en[key], `missing ja/en key: ${key}`);
const slots = text => [...text.matchAll(/\$(\d+)/g)].map(m => m[1]).sort();
for (const key of Object.keys(ja)) {
  assert(en[key], `missing English key: ${key}`);
  assert.deepStrictEqual(slots(ja[key].message), slots(en[key].message), `substitutions: ${key}`);
}
for (const locale of [ja, {}, null]) {
  const app = boot(locale, 'ja');
  app.callbacks.GET_STATS({ count: 1, dbStatus: 'loading' });
  assert.strictEqual(app.elements.dbStatus.textContent, 'DB 読み込み中...');
  assert.strictEqual(app.context.renderImportDiff({}), '視聴履歴: 追加 0 / 更新 0（置換すると 0 件削除）\n高評価: 追加 0 / 更新 0（置換すると 0 件削除）');
  assert.strictEqual(app.context.formatImportResult({ count: 1 }, '置換').text, '置換: 1件');
  assert.strictEqual(app.context.formatMergeImportStatus({ added: 1, skipped: 0 }).text, '統合しました: 新規 1件 / 既存 0件');
}
for (const n of [0, 1, 2, 1234]) {
  const response = { count: n, added: n, skipped: n, liked: { imported: n }, removed: { watched: n }, dropped: { watched: n, likedStructural: true, likedMetaStructural: true } };
  for (const result of [english.context.formatImportResult(response, 'Replace'), english.context.formatMergeImportStatus(response)]) {
    assert(!japanese.test(result.text), result.text);
    assert(!/undefined|\$\d/.test(result.text), result.text);
  }
  response.liked = { failed: true };
  assert(!japanese.test(english.context.formatImportResult(response, 'Replace').text));
  assert(!japanese.test(english.context.formatMergeImportStatus(response).text));
}
assert(english.calls.some(c => c.values.length > 0), 'count substitutions must reach getMessage');
console.log(`PASS dynamic popup i18n: ${new Set(keys).size} referenced keys, substitutions, English status/counts, Japanese fallback`);

// Exercise the actual settings callback, not just the date helper.
const stamp = new Date(2026, 8, 27, 9, 5).getTime();
for (const language of ['en-US', 'en-GB', 'ja', 'ja-JP']) {
  const isJa = language.startsWith('ja');
  const app = boot(isJa ? ja : en, language);
  app.callbacks.GET_ENABLED({ lastBackup: stamp, lastBackupCount: 1, nextBackup: stamp });
  const expected = isJa ? '9/27 9:05' : new Intl.DateTimeFormat(language, { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(stamp);
  assert(app.elements.lastBackupInfo.textContent.includes(expected));
  assert(app.elements.nextBackupInfo.textContent.includes(isJa ? '9/27 09:05' : expected));
  if (isJa) {
    assert.strictEqual(app.elements.lastBackupInfo.textContent, '（最終 9/27 9:05・1件）');
    assert.strictEqual(app.context.formatDateGroup(stamp), '2026/09/27 (Sun)');
    assert.strictEqual(app.context.formatTime(stamp), '09:05');
  } else {
    assert(!japanese.test(app.elements.lastBackupInfo.textContent));
    assert.strictEqual(app.context.formatTime(stamp), new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit' }).format(stamp));
  }
}
// Validate Japanese catalog text against each real call's legacy fallback.
for (const locale of [ja, en, {}, null]) {
  const app = boot(locale, locale === en ? 'en-US' : 'ja');
  const confirmations = [];
  app.context.confirm = text => { confirmations.push(text); return true; };
  const originalMessage = app.context.popupMessage;
  app.context.popupMessage = (key, fallback, values = []) => {
    if (locale === ja) assert.strictEqual(originalMessage(key, fallback, values), fallback, `Japanese changed: ${key}`);
    return originalMessage(key, fallback, values);
  };
  const click = id => app.elements[id].listeners.click();
  for (const id of ['clearWatchedBtn', 'clearLikedBtn', 'clearAllBtn', 'importReplaceBtn']) click(id);
  assert.strictEqual(confirmations.length, 5);
  if (locale === en) confirmations.forEach(text => assert(!japanese.test(text), text));
  else assert(confirmations[0].startsWith('視聴履歴（watched）を全て削除します。'));
  for (const type of ['CLEAR_DATA', 'CLEAR_LIKED_ALL', 'CLEAR_ALL']) {
    app.callbacks[type]({ success: false, reason: 'backup_failed' });
    app.callbacks[type]({ success: false, error: 'test error' });
  }
  click('backupNowBtn');
  for (const response of [null, { success: true, counts: { watchedVideos: 1, likedVideos: 2 } }, { reason: 'no_data' }, { error: 'test error' }]) {
    app.callbacks.BACKUP_NOW(response);
    if (locale === en) assert(!japanese.test(app.elements.status.textContent));
  }
  for (const dbStatus of ['ready', 'loading', 'error']) {
    app.callbacks.GET_STATS({ count: 2, dbStatus, dbOwner: 'offscreen', cacheUnavailable: true, positiveCacheSize: 1 });
    if (locale === en) assert(!japanese.test(app.elements.dbStatus.textContent + app.elements.cacheDetail.textContent));
  }
  // FileReader and messages are in-memory doubles; no database or real files are used.
  app.context.FileReader = class { readAsText() { this.onload({ target: { result: '[]' } }); } };
  app.elements.syncFileInput.listeners.change({ target: { files: [{}] } });
  if (locale === en) assert.strictEqual(app.elements.syncStatus.textContent, 'Merging records: 0...');
  app.callbacks.MERGE_IMPORT({ success: true, added: 1, skipped: 2 });
  if (locale === en) assert(!japanese.test(app.elements.syncStatus.textContent));
  for (const n of [0, 1, 2]) {
    app.context.renderImportDiff({ watched: { add: n }, invalid: { watched: n, likedStructural: true, likedMetaStructural: true } });
    app.context.formatImportResult({ count: n, liked: { failed: true }, removed: { watched: n }, dropped: { watched: n, likedStructural: true, likedMetaStructural: true } }, 'Restore');
    app.context.formatMergeImportStatus({ added: n, skipped: n, liked: { imported: n }, dropped: { watched: n, likedStructural: true, likedMetaStructural: true } });
  }
}
// Message content must not interpret dollar signs in replacement values.
assert.strictEqual(english.context.popupMessage('popupDynamicInternalError', 'fallback', ['$1 $&']), 'Extension internal error: $1 $&');
console.log('PASS backup dates, dialogs, backup results, sync callbacks, exact Japanese fallbacks and substitution arity');
