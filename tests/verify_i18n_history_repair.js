// Run: node tests/verify_i18n_history_repair.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const source = read('history.js');
const ja = JSON.parse(read('_locales/ja/messages.json'));
const en = JSON.parse(read('_locales/en/messages.json'));
// Independent golden wording and substitution order, including original Japanese.
const expected = {
  history_repair_checking: ['確認中…', 'Checking…'],
  history_repair_preview: ['クレジットの不正値を確認中…', 'Checking invalid credit values…'],
  history_repair_label: ['クレジットの不正値を修復', 'Repair invalid credit values'],
  history_repair_preview_changed: ['別の下見が開始されたため、もう一度確認してください。', 'Another preview has started. Please check again.'],
  history_repair_none: ['修復対象はありません', 'No credit values to repair'],
  history_repair_confirm: ['クレジットの不正値 $1件（$2動画）を修復します。\n内訳: 作曲 $3件 / 作詞 $4件 / 編曲 $5件\n\n不正値を空欄へ戻し、補完対象に復帰させます。元の値は記録に残ります。続行しますか？', 'Repair invalid credit values: $1 (videos: $2).\nBreakdown: composer: $3 / lyricist: $4 / arranger: $5\n\nInvalid values will be cleared so the credits can be filled in again. The original values will remain in the log. Continue?'],
  history_repair_canceled: ['クレジットの不正値修復をキャンセルしました', 'Repairing invalid credit values was canceled'],
  history_repair_running_button: ['修復中…', 'Repairing…'],
  history_repair_running: ['クレジットの不正値を修復中…', 'Repairing invalid credit values…'],
  history_repair_mismatch: ['下見情報が無効になったか対象が変わったため、修復しませんでした。もう一度確認してください。', 'No repairs were made because the preview expired or the targets changed. Please check again.'],
  history_repair_result: ['クレジットの不正値を修復しました: $1件（$2動画）\n自己点検: 残存不正値 $3件 / 記録 $4件 / 正常値の巻き込み $5件 / 復元可能 $6件\nこの自己点検では、判定基準そのものは検証していません。', 'Repaired invalid credit values: $1 (videos: $2)\nSelf-check: invalid values remaining: $3 / logged: $4 / valid values affected: $5 / restorable: $6\nThis self-check does not validate the criteria used to identify invalid values.'],
  history_repair_failed: ['クレジットの不正値修復に失敗しました: $1', 'Failed to repair invalid credit values: $1'],
  history_restore_preview: ['元に戻せるクレジットを確認中…', 'Checking restorable credits…'],
  history_restore_label: ['修復を元に戻す', 'Undo credit repair'],
  history_restore_none_skipped: ['元に戻せるクレジットはありません（現在値が入っているため $1件スキップ）', 'No credits to restore (skipped because a current value exists: $1)'],
  history_restore_none: ['元に戻せるクレジットはありません', 'No credits to restore'],
  history_restore_confirm: ['修復前のクレジット $1件（$2動画）を元に戻します。\n内訳: 作曲 $3件 / 作詞 $4件 / 編曲 $5件\n現在値が入っているため上書きしない役割: $6件\n\n続行しますか？', 'Restore credit values from before the repair: $1 (videos: $2).\nBreakdown: composer: $3 / lyricist: $4 / arranger: $5\nRoles that will not be overwritten because a current value exists: $6\n\nContinue?'],
  history_restore_canceled: ['クレジット修復の取り消しをキャンセルしました', 'Undoing credit repair was canceled'],
  history_restore_running_button: ['復元中…', 'Restoring…'],
  history_restore_running: ['修復前のクレジットを復元中…', 'Restoring credit values from before the repair…'],
  history_restore_mismatch: ['下見情報が無効になったか復元対象が変わったため、復元しませんでした。もう一度確認してください。', 'No credits were restored because the preview expired or the restore targets changed. Please check again.'],
  history_restore_result: ['修復前のクレジットを復元しました: $1件（$2動画） / 上書きせずスキップ $3件', 'Restored credit values from before the repair: $1 (videos: $2) / skipped without overwriting: $3'],
  history_restore_failed: ['クレジット修復の取り消しに失敗しました: $1', 'Failed to undo credit repair: $1'],
  history_repair_external_label: ['クレジット補完（外部DB）', 'Fill in credits (external database)'],
  history_repair_force_label: ['強制上書き補正（表示中の全件）', 'Force overwrite (all displayed videos)'],
  history_duration_confirm_one: ['動画時間補完: $1件の動画時間をwatchページから補完します。続行しますか？\n\n※YouTubeタブを1つ以上開いたままにしてください（Cookie経由でfetchするため）。ライブ動画は -1 として記録します。', 'Fill in durations: Fetch the duration of $1 video from its watch page. Continue?\n\nNote: Keep at least one YouTube tab open (fetching uses cookies). Live videos are recorded as -1.'],
  history_duration_confirm_many: ['動画時間補完: $1件の動画時間をwatchページから補完します。続行しますか？\n\n※YouTubeタブを1つ以上開いたままにしてください（Cookie経由でfetchするため）。ライブ動画は -1 として記録します。', 'Fill in durations: Fetch the durations of $1 videos from their watch pages. Continue?\n\nNote: Keep at least one YouTube tab open (fetching uses cookies). Live videos are recorded as -1.'],
  history_duration_progress: ['処理中... 残り$1/$2（更新$3 / ライブ$4 / 取得失敗$5）', 'Processing... $1/$2 remaining (updated: $3 / live: $4 / fetch failed: $5)'],
  history_duration_label: ['動画の長さを補完', 'Fill in video durations'],
  history_duration_done: ['動画の長さを補完しました', 'Filled in video durations'],
  history_duration_stopped: ['動画の長さの補完を自動停止しました（Googleのbot検知 / 時間を空けて再実行）', 'Filling in video durations stopped automatically (Google bot detection / wait before retrying)'],
  history_duration_aborted: ['動画の長さの補完を中止しました', 'Filling in video durations was canceled'],
  history_duration_result: ['$1: 更新$2 / ライブ$3 / 取得失敗$4 / 処理$5/$6$7', '$1: Updated: $2 / live: $3 / fetch failed: $4 / processed: $5/$6$7'],
};
const reused = {
  history_enrich_busy: ['他のメンテナンス処理が実行中', 'Another maintenance task is running'],
  history_enrich_none: ['対象なし', 'No targets'],
  history_enrich_running_abort: ['実行中…（中止）', 'Running… (Cancel)'],
  history_enrich_failed: ['失敗: $1', 'Failed: $1'],
  history_enrich_aborting_status: ['中止中...', 'Canceling...'],
  history_enrich_aborting_button: ['中止中…', 'Canceling…'],
};
const golden = { ...expected, ...reused };
const format = (text, values) => text.replace(/\$(\d+)/g, (_, n) => String(values[n - 1]));
const translate = (catalog, key, values) => {
  const entry = catalog[key];
  return format((entry?.message || '').replace(/\$([A-Za-z_][A-Za-z0-9_]*)\$/g,
    (_, name) => entry.placeholders[name.toLowerCase()].content), values);
};
const helpers = source.slice(source.indexOf('function historyMessage('), source.indexOf('function updateTotalCount('));
const script = source.slice(source.indexOf("const repairCreditsBtn ="), source.indexOf('// Search (debounced)'));
const visited = new Set();
assert.deepStrictEqual(Object.keys(ja).sort(), Object.keys(en).sort(), 'REQ-1 key sets');
// Synchronous wrapper checks also register coverage for the shared A/B/C/D suite.
for (const locale of [null, ja, en, {}]) {
  const ctx = locale === null ? {} : { chrome: { i18n: {
    getUILanguage: () => locale === en ? 'en' : 'ja',
    getMessage: (key, values) => translate(locale, key, values),
  } } };
  vm.createContext(ctx); vm.runInContext(helpers, ctx);
  for (const [key, wording] of Object.entries(expected)) {
    for (const n of [1, 2]) {
      const values = [n, n + 1, 3, 4, 5, 6, ' [external-$1:7]'];
      assert.strictEqual(ctx.historyMessage(key, format(wording[0], values), values),
        format(wording[locale === en ? 1 : 0], values), key);
    }
    visited.add(key);
  }
}

function boot(locale) {
  const elements = {}, messages = [], confirmations = [], active = [], calls = new Set(), rpc = [];
  let port, enrichOptions;
  const ctx = {
    allData: [], sortedCache: [], runningMaintenance: null,
    document: { getElementById(id) { return elements[id] ||= {
      dataset: {}, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; },
    }; } },
    window: { EnrichCredits: { create(options) { enrichOptions = options; return { open() {}, getAllCandidates() { return []; } }; } } },
    chrome: { runtime: { connect() {
      return port = { sent: [], onMessage: { addListener(fn) { port.receive = fn; } },
        onDisconnect: { addListener(fn) { port.disconnect = fn; } }, postMessage(msg) { this.sent.push(msg); } };
    } } },
    confirmed: true, confirm(text) { confirmations.push(text); return ctx.confirmed; },
    beginMaintenance(kind, options) { active.push(options.activeText); return !ctx.busy; },
    updateRunningMaintenance(kind, options) { active.push(options.activeText); },
    hasRunningMaintenance() { return !!ctx.busy; }, endMaintenance() {},
    showJobMessage(text, options) { messages.push({ text, ...options }); },
    async sendHistoryDbRpc(op, payload) {
      rpc.push({ op, payload });
      if (ctx.error) throw new Error(ctx.error);
      if (op === 'VERIFY_CREDIT_REPAIR') return ctx.verified;
      return payload.dryRun ? ctx.preview : ctx.applied;
    },
    async saveCreditRepairLastRun() {}, loadData() {}, setTimeout() {},
    runFix(ids, force, label) { messages.push({ text: label }); ctx.force = { ids, force }; },
  };
  if (locale) ctx.chrome.i18n = {
    getUILanguage: () => locale === en ? 'en' : 'ja',
    getMessage: (key, values) => translate(locale, key, values),
  };
  vm.createContext(ctx); vm.runInContext(helpers, ctx);
  const original = ctx.historyMessage;
  ctx.historyMessage = (key, fallback, values = []) => {
    assert(golden[key], 'unexpected C2 key: ' + key);
    calls.add(key);
    assert.strictEqual(fallback, format(golden[key][0], values), 'original Japanese: ' + key);
    const translated = original(key, fallback, values);
    assert.strictEqual(translated, format(golden[key][locale === en ? 1 : 0], values), 'translation: ' + key);
    return translated;
  };
  vm.runInContext(script, ctx);
  return { ctx, elements, messages, confirmations, active, calls, rpc,
    click(id) { return elements[id].listeners.click(); },
    emit(msg) { port.receive(msg); }, get port() { return port; },
    notify(text) { enrichOptions.notify(text); },
  };
}

async function main() {
  for (const locale of [null, ja, en, {}]) {
    const a = boot(locale), c = a.ctx, language = locale === en ? 1 : 0;
    for (const id of ['repairCredits', 'restoreCredits']) {
      const restoring = id === 'restoreCredits';
      c.busy = true; await a.click(id); c.busy = false;
      c.preview = { mismatch: true }; await a.click(id);
      for (const skipped of [0, 1, 2]) { c.preview = { values: 0, skipped }; await a.click(id); }
      for (const n of [1, 2]) {
        c.preview = { values: n, videos: n + 1, byRole: { composer: 3, lyricist: 4, arranger: 5 }, skipped: 6, token: 'token-$1' };
        const key = restoring ? 'history_restore_confirm' : 'history_repair_confirm';
        c.confirmed = false; await a.click(id);
        assert.strictEqual(a.confirmations.at(-1), format(expected[key][language], [n, n + 1, 3, 4, 5, 6]));
        c.confirmed = true; c.applied = { mismatch: true }; await a.click(id);
        c.applied = { values: n, videos: n + 1, skipped: 7, runId: 'run-$1' };
        c.verified = { remainingInvalid: 0, loggedTotal: n, loggedStillValid: 0, restorable: n };
        await a.click(id);
        const resultKey = restoring ? 'history_restore_result' : 'history_repair_result';
        assert.strictEqual(a.messages.at(-1).text, format(expected[resultKey][language], restoring ? [n, n + 1, 7] : [n, n + 1, 0, n, 0, n]));
        assert.strictEqual(a.messages.at(-1).state, 'done');
        if (!restoring) {
          c.verified = { remainingInvalid: 8, loggedTotal: 9, loggedStillValid: 10, restorable: 11 };
          await a.click(id);
          assert.strictEqual(a.messages.at(-1).text, format(expected.history_repair_result[language], [n, n + 1, 8, 9, 10, 11]));
          assert.strictEqual(a.messages.at(-1).state, 'error');
        }
        const apply = a.rpc.findLast(call => call.payload.dryRun === false);
        assert.strictEqual(apply.payload.expectedValues, n);
        assert.strictEqual(apply.payload.token, 'token-$1');
      }
      c.error = 'External $1 $&'; await a.click(id); c.error = null;
      assert(a.messages.at(-1).text.endsWith('External $1 $&'), 'raw external error');
    }
    c.runFixDurations([]);
    for (const n of [1, 2]) {
      const ids = Array.from({ length: n }, (_, i) => 'id-' + i);
      c.confirmed = false; c.runFixDurations(ids); c.confirmed = true;
      c.busy = true; c.runFixDurations(ids); c.busy = false;
      for (const outcome of [{}, { aborted: true }, { autoStopped: true, aborted: true }]) {
        c.runFixDurations(ids);
        const key = n === 1 ? 'history_duration_confirm_one' : 'history_duration_confirm_many';
        assert.strictEqual(a.confirmations.at(-1), format(expected[key][language], [n]));
        assert.deepStrictEqual(Array.from(a.port.sent[0].videoIds), ids);
        c.allData = [{ videoId: 'id-0', title: 'Title $1', channel: 'Channel $&' }];
        a.emit({ type: 'PROGRESS', total: n, processed: 1, updated: 3, live: 4, fetchFailed: 5, videoId: 'id-0', wasUpdated: true, durationSec: 123 });
        assert.strictEqual(a.messages.at(-1).text, format(expected.history_duration_progress[language], [n - 1, n, 3, 4, 5]));
        assert.strictEqual(c.allData[0].durationSec, 123);
        assert.strictEqual(c.allData[0].title, 'Title $1');
        assert.strictEqual(c.allData[0].channel, 'Channel $&');
        await a.click('fixDurations'); assert.strictEqual(a.port.sent.at(-1).type, 'ABORT');
        a.emit({ type: 'DONE', updated: 3, live: 4, fetchFailed: 5, processed: n, total: n, failReasons: { 'external-$1': 2 }, ...outcome });
        const prefix = expected[outcome.autoStopped ? 'history_duration_stopped' : outcome.aborted ? 'history_duration_aborted' : 'history_duration_done'][language];
        assert.strictEqual(a.messages.at(-1).text, format(expected.history_duration_result[language], [prefix, 3, 4, 5, n, n, ' [external-$1:2]']));
      }
      for (const error of ['External $1 $&', undefined]) {
        c.runFixDurations(ids); a.emit({ type: 'ERROR', error });
        assert.strictEqual(a.messages.at(-1).text, format(reused.history_enrich_failed[language], [error || 'unknown']));
      }
    }
    c.allData = [{ videoId: 'missing' }, { videoId: 'known', durationSec: 5 }, { videoId: 'failed', durationFetchFailed: 'reason' }];
    await a.click('fixDurations'); assert.deepStrictEqual(Array.from(a.port.sent[0].videoIds), ['missing']); a.port.disconnect();
    for (const id of ['fixDurations', 'fixChannelsForce', 'enrichCredits']) { c.busy = true; await a.click(id); c.busy = false; }
    c.sortedCache = [{ videoId: 'visible' }]; await a.click('fixChannelsForce');
    assert.strictEqual(c.force.force, true); assert.deepStrictEqual(Array.from(c.force.ids), ['visible']);
    await a.click('enrichCredits'); a.notify('External $1 $&');
    assert.strictEqual(a.messages.at(-1).label, expected.history_repair_external_label[language]);
    for (const key of Object.keys(golden)) assert(a.calls.has(key), 'unexercised C2 message: ' + key);
    if (locale === en) {
      for (const text of [...a.confirmations, ...a.active, ...a.messages.flatMap(m => [m.text, m.label || ''])]) {
        assert(!/[\u3040-\u30ff\u3400-\u9fff]/u.test(text), 'untranslated C2 UI: ' + text);
      }
    }
  }
  console.log('PASS REQ-1/2/3: C2 key sets, Japanese fallback, English, counts 1/2, long confirmations, progress, outcomes and external values');
}
module.exports = { visited };
main().catch(error => { console.error(error); process.exitCode = 1; });
