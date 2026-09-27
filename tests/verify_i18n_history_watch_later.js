// Run: node tests/verify_i18n_history_watch_later.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const source = read('history.js');
const ja = JSON.parse(read('_locales/ja/messages.json'));
const en = JSON.parse(read('_locales/en/messages.json'));
// Golden Japanese wording from the original B block, plus English expectations.
const expected = {
  "history_wl_no_tab": {
    "ja": "YouTubeのタブを開いた状態で実行してください",
    "en": "Open a YouTube tab before continuing"
  },
  "history_wl_no_items": {
    "ja": "後で見るに動画が見つかりません（ログイン状態を確認してください）",
    "en": "No videos found in Watch Later (check that you are signed in)"
  },
  "history_wl_db_failed": {
    "ja": "視聴済みデータベースを確認できないため中止しました",
    "en": "Stopped because the watched database could not be checked"
  },
  "history_wl_fetch_failed": {
    "ja": "後で見るのページを取得できませんでした",
    "en": "Could not load the Watch Later page"
  },
  "history_wl_scanning": {
    "ja": "照合中…",
    "en": "Scanning…"
  },
  "history_wl_busy": {
    "ja": "他のメンテナンス処理が実行中",
    "en": "Another maintenance task is running"
  },
  "history_wl_scan_running": {
    "ja": "後で見るを照合中…",
    "en": "Scanning Watch Later…"
  },
  "history_wl_scan_label": {
    "ja": "照合",
    "en": "Scan"
  },
  "history_wl_partial": {
    "ja": "※全件を取得しきれていません",
    "en": "Note: Some videos could not be retrieved"
  },
  "history_wl_no_scan": {
    "ja": "先に「照合」を実行してください",
    "en": "Run Scan first"
  },
  "history_wl_expired": {
    "ja": "照合から時間が経ちました。もう一度「照合」してから実行してください",
    "en": "The scan has expired. Run Scan again before continuing"
  },
  "history_wl_stale": {
    "ja": "照合結果が新しくなっています。もう一度「照合」してください",
    "en": "The scan results have changed. Run Scan again"
  },
  "history_wl_mismatch": {
    "ja": "確認した動画と削除対象が一致しないため中止しました",
    "en": "Stopped because the confirmed video does not match the removal target"
  },
  "history_wl_no_id": {
    "ja": "削除に必要なIDが取れていないため中止しました",
    "en": "Stopped because the ID required for removal is missing"
  },
  "history_wl_session_changed": {
    "ja": "YouTubeのタブまたはアカウントが変わったため中止しました",
    "en": "Stopped because the YouTube tab or account changed"
  },
  "history_wl_tab_unavailable": {
    "ja": "開始時のYouTubeタブが閉じたか応答しないため中止しました",
    "en": "Stopped because the original YouTube tab was closed or is not responding"
  },
  "history_wl_unconfirmed": {
    "ja": "YouTubeが成功を返さなかったため、消えたかどうか不明です。照合し直して確認してください",
    "en": "YouTube did not confirm success, so removal is uncertain. Run Scan again to check"
  },
  "history_wl_deleting": {
    "ja": "削除中…",
    "en": "Removing…"
  },
  "history_wl_truncated": {
    "ja": "（候補が多いため先頭200件のみ表示・削除できるのもこの200件まで）",
    "en": " (only the first 200 candidates are shown and can be removed)"
  },
  "history_wl_reassigned": {
    "ja": "削除IDが振り直されたため中止しました（想定外の変化です）",
    "en": "Stopped because removal IDs were reassigned (an unexpected change)"
  },
  "history_wl_rescan_failed": {
    "ja": "途中の再照合に失敗したため中止しました",
    "en": "Stopped because a scan during removal failed"
  },
  "history_wl_batch_expired": {
    "ja": "照合から時間が経ったため中止しました",
    "en": "Stopped because the scan expired"
  },
  "history_wl_batch_tab": {
    "ja": "YouTubeのタブが閉じたか応答しないため中止しました",
    "en": "Stopped because the YouTube tab was closed or is not responding"
  },
  "history_wl_batch_unconfirmed": {
    "ja": "YouTubeが成功を返さなかったため中止しました。照合し直して確認してください",
    "en": "Stopped because YouTube did not confirm success. Run Scan again to check"
  },
  "history_wl_no_targets": {
    "ja": "削除できる対象がありませんでした",
    "en": "There were no videos that could be removed"
  },
  "history_wl_scan_lost": {
    "ja": "照合結果が失われたため中止しました",
    "en": "Stopped because the scan results were lost"
  },
  "history_wl_batch_label": {
    "ja": "まとめて削除",
    "en": "Bulk removal"
  },
  "history_wl_final_scan_failed": {
    "ja": "※削除後の再照合に失敗したため、件数は未確認です",
    "en": "Note: Counts are unverified because the scan after removal failed"
  },
  "history_wl_interrupted": {
    "ja": "中断しました。照合し直して結果を確認してください",
    "en": "Interrupted. Run Scan again to check the results"
  },
  "history_wl_timeout": {
    "ja": "応答がないため中断しました。どこまで削除できたかは照合し直して確認してください",
    "en": "Interrupted because there was no response. Run Scan again to check how many videos were removed"
  },
  "history_wl_failure": {
    "ja": "失敗: $1",
    "en": "Failed: $1"
  },
  "history_wl_total_one": {
    "ja": "後で見る $1件",
    "en": "Watch Later: $1 video"
  },
  "history_wl_total_many": {
    "ja": "後で見る $1件",
    "en": "Watch Later: $1 videos"
  },
  "history_wl_matched_one": {
    "ja": "視聴済み一致 $1件",
    "en": "Watched matches: $1 video"
  },
  "history_wl_matched_many": {
    "ja": "視聴済み一致 $1件",
    "en": "Watched matches: $1 videos"
  },
  "history_wl_unwatched_one": {
    "ja": "未視聴 $1件",
    "en": "Unwatched: $1 video"
  },
  "history_wl_unwatched_many": {
    "ja": "未視聴 $1件",
    "en": "Unwatched: $1 videos"
  },
  "history_wl_indeterminate_one": {
    "ja": "判定不能 $1件",
    "en": "Undetermined: $1 video"
  },
  "history_wl_indeterminate_many": {
    "ja": "判定不能 $1件",
    "en": "Undetermined: $1 videos"
  },
  "history_wl_missing_id_one": {
    "ja": "削除ID未取得 $1件",
    "en": "Missing removal IDs: $1 video"
  },
  "history_wl_missing_id_many": {
    "ja": "削除ID未取得 $1件",
    "en": "Missing removal IDs: $1 videos"
  },
  "history_wl_duplicates_one": {
    "ja": "重複登録 $1件",
    "en": "Duplicate entries: $1 video"
  },
  "history_wl_duplicates_many": {
    "ja": "重複登録 $1件",
    "en": "Duplicate entries: $1 videos"
  },
  "history_wl_drift": {
    "ja": "前回比 残存$1件/削除ID変化$2件",
    "en": "Since last scan — remaining: $1 / changed removal IDs: $2"
  },
  "history_wl_scanned": {
    "ja": "後で見るを照合しました: $1",
    "en": "Watch Later scan complete: $1"
  },
  "history_wl_confirm_one": {
    "ja": "次の1本を「後で見る」から削除します。取り消せません。\n\n$1$2",
    "en": "Remove this video from Watch Later? This cannot be undone.\n\n$1$2"
  },
  "history_wl_removed_single": {
    "ja": "後で見るから1件だけ削除しました: $1 / 残りを消すにはもう一度「照合」",
    "en": "Removed 1 video from Watch Later: $1 / Run Scan again to remove more"
  },
  "history_wl_panel_note_one": {
    "ja": "視聴済みとして記録がある$1件です$2。上から順に削除します。取り消せません。",
    "en": "$1 video is recorded as watched$2. Videos will be removed from the top down. This cannot be undone."
  },
  "history_wl_panel_note_many": {
    "ja": "視聴済みとして記録がある$1件です$2。上から順に削除します。取り消せません。",
    "en": "$1 videos are recorded as watched$2. Videos will be removed from the top down. This cannot be undone."
  },
  "history_wl_run_all_one": {
    "ja": "全$1件を削除",
    "en": "Remove $1 video"
  },
  "history_wl_run_all_many": {
    "ja": "全$1件を削除",
    "en": "Remove all $1 videos"
  },
  "history_wl_stopped": {
    "ja": "中止: $1",
    "en": "Stopped: $1"
  },
  "history_wl_more_one": {
    "ja": "\n… ほか$1件",
    "en": "\n… and $1 more video"
  },
  "history_wl_more_many": {
    "ja": "\n… ほか$1件",
    "en": "\n… and $1 more videos"
  },
  "history_wl_confirm_all_one": {
    "ja": "「後で見る」から一覧の全$1件を削除します。取り消せません。\n\n$2$3",
    "en": "Remove the $1 video in the list from Watch Later? This cannot be undone.\n\n$2$3"
  },
  "history_wl_confirm_all_many": {
    "ja": "「後で見る」から一覧の全$1件を削除します。取り消せません。\n\n$2$3",
    "en": "Remove all $1 videos in the list from Watch Later? This cannot be undone.\n\n$2$3"
  },
  "history_wl_confirm_limited_one": {
    "ja": "「後で見る」から$1件を削除します。取り消せません。\n\n$2$3",
    "en": "Remove $1 video from Watch Later? This cannot be undone.\n\n$2$3"
  },
  "history_wl_confirm_limited_many": {
    "ja": "「後で見る」から$1件を削除します。取り消せません。\n\n$2$3",
    "en": "Remove $1 videos from Watch Later? This cannot be undone.\n\n$2$3"
  },
  "history_wl_progress_title": {
    "ja": "$1 / $2 件目: $3",
    "en": "Video $1 of $2: $3"
  },
  "history_wl_progress_one": {
    "ja": "削除中... $1/$2件（削除$1件）",
    "en": "Removing... $1/$2 ($1 video removed)"
  },
  "history_wl_progress_many": {
    "ja": "削除中... $1/$2件（削除$1件）",
    "en": "Removing... $1/$2 ($1 videos removed)"
  },
  "history_wl_removed_one": {
    "ja": "後で見るから$1件をまとめて削除しました",
    "en": "Removed $1 video from Watch Later"
  },
  "history_wl_removed_many": {
    "ja": "後で見るから$1件をまとめて削除しました",
    "en": "Removed $1 videos from Watch Later"
  },
  "history_wl_remaining": {
    "ja": "残り: 後で見る $1件 / 視聴済み一致 $2件 / 未視聴 $3件",
    "en": "Remaining — Watch Later: $1 / watched matches: $2 / unwatched: $3"
  },
  "history_wl_changed_one": {
    "ja": "削除ID変化 $1件",
    "en": "Changed removal IDs: $1 video"
  },
  "history_wl_changed_many": {
    "ja": "削除ID変化 $1件",
    "en": "Changed removal IDs: $1 videos"
  }
};
const visited = new Set();
const format = (text, values) => text.replace(/\$(\d+)/g, (_, n) => String(values[n - 1]));

function boot(locale) {
  const elements = {}, callbacks = {}, messages = [], confirmations = [], timers = new Map();
  let timerId = 0, port;
  const element = () => ({ textContent: '', hidden: true, value: '', children: [], listeners: {},
    append(...children) { this.children.push(...children); }, appendChild(child) { this.children.push(child); },
    addEventListener(type, fn) { this.listeners[type] = fn; }, setAttribute() {}, focus() {},
    classList: { add() {}, remove() {} } });
  const context = {
    document: { getElementById: id => elements[id] ||= element(), createElement: element,
      body: element(), addEventListener() {} },
    chrome: { runtime: {
      sendMessage(msg, callback) { callbacks[msg.type] = callback; },
      connect() { return port = { messages: [], disconnects: [], sent: [],
        onMessage: { addListener(fn) { port.messages.push(fn); } },
        onDisconnect: { addListener(fn) { port.disconnects.push(fn); } },
        postMessage(msg) { port.sent.push(msg); }, disconnect() {} }; },
    } },
    confirm(text) { confirmations.push(text); return true; },
    beginMaintenance(key, options) { context.active = options.activeText; return !context.busy; },
    endMaintenance() {}, showJobMessage(text, options) { messages.push({ text, ...options }); },
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); },
  };
  if (locale) context.chrome.i18n = { getMessage(key, values = []) {
    visited.add(key);
    const entry = locale[key];
    return format((entry?.message || '').replace(/\$([A-Za-z_][A-Za-z0-9_]*)\$/g,
      (_, name) => entry.placeholders[name.toLowerCase()].content), values);
  } };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function historyMessage('), source.indexOf('function updateTotalCount(')), context);
  const original = context.historyMessage;
  context.historyMessage = (key, fallback, values = []) => {
    assert(expected[key], 'unknown B key: ' + key);
    assert.strictEqual(fallback, format(expected[key].ja, values), 'original Japanese: ' + key);
    const result = original(key, fallback, values);
    assert.strictEqual(result, format(expected[key][locale === en ? 'en' : 'ja'], values), 'translation: ' + key);
    return result;
  };
  vm.runInContext(source.slice(source.indexOf('// --- Watch Later '), source.indexOf('function runFix(')), context);
  return { context, elements, callbacks, messages, confirmations, timers,
    click(id) { elements[id].listeners.click(); },
    emit(msg) { port.messages.slice().forEach(fn => fn(msg)); },
    disconnect() { port.disconnects.slice().forEach(fn => fn()); },
    get port() { return port; },
  };
}

function rows(n) { return Array.from({ length: n }, (_, i) => ({ videoId: 'id-' + i, title: '題名 $1 $& ' + i, channel: 'チャンネル $2' })); }
function arm(app, n, truncated = false) {
  app.context.armWatchLaterRemoval({ syncSessionId: 'S', preview: rows(n), previewTruncated: truncated });
}
function verify() {
  assert.deepStrictEqual(Object.keys(ja).sort(), Object.keys(en).sort(), 'REQ-1 key sets');
  for (const locale of [null, ja, en, {}]) {
    const english = locale === en;
    const a = boot(locale), c = a.context, el = a.elements;
    for (const reason of ['no-youtube-tab', 'no-items', 'db-check-failed', 'fetch-failed', 'internal-$1', undefined]) c.describeWatchLaterFailure({ reason });
    assert.strictEqual(c.describeWatchLaterFailure({ errors: ['外部エラー $1'] }), '外部エラー $1');
    for (const reason of ['no-scan', 'scan-expired', 'stale-scan', 'confirmation-mismatch', 'no-set-video-id', 'sync-session-changed', 'sync-tab-unavailable', 'edit-not-confirmed', 'internal-$1', undefined]) c.describeWatchLaterRemovalFailure({ reason });
    for (const reason of ['setvideoid-reassigned', 'rescan-failed', 'scan-expired', 'sync-session-changed', 'sync-tab-unavailable', 'edit-not-confirmed', 'no-targets', 'no-scan', 'internal-$1']) c.describeBatchStop(reason);
    c.startWatchLaterBatch(1); a.click('removeOneWatchLater');
    c.busy = true; a.click('scanWatchLater'); c.busy = false;
    for (const n of [0, 1, 2]) {
      a.click('scanWatchLater');
      assert.strictEqual(c.active, english ? 'Scanning…' : '照合中…', 'scan active text');
      a.callbacks.SCAN_WATCH_LATER({ success: true, counts: { total: n, candidates: n, notWatched: n, indeterminate: n, noSetVideoId: n, duplicateVideoId: n }, partial: true, drift: { compared: 7, changed: 3 } });
      assert(a.messages.at(-1).text.includes(english ? `Watch Later: ${n} video${n === 1 ? '' : 's'}` : `後で見る ${n}件`), 'scan count and plural');
    }
    for (const response of [null, { success: false, reason: 'fetch-failed' }]) { a.click('scanWatchLater'); a.callbacks.SCAN_WATCH_LATER(response); }
    a.click('scanWatchLater'); c.chrome.runtime.lastError = { message: '外部 $1 $&' }; a.callbacks.SCAN_WATCH_LATER(); delete c.chrome.runtime.lastError;
    for (const response of [{ success: true, removed: { title: '題名 $1 $&' } }, { success: true, removed: { videoId: 'id-$1' } }, { success: false, reason: 'no-scan' }, null]) {
      arm(a, 1); a.click('removeOneWatchLater');
      assert.strictEqual(a.confirmations.at(-1), (english
        ? 'Remove this video from Watch Later? This cannot be undone.'
        : '次の1本を「後で見る」から削除します。取り消せません。') + '\n\n題名 $1 $& 0\nチャンネル $2', 'single confirmation preserves title and channel');
      a.callbacks.REMOVE_ONE_WATCH_LATER(response);
    }
    arm(a, 1); a.click('removeOneWatchLater'); c.chrome.runtime.lastError = { message: '外部 $1' }; a.callbacks.REMOVE_ONE_WATCH_LATER(); delete c.chrome.runtime.lastError;
    arm(a, 1); c.busy = true; a.click('removeOneWatchLater'); c.startWatchLaterBatch(1); c.busy = false;
    for (const n of [1, 2]) {
      arm(a, n, true); a.click('bulkRemoveWatchLater');
      assert.strictEqual(el.wlPanelRunAll.textContent, english ? (n === 1 ? 'Remove 1 video' : `Remove all ${n} videos`) : `全${n}件を削除`, 'all button');
      assert.strictEqual(el.wlPanelList.children.at(-1).children[1].textContent, rows(n).at(-1).title, 'panel title unchanged');
      assert.strictEqual(el.wlPanelList.children.at(-1).children[2].textContent, rows(n).at(-1).channel, 'panel channel unchanged');
      for (const all of [true, false]) {
        arm(a, all ? n : n + 2); c.startWatchLaterBatch(n);
        const shown = rows(n).map(r => r.title).join('\n');
        assert.strictEqual(a.confirmations.at(-1), english
          ? `Remove ${all ? (n === 1 ? 'the ' : 'all ') : ''}${n} video${n === 1 ? '' : 's'}${all ? ' in the list' : ''} from Watch Later? This cannot be undone.\n\n${shown}`
          : `「後で見る」から${all ? '一覧の全' : ''}${n}件を削除します。取り消せません。\n\n${shown}`, 'confirmation scope and count');
        assert.strictEqual(a.port.sent[0].limit, n);
        a.emit({ type: 'PROGRESS', done: n, total: 7, title: '題名 $1' });
        assert.strictEqual(el.wlPanelStatus.textContent, english ? `Video ${n} of 7: 題名 $1` : `${n} / 7 件目: 題名 $1`, 'progress substitution order');
        assert.strictEqual(a.messages.at(-1).text, english ? `Removing... ${n}/7 (${n} video${n === 1 ? '' : 's'} removed)` : `削除中... ${n}/7件（削除${n}件）`, 'progress count and plural');
        a.emit({ type: 'DONE', success: true, removed: rows(n), counts: { total: 7, candidates: 3, notWatched: 4 }, drift: { changed: n }, stopped: 'no-targets', finalScanFailed: true, aborted: true });
        assert(a.messages.at(-1).text.startsWith(english ? `Removed ${n} video${n === 1 ? '' : 's'} from Watch Later` : `後で見るから${n}件をまとめて削除しました`), 'removed count and plural');
      }
    }
    for (const n of [6, 7]) { arm(a, n); c.startWatchLaterBatch(n); a.emit({ type: 'DONE', success: true, removed: [] }); }
    for (const msg of [{ type: 'ERROR', error: '外部 $1 $&' }, { type: 'ERROR' }, { type: 'DONE', success: false, reason: 'scan-expired' }]) { arm(a, 1); c.startWatchLaterBatch(1); a.emit(msg); }
    arm(a, 1); c.startWatchLaterBatch(1); a.disconnect();
    arm(a, 1); c.startWatchLaterBatch(1); [...a.timers.values()].at(-1)();
  }
  for (const key of Object.keys(expected)) assert(visited.has(key), 'REQ-1 unexercised B message: ' + key);
}
verify();
console.log('PASS REQ-1/2/3: Watch Later rendering, Japanese fallbacks, English plurals, confirmations, failures, progress and unmodified external values');
module.exports = { visited };
