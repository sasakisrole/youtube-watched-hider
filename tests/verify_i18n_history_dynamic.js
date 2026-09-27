// Run: node tests/verify_i18n_history_dynamic.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const source = read('history.js');
const ja = JSON.parse(read('_locales/ja/messages.json'));
const en = JSON.parse(read('_locales/en/messages.json'));
const dateOptions = { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' };
const visited = new Set();
// B has its own DOM/port harness; include its exercised keys in the shared coverage check.
for (const key of require('./verify_i18n_history_watch_later').visited) visited.add(key);

function boot(script, locale, language = 'ja') {
  const elements = {};
  const callbacks = {};
  const timers = new Map();
  const dateLocales = [];
  let timerId = 0;
  function element() {
    return {
      textContent: '', value: '', style: {}, children: [], listeners: {}, isConnected: true,
      appendChild(child) { this.children.push(child); },
      addEventListener(type, callback) { this.listeners[type] = callback; },
      remove() { this.isConnected = false; },
      classList: { add() {}, remove() {}, toggle() {} },
    };
  }
  class TestDate extends Date {
    toLocaleString(language, options) {
      dateLocales.push(language);
      return super.toLocaleString(language, options);
    }
  }
  const context = {
    Date: TestDate,
    document: {
      getElementById: id => elements[id] ||= element(),
      querySelectorAll: () => [], createElement: element, createDocumentFragment: element,
    },
    window: { addEventListener() {} },
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    chrome: { runtime: { sendMessage(message, callback) { callbacks[message.type] = callback; } } },
  };
  if (locale !== null) context.chrome.i18n = {
    getUILanguage: () => language,
    getMessage(key, values = []) {
      visited.add(key);
      const entry = locale[key];
      const named = Object.fromEntries(Object.entries(entry?.placeholders || {}).map(([name, value]) => [name.toLowerCase(), value.content]));
      return (entry?.message || '')
        .replace(/\$([A-Za-z0-9_@]+)\$/g, (match, name) => named[name.toLowerCase()] ?? match)
        .replace(/\$(\d+)/g, (_, n) => String(values[n - 1]));
    },
  };
  // Run the shipping A and D blocks, so unrelated maintenance UI needs no doubles.
  const end = script.indexOf('function applyStoredJobState(');
  const start = script.indexOf('// Load data from extension');
  assert(end > 0 && start > end, 'A/D source boundaries must exist');
  vm.createContext(context);
  vm.runInContext(script.slice(0, end) + '\n' + script.slice(start), context);
  return { context, elements, callbacks, timers, dateLocales, element,
    evaluate: code => vm.runInContext(code, context) };
}

function verify(script, english) {
  assert.deepStrictEqual(Object.keys(ja).sort(), Object.keys(english).sort(), 'ja/en key sets differ');
  const keys = [...new Set([...script.matchAll(/'((?:history_)[a-z_]+)'/g)].map(match => match[1]))];
  assert(keys.length > 0, 'dynamic history keys missing');
  for (const key of keys) assert(ja[key] && english[key], `missing key: ${key}`);

  for (const locale of [ja, english, {}, null]) {
    const isEn = locale === english;
    const app = boot(script, locale, isEn ? 'en-US' : 'ja');
    const { context: ctx, elements: el, evaluate } = app;
    app.callbacks.EXPORT_DATA([]);
    assert.strictEqual(el.content.children.at(-1).textContent, isEn
      ? 'No matching videos. Try clearing your search or filters.'
      : '該当する動画はありません。検索語や絞り込みを外してみてください。', 'empty state');
    for (const n of [1, 2]) {
      evaluate(`allData = Array.from({length: ${n}}, (_, i) => ({ videoId: 'id' + i })); sortedCache = []; updateTotalCount();`);
      assert.strictEqual(el.totalCountOf.textContent, isEn ? `(of ${n} video${n === 1 ? '' : 's'})` : `（全${n}件）`, 'total count substitution and plural');
      evaluate(`pendingDeletes = Array.from({length: ${n}}, () => ({})); renderUndoToast();`);
      assert.strictEqual(el.undoToastText.textContent, isEn ? `Removed ${n} video${n === 1 ? '' : 's'} from history` : `${n}件を履歴から削除しました`, 'removed count substitution and plural');
    }
    evaluate('pendingDeletes = []; renderUndoToast();');
    assert.strictEqual(el.undoToast.hidden, true);
    evaluate('sortedCache = allData.slice(); updateTotalCount();');
    assert.strictEqual(el.totalCountOf.textContent, '');

    for (const source of ['seekbar', 'history']) {
      const video = { videoId: 'id-$1', title: '題名 $1 $&', channel: 'チャンネル', watchedAt: 12345, source };
      const row = ctx.buildVideoRow(video);
      const link = row.children[0];
      assert.strictEqual(link.children[0].title, isEn
        ? source === 'seekbar' ? 'Watched detected from seek bar activity' : 'Imported from YouTube watch history'
        : source === 'seekbar' ? 'シークバーの動きから視聴を検出' : 'YouTubeの履歴から取り込み', 'source badge title');
      assert.strictEqual(row.children[1].title, isEn ? 'Remove from history (you can undo for 5 seconds)' : '履歴から削除（削除後5秒は元に戻せます）', 'delete title');
      assert.strictEqual(link.children[1].children[0].textContent, video.title);
      assert.strictEqual(link.children[1].children[1].textContent, video.channel);
      assert.strictEqual(link.children.at(-1).textContent, video.videoId);
    }
    for (const video of [{ videoId: 'id-$1', title: '題名 $1 $&' }, { videoId: 'id-$1' }]) {
      const entry = { video, row: app.element(), allIndex: -1, sortedIndex: -1 };
      ctx.commitDelete(entry);
      app.callbacks.DELETE_VIDEO({ success: false });
      assert.strictEqual(el.fixStatus.textContent, (isEn ? 'Could not remove from history: ' : '履歴から削除できませんでした: ') + (video.title || video.videoId));
    }

    const labels = isEn ? ['Completed', 'Cancelled', 'Interrupted', 'Failed'] : ['完了', '中止', '中断', '失敗'];
    ['done', 'aborted', 'interrupted', 'error'].forEach((state, i) => {
      ctx.renderJob(null, [{ state, label: '処理名 $1' }]);
      assert.strictEqual(el.jobRecentList.children.at(-1).textContent, `${isEn ? 'Unknown date' : '日時不明'} 処理名 $1 — ${labels[i]}`);
    });
    ctx.renderJob(null, [{}]);
    assert.strictEqual(el.jobRecentList.children.at(-1).textContent, isEn ? 'Unknown date Task — Unknown result' : '日時不明 処理 — 結果不明');
    ctx.renderJob(null, [{ kind: 'internalKind', state: 'internalState' }]);
    assert.strictEqual(el.jobRecentList.children.at(-1).textContent, `${isEn ? 'Unknown date' : '日時不明'} internalKind — internalState`);

    ctx.loadData();
    [...app.timers.values()].at(-1)();
    assert.strictEqual(el.content.children.at(-1).textContent, isEn
      ? 'Could not load the data. Reload the extension, then reopen this page.'
      : 'データを読み込めませんでした。拡張機能を再読み込みしてから、開き直してください。');
    for (const message of ['外部エラー $1 $&', undefined]) {
      ctx.loadData();
      app.callbacks.EXPORT_DATA({ __error: true, message });
      const expected = isEn
        ? `Database read error: ${message || 'unknown'}\n\nRecovery steps:\n1. Close all YouTube tabs (close them instead of reloading)\n2. Reload the extension at chrome://extensions\n3. Open YouTube in a new tab, then reload this page`
        : `DB読み込みエラー: ${message || 'unknown'}\n\n復旧手順:\n1. すべてのYouTubeタブを閉じる（リロードではなく閉じる）\n2. chrome://extensions で拡張をリロード\n3. 新しくYouTubeを開いてからこの画面を再読込`;
      assert.strictEqual(el.content.children.at(-1).textContent, expected, 'DB recovery and external message');
    }
    ctx.loadData();
    ctx.chrome.runtime.lastError = { message: '外部 runtime $1' };
    app.callbacks.EXPORT_DATA();
    assert.strictEqual(el.content.children.at(-1).textContent, 'Error: 外部 runtime $1');
    ctx.chrome.runtime.sendMessage = () => { throw new Error('外部 throw $1'); };
    ctx.loadData();
    assert.strictEqual(el.content.children.at(-1).textContent, 'Error: 外部 throw $1');
  }

  const stamp = new Date(2026, 8, 27, 19, 5).getTime();
  for (const language of ['en-US', 'en-GB', 'ja', 'ja-JP']) {
    const app = boot(script, english, language);
    app.context.renderJob(null, [{ endedAt: stamp, label: 'job', state: 'done' }]);
    assert.strictEqual(app.dateLocales.at(-1), language, 'date must use UI language');
    assert.strictEqual(app.elements.jobRecentList.children.at(-1).textContent, `${new Date(stamp).toLocaleString(language, dateOptions)} job — Completed`);
  }
  const fallback = boot(script, null);
  assert.strictEqual(fallback.context.historyUILanguage(), 'ja');
  delete fallback.context.chrome;
  assert.strictEqual(fallback.context.historyMessage('history_empty', '日本語'), '日本語');
  assert.strictEqual(fallback.context.historyUILanguage(), 'ja');
  fallback.context.chrome = { i18n: {} };
  assert.strictEqual(fallback.context.historyMessage('history_empty', '日本語'), '日本語');
  assert.strictEqual(fallback.context.historyUILanguage(), 'ja');
  for (const key of keys) assert(visited.has(key), `unexercised message: ${key}`);
}

verify(source, en);
console.log('PASS REQ-1/2/3/6: A/D rendering, 20 keys, Japanese fallbacks, English plurals, values, UI dates');

// These fixtures prove the behavioral oracle rejects untranslated UI and lost values.
const missingCount = { ...en, history_removed_many: { message: 'Removed videos' } };
assert.throws(() => verify(source, missingCount), /removed count substitution and plural/);
const untranslated = source.replace(
  "historyMessage('history_source_seekbar', 'シークバーの動きから視聴を検出')",
  "'シークバーの動きから視聴を検出'"
);
assert.notStrictEqual(untranslated, source, 'mutation must change the input');
assert.throws(() => verify(untranslated, en), /source badge title/);
console.log('PASS REQ-4: missing-count and Japanese-literal input mutations are rejected');
