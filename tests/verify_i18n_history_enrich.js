// Run: node tests/verify_i18n_history_enrich.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const source = read('history.js');
const ja = JSON.parse(read('_locales/ja/messages.json'));
const en = JSON.parse(read('_locales/en/messages.json'));
// Independent golden wording: original C1 Japanese and expected English.
const expected = {
  "history_enrich_none": {
    "ja": "対象なし",
    "en": "No targets"
  },
  "history_enrich_overwrite_one": {
    "ja": "$1: $2件のチャンネル名をYouTube oEmbed APIで上書きします。続行しますか？",
    "en": "$1: Overwrite the channel name for $2 video using the YouTube oEmbed API. Continue?"
  },
  "history_enrich_overwrite_many": {
    "ja": "$1: $2件のチャンネル名をYouTube oEmbed APIで上書きします。続行しますか？",
    "en": "$1: Overwrite the channel names for $2 videos using the YouTube oEmbed API. Continue?"
  },
  "history_enrich_channels_one": {
    "ja": "$1: $2件のチャンネル名をYouTube oEmbed APIで補完します。続行しますか？",
    "en": "$1: Fill in the missing channel name for $2 video using the YouTube oEmbed API. Continue?"
  },
  "history_enrich_channels_many": {
    "ja": "$1: $2件のチャンネル名をYouTube oEmbed APIで補完します。続行しますか？",
    "en": "$1: Fill in the missing channel names for $2 videos using the YouTube oEmbed API. Continue?"
  },
  "history_enrich_running": {
    "ja": "実行中…",
    "en": "Running…"
  },
  "history_enrich_busy": {
    "ja": "他のメンテナンス処理が実行中",
    "en": "Another maintenance task is running"
  },
  "history_enrich_refetch_label": {
    "ja": "チャンネル名を再取得",
    "en": "Fetch channel names again"
  },
  "history_enrich_channels_label": {
    "ja": "チャンネル名を補完",
    "en": "Fill in channel names"
  },
  "history_enrich_channels_progress": {
    "ja": "処理中... 残り$1/$2（更新$3 / 失敗$4）",
    "en": "Processing... $1/$2 remaining (updated: $3 / failed: $4)"
  },
  "history_enrich_refetch_aborted": {
    "ja": "チャンネル名の再取得を中止しました",
    "en": "Fetching channel names again was canceled"
  },
  "history_enrich_channels_aborted": {
    "ja": "チャンネル名の補完を中止しました",
    "en": "Filling in channel names was canceled"
  },
  "history_enrich_refetch_done": {
    "ja": "チャンネル名を再取得しました",
    "en": "Fetched channel names again"
  },
  "history_enrich_channels_done": {
    "ja": "チャンネル名を補完しました",
    "en": "Filled in channel names"
  },
  "history_enrich_channels_result": {
    "ja": "$1: 更新$2件 / 失敗$3件 / 処理$4/$5件",
    "en": "$1: Updated: $2 / failed: $3 / processed: $4/$5"
  },
  "history_enrich_failed": {
    "ja": "失敗: $1",
    "en": "Failed: $1"
  },
  "history_enrich_channels_button": {
    "ja": "チャンネル名補完",
    "en": "Fill in channel names"
  },
  "history_enrich_held_one": {
    "ja": "\n\n※前に調べて情報が見つからなかった$1件は、しばらく間隔を空けるため今回は対象外です（「チェック済みスキップ」を外すと全部やり直せます）。",
    "en": "\n\nNote: $1 video with no information found previously is excluded this time to allow a waiting period (clear “Skip checked” to retry everything)."
  },
  "history_enrich_held_many": {
    "ja": "\n\n※前に調べて情報が見つからなかった$1件は、しばらく間隔を空けるため今回は対象外です（「チェック済みスキップ」を外すと全部やり直せます）。",
    "en": "\n\nNote: $1 videos with no information found previously are excluded this time to allow a waiting period (clear “Skip checked” to retry everything)."
  },
  "history_enrich_none_held_one": {
    "ja": "対象なし（間隔待ち $1件）",
    "en": "No targets ($1 video in the waiting period)"
  },
  "history_enrich_none_held_many": {
    "ja": "対象なし（間隔待ち $1件）",
    "en": "No targets ($1 videos in the waiting period)"
  },
  "history_enrich_credits_one": {
    "ja": "$1: $2件の動画から作曲/作詞/編曲を概要欄で補完します。続行しますか？$3\n\n※YouTubeタブを1つ以上開いたままにしてください（Cookie経由でfetchするため）。",
    "en": "$1: Fill in composer/lyricist/arranger credits from the description of $2 video. Continue?$3\n\nNote: Keep at least one YouTube tab open (fetching uses cookies)."
  },
  "history_enrich_credits_many": {
    "ja": "$1: $2件の動画から作曲/作詞/編曲を概要欄で補完します。続行しますか？$3\n\n※YouTubeタブを1つ以上開いたままにしてください（Cookie経由でfetchするため）。",
    "en": "$1: Fill in composer/lyricist/arranger credits from the descriptions of $2 videos. Continue?$3\n\nNote: Keep at least one YouTube tab open (fetching uses cookies)."
  },
  "history_enrich_running_abort": {
    "ja": "実行中…（中止）",
    "en": "Running… (Cancel)"
  },
  "history_enrich_credits_label": {
    "ja": "概要欄からクレジット補完",
    "en": "Fill in credits from descriptions"
  },
  "history_enrich_credits_progress": {
    "ja": "処理中... 残り$1/$2（更新$3 / 情報なし$4 / 取得失敗$5）",
    "en": "Processing... $1/$2 remaining (updated: $3 / no information: $4 / fetch failed: $5)"
  },
  "history_enrich_credits_done": {
    "ja": "概要欄からクレジットを補完しました",
    "en": "Filled in credits from descriptions"
  },
  "history_enrich_credits_stopped": {
    "ja": "概要欄からのクレジット補完を自動停止しました（Googleのbot検知 / 時間を空けて再実行）",
    "en": "Filling in credits from descriptions stopped automatically (Google bot detection / wait before retrying)"
  },
  "history_enrich_credits_aborted": {
    "ja": "概要欄からのクレジット補完を中止しました",
    "en": "Filling in credits from descriptions was canceled"
  },
  "history_enrich_credits_result": {
    "ja": "$1: 更新$2 / 情報なし$3 / 取得失敗$4 / 処理$5/$6$7",
    "en": "$1: Updated: $2 / no information: $3 / fetch failed: $4 / processed: $5/$6$7"
  },
  "history_enrich_aborting_status": {
    "ja": "中止中...",
    "en": "Canceling..."
  },
  "history_enrich_aborting_button": {
    "ja": "中止中…",
    "en": "Canceling…"
  },
  "history_enrich_general_label": {
    "ja": "クレジット補完（Topic+一般）",
    "en": "Fill in credits (Topic + general)"
  },
  "history_enrich_topic_label": {
    "ja": "Topic動画のクレジット補完",
    "en": "Fill in credits for Topic videos"
  }
};
const visited = new Set();
const format = (text, values) => text.replace(/\$(\d+)/g, (_, n) => String(values[n - 1]));

function boot(locale) {
  const elements = {}, messages = [], confirmations = [], active = [], calls = new Set();
  let port;
  const context = {
    allData: [], sortedCache: [], noChannelOnly: false,
    document: { getElementById(id) { return elements[id] ||= {
      dataset: {}, checked: false, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; },
    }; } },
    window: { CreditTarget: {
      isTopicChannelName: channel => channel.endsWith(' - Topic'),
      hasMissingCreditRole: row => !row.composer,
      isFixCreditsTarget: (row, options) => !row.composer && !(options.skipChecked && row.held),
    } },
    chrome: { runtime: { connect() {
      return port = { sent: [], onMessage: { addListener(fn) { port.receive = fn; } },
        onDisconnect: { addListener(fn) { port.disconnect = fn; } },
        postMessage(msg) { this.sent.push(msg); } };
    } } },
    confirm(text) { confirmations.push(text); return context.confirmed; }, confirmed: true,
    beginMaintenance(key, options) { active.push(options.activeText); return !context.busy; },
    updateRunningMaintenance(key, options) { active.push(options.activeText); },
    hasRunningMaintenance() { return !!context.busy; }, endMaintenance() {},
    showJobMessage(text, options) { messages.push({ text, ...options }); },
    updateTotalCount() {}, loadData() {}, setTimeout() {}, console: { log() {} },
  };
  if (locale) context.chrome.i18n = {
    getUILanguage: () => locale === en ? 'en' : 'ja',
    getMessage(key, values = []) {
      const entry = locale[key];
      return format((entry?.message || '').replace(/\$([A-Za-z_][A-Za-z0-9_]*)\$/g,
        (_, name) => entry.placeholders[name.toLowerCase()].content), values);
    },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function historyMessage('), source.indexOf('function updateTotalCount(')), context);
  const original = context.historyMessage;
  context.historyMessage = (key, fallback, values = []) => {
    assert(expected[key], 'unknown C1 key: ' + key);
    calls.add(key); visited.add(key);
    assert.strictEqual(fallback, format(expected[key].ja, values), 'original Japanese: ' + key);
    const result = original(key, fallback, values);
    assert.strictEqual(result, format(expected[key][locale === en ? 'en' : 'ja'], values), 'translation: ' + key);
    return result;
  };
  vm.runInContext(source.slice(source.indexOf('function runFix('), source.indexOf('function sendHistoryDbRpc(')), context);
  return { context, elements, messages, confirmations, active, calls,
    click(id) { elements[id].listeners.click(); },
    emit(msg) { port.receive(msg); }, get port() { return port; },
  };
}

assert.deepStrictEqual(Object.keys(ja).sort(), Object.keys(en).sort(), 'REQ-1 key sets');
for (const key of Object.keys(expected)) assert(ja[key] && en[key], 'missing C1 key: ' + key);
for (const locale of [null, ja, en, {}]) {
  const a = boot(locale), c = a.context;
  const label = 'Action $1 $&';
  for (const force of [false, true]) {
    c.runFix([], force, label);
    for (const n of [1, 2]) {
      const ids = Array.from({ length: n }, (_, i) => 'id-' + i);
      for (const aborted of [false, true]) {
        c.runFix(ids, force, label);
        assert.deepStrictEqual(Array.from(a.port.sent[0].videoIds), ids);
        assert.strictEqual(a.port.sent[0].force, force);
        const key = `history_enrich_${force ? 'overwrite' : 'channels'}_${n === 1 ? 'one' : 'many'}`;
        assert.strictEqual(a.confirmations.at(-1), format(expected[key][locale === en ? 'en' : 'ja'], [label, n]));
        c.allData = [{ videoId: 'id-0', title: 'Title $1', channel: '' }];
        a.emit({ type: 'PROGRESS', total: n, processed: 1, updated: 3, failed: 4,
          wasUpdated: true, videoId: 'id-0', channel: 'Channel $2', title: 'New title $&' });
        assert.strictEqual(c.allData[0].channel, 'Channel $2');
        a.emit({ type: 'DONE', updated: 3, failed: 4, processed: n, total: n, aborted });
      }
      for (const error of ['External $1 $&', undefined]) {
        c.runFix(ids, force, label); a.emit({ type: 'ERROR', error });
        assert.strictEqual(a.messages.at(-1).text, (locale === en ? 'Failed: ' : '失敗: ') + (error || 'unknown'));
      }
    }
  }
  for (const n of [1, 2]) {
    const ids = Array.from({ length: n }, (_, i) => 'id-' + i);
    for (const held of [0, 1, 2]) {
      c.runFixCredits([], {}, label, held);
      for (const done of [{}, { aborted: true }, { autoStopped: true, aborted: true }]) {
        c.runFixCredits(ids, {}, label, held);
        const note = held ? format(expected[`history_enrich_held_${held === 1 ? 'one' : 'many'}`][locale === en ? 'en' : 'ja'], [held]) : '';
        assert.strictEqual(a.confirmations.at(-1), format(expected[`history_enrich_credits_${n === 1 ? 'one' : 'many'}`][locale === en ? 'en' : 'ja'], [label, n, note]));
        a.emit({ type: 'PROGRESS', total: n, processed: 1, updated: 3, noCredits: 4, fetchFailed: 5,
          wasUpdated: true, videoId: 'id-0', credits: { composer: 'Composer $1', lyricist: 'Lyricist $&', arranger: 'Arranger' } });
        a.click('fixCredits');
        assert.strictEqual(a.port.sent.at(-1).type, 'ABORT');
        a.emit({ type: 'DONE', updated: 3, noCredits: 4, fetchFailed: 5, processed: n, total: n,
          failReasons: { 'external-$1': 2 }, ...done });
        assert(a.messages.at(-1).text.endsWith(' [external-$1:2]'), 'external reasons preserved');
      }
    }
    for (const error of ['External $1 $&', undefined]) {
      c.runFixCredits(ids, {}, label, 0); a.emit({ type: 'ERROR', error });
    }
  }
  c.busy = true;
  a.click('fixChannels'); a.click('fixCredits');
  c.runFix(['id'], false, label); c.runFixCredits(['id'], {}, label, 0);
  c.busy = false; c.confirmed = false;
  c.runFix(['id'], true, label); c.runFixCredits(['id'], {}, label, 0);
  c.confirmed = true;
  c.allData = [{ videoId: 'id', channel: '' }]; a.click('fixChannels');
  c.allData = [{ videoId: 'topic', channel: 'Artist - Topic' }, { videoId: 'general', channel: 'Artist', held: true }];
  for (const general of [false, true]) {
    c.document.getElementById('includeGeneralCredits').checked = general;
    c.document.getElementById('skipCreditsChecked').checked = true;
    a.elements.fixCredits.dataset.mode = '';
    a.click('fixCredits');
    assert.strictEqual(a.port.sent[0].sources.topic, 'topic');
    a.port.disconnect();
  }
  for (const key of Object.keys(expected)) assert(a.calls.has(key), 'unexercised C1 message: ' + key);
  if (locale === en) {
    for (const text of [...a.confirmations, ...a.active, ...a.messages.flatMap(m => [m.text, m.label || ''])]) {
      assert(!/[\u3040-\u30ff\u3400-\u9fff]/u.test(text), 'untranslated C1 UI: ' + text);
    }
  }
}
console.log('PASS REQ-1/2/3: C1 messages, original Japanese, English plurals, progress, outcomes, cancellation and external values');
module.exports = { visited };
