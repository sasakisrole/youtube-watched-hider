'use strict';

function whatsnewUILanguage() {
  return globalThis.chrome?.i18n?.getUILanguage?.() || 'ja';
}

function isEnglish() {
  return /^en(?:-|$)/i.test(whatsnewUILanguage());
}

function whatsnewMessage(key, fallback, substitutions = []) {
  return globalThis.chrome?.i18n?.getMessage?.(key, substitutions.map(String)) || fallback;
}

function applyStaticWhatsnewI18n() {
  document.documentElement.lang = isEnglish() ? 'en' : 'ja';
  if (!globalThis.chrome?.i18n?.getMessage) return;
  for (const target of ['', 'placeholder', 'title', 'aria-label']) {
    const attribute = target ? 'data-i18n-' + target : 'data-i18n';
    for (const element of document.querySelectorAll('[' + attribute + ']')) {
      const message = chrome.i18n.getMessage(element.getAttribute(attribute));
      if (!message) continue;
      if (target) element.setAttribute(target, message);
      else element.textContent = element.textContent.replace(/\S(?:[\s\S]*\S)?/, () => message);
    }
  }
}

// 使い方ガイド。「いまどうなっているか」だけを書く（履歴は書かない＝更新履歴側の役割）。
//
// uiText には、その説明が指している実際のUI文字列を書く。tests/verify_whatsnew.js が
// 「その文字列が現物のHTML/JSに存在するか」を検査するので、ボタンを消したり改名したり
// すると説明が古いままにならずテストが落ちる。増やしすぎると腐るので、説明の要になる
// 文字列だけを挙げること。
const GUIDE = [
  {
    task: '見た動画をおすすめから隠したい',
    where: 'YouTube を開くだけ（設定不要）',
    steps: [
      '一度再生した動画は、次からおすすめ・検索結果に出なくなります。',
      '一時的に戻したいときは、拡張アイコンからトグルを切り替えます。',
    ],
    uiText: [],
  },
  {
    task: '高評価した動画を取り込みたい',
    where: '拡張アイコン → 高評価を同期',
    steps: [
      '高評価プレイリストを開いているタブがなくても実行できます。',
      '同期は開始時のタブとアカウントに固定されます。途中で別アカウントに切り替えても、別アカウントのデータは混ざりません。',
      '途中で止まった場合は「部分同期」と表示され、理由が併記されます。',
    ],
    uiText: ['高評価を同期'],
  },
  {
    task: '自分の視聴傾向を見たい',
    where: '拡張アイコン → 履歴・分析を開く',
    steps: [
      'アーティスト・全チャンネル・キーワード・クレジット・高評価・推移のタブに分かれています。',
      '合計時間は動画の長さの合計で、実際の視聴時間ではありません（途中離脱・倍速・リピートは反映されません）。',
    ],
    uiText: ['アーティスト', '全チャンネル', 'キーワード', 'クレジット', '高評価', '推移'],
  },
  {
    task: '曲の作曲・作詞・編曲を埋めたい',
    where: '履歴・分析画面 → クレジット補完',
    steps: [
      '概要欄からの補完と、MusicBrainz 照合の2経路があります。',
      '開始前に対象件数・推定所要時間が出ます。件数の上限（全件 / 上位N件）も選べます。',
      '自動で埋まらないものは手動確認の一覧に回ります。',
    ],
    caution: '外部サイトへ問い合わせるため、件数が多いと数十分かかります。開始前の確認画面で件数を見てから実行してください。',
    uiText: [],
  },
  {
    task: '入っているクレジットが正しいか確かめたい',
    where: '履歴・分析画面 → クレジット → クレジット確認センター',
    steps: [
      '動画ごとの作曲・作詞・編曲を1つずつ「競合 / 要確認 / 自動候補 / 未解決 / 確認済み」に振り分けて数えます。上のボタンで絞り込めます。',
      '先にクレジット補完で候補生成してから開いてください。候補は同じ画面で生成したぶんだけを材料にするため、いきなり開くと「競合」「自動候補」は0件になります。',
      '「自動候補」「要確認」は、候補を採用するか却下するかを役割ごとに選べます。',
      '「競合」は候補が2つ以上あって機械では決められないものです。ラジオボタンで1つだけ選びます。どれも選ばないままにもできます。',
      '採用した値は手入力あつかいで保存され、以後の自動処理で上書きされません。',
    ],
    caution: 'クレジット補完が埋めるのは空欄だけで、その手動確認の一覧にも、空いている役割が残っている動画しか出ません。すべての役割が埋まった動画の値を見直せるのはこの画面だけです。自動で入っただけでまだ誰も確かめていない値は「要確認」に並びます。',
    uiText: ['クレジット確認センター', '競合', '要確認', '自動候補', '未解決', '確認済み'],
  },
  {
    task: '検索結果で公式チャンネルを優先したい',
    where: 'YouTube の検索結果 → 画面右下のパネル',
    steps: [
      'パネルは既定で折りたたまれています。ハンドルから開きます。',
      '「公式のみ」「発掘」「すべて表示」の3モードを切り替えられます。',
      '登録なしで使いたいときは「その他を隠す」トグルだけで動きます。',
    ],
    caution: '転載かどうかの自動判定はしません。登録したチャンネルを優先するだけの仕組みです。',
    uiText: [],
  },
  {
    task: 'Topic チャンネルが誰のものか調べたい',
    where: 'YouTube の検索結果 → 画面右下のパネル → 未知動画のクレジット確認',
    steps: [
      '「〇〇 - Topic」は名前だけでは誰の公式か分かりません。動画のクレジットから手がかりを集めます。',
      'ボタンを押すと、検索結果にある未登録の Topic 動画を最大20件まで開いて、作曲・作詞・編曲を読み取ります。',
      '結果は「動画ID: 作曲者」の形で並びます。読み取れなかったものは理由が付きます。',
      '途中でやめたいときは「中止」を押します。そこまでに調べた分は残ります。',
      '誰の公式か分かったら、履歴・分析画面の公式プロファイルから登録します。',
    ],
    caution: 'ボタンを押したときだけ動きます。自動で登録することはなく、調べた動画が視聴履歴に入ることもありません。',
    uiText: ['未知動画のクレジット確認', '中止'],
  },
  {
    task: '公式チャンネルを登録して手間を減らしたい',
    where: '履歴・分析画面 → 公式プロファイル タブ',
    steps: [
      '視聴履歴から、公式・Topic チャンネルの候補が並びます。',
      '「登録内容を確認」を押すとチャンネルURLを取得します。リンク先を開いて本人のものか確かめます。',
      '確認欄にチェックを入れてから登録します。名前が一致しただけでは登録しません。',
      '登録済みの候補は一覧から消えます。同じチャンネルを二重に登録することはできません。',
      '複数アーティストが混ざるチャンネルなど、候補に出したくないものは「候補から外す」で隠せます。戻すときは一覧の下の「除外をすべて戻す」です。',
    ],
    uiText: ['公式プロファイル', '登録内容を確認', '候補から外す', '除外をすべて戻す', '候補チャンネルを開く'],
  },
  {
    task: 'データを退避・復元したい',
    where: '拡張アイコン → 設定・データ管理',
    steps: [
      '視聴済み・高評価・クレジットをまとめて書き出せます。',
      '読み込みは、置き換えと統合を選べます。取り込む前に差分の件数が出ます。',
      '壊れたデータが含まれていると、取り込み前に警告が出ます。',
    ],
    caution: '置き換えを選ぶと、書き出し時点にない記録は消えます。統合なら既存の記録は残ります。',
    uiText: [],
  },
];

// Keep the original Japanese guide intact; select the English guide at render time.
const GUIDE_EN = [
  {
    task: 'Hide watched videos from recommendations',
    where: 'Just open YouTube. No setup needed.',
    steps: [
      'Videos you have played will no longer appear in recommendations or search results.',
      'To show them temporarily, use the toggle in the extension popup.',
    ],
    uiText: [],
  },
  {
    task: 'Import your liked videos',
    where: 'Extension icon → Sync Liked videos',
    steps: [
      'You do not need to keep your Liked videos playlist open.',
      'Sync stays tied to the tab and account it started with. Switching accounts during sync will not mix their data.',
      'If sync stops early, its status shows that it is partial and explains why.',
    ],
    uiText: ['Sync Liked videos'],
  },
  {
    task: 'Explore your viewing habits',
    where: 'Extension icon → Open history and analytics',
    steps: [
      'Browse the Artists, All channels, Keywords, Credits, Liked videos, and Trends tabs.',
      'Total duration is the sum of video lengths, not actual watch time. It does not account for leaving early, playback speed, or repeats.',
    ],
    uiText: ['Open history and analytics', 'Artists', 'All channels', 'Keywords', 'Credits', 'Liked videos', 'Trends'],
  },
  {
    task: 'Fill in composer, lyricist, and arranger credits',
    where: 'History and analytics → Fill credits (external databases)',
    steps: [
      'Credits can be filled from video descriptions or matched with MusicBrainz.',
      'Before starting, you will see the number of videos and estimated time. You can choose all videos or limit the number.',
      'Items that cannot be filled automatically go to a manual review list.',
    ],
    caution: 'Looking up external sites can take tens of minutes for large batches. Check the video count before starting.',
    uiText: ['Fill credits (external databases)'],
  },
  {
    task: 'Check existing credits',
    where: 'History and analytics → Credits → Credit review center',
    steps: [
      'Each composer, lyricist, and arranger credit is counted under Conflicts, Needs review, Automatic candidates, Unresolved, or Verified. Use the buttons to filter.',
      'Generate candidates with credit completion first. Only candidates generated in the same page session are used, so conflicts and automatic candidates start at zero otherwise.',
      'For automatic candidates and credits needing review, accept or reject each role separately.',
      'A conflict means there are multiple candidates and no automatic choice. Select one with a radio button, or leave all unselected.',
      'Accepted values are saved as manual edits and will not be overwritten automatically.',
    ],
    caution: 'Credit completion fills empty fields only, and its manual review list only includes videos with missing roles. Use this center to check videos with every role filled. Automatically filled values that nobody has checked appear under Needs review.',
    uiText: ['Credits', 'Credit review center', 'Conflicts', 'Needs review', 'Automatic candidates', 'Unresolved', 'Verified'],
  },
  {
    task: 'Prioritize official channels in search',
    where: 'YouTube search results → Panel at the bottom right',
    steps: [
      'The panel starts collapsed. Use its handle to open it.',
      'Switch between Official first, Discover, and Show all.',
      'To use it without registering channels, turn on Hide other channels (show official and Topic).',
    ],
    caution: 'This does not detect unauthorized reuploads. It simply prioritizes the channels you register.',
    uiText: ['Official first', 'Discover', 'Show all', 'Hide other channels (show official and Topic)'],
  },
  {
    task: 'Find out who a Topic channel belongs to',
    where: 'YouTube search results → Bottom-right panel → Check credits for unknown videos',
    steps: [
      'A name ending in “- Topic” alone does not establish whose official channel it is. Video credits can provide clues.',
      'The button opens up to 20 unregistered Topic videos from the search results and reads composer, lyricist, and arranger credits.',
      'Results show the video ID and composer, or a reason if the credits could not be read.',
      'Press Cancel to stop. Results collected so far are kept.',
      'Once you have verified the channel, register it under Official profiles in history and analytics.',
    ],
    caution: 'This runs only when you press the button. It never registers channels automatically or adds the checked videos to your watch history.',
    uiText: ['Check credits for unknown videos', 'Cancel', 'Official profiles'],
  },
  {
    task: 'Register official channels for easier filtering',
    where: 'History and analytics → Official profiles',
    steps: [
      'Candidates for official and Topic channels are drawn from your watch history.',
      'Press Review registration to get the channel URL, then Open candidate channel to check that it belongs to the artist.',
      'Tick the confirmation box before registering. A matching name alone is not enough.',
      'Registered candidates disappear from the list. The same channel cannot be registered twice.',
      'Use Exclude candidate to hide channels you do not want suggested, such as channels with multiple artists. Use Restore all exclusions below the list to bring them back.',
    ],
    uiText: ['Official profiles', 'Review registration', 'Open candidate channel', 'Exclude candidate', 'Restore all exclusions'],
  },
  {
    task: 'Back up or restore your data',
    where: 'Extension icon → Settings and data',
    steps: [
      'Export watched videos, liked videos, and credits together.',
      'When importing, choose whether to replace or merge. You will see the number of changes before proceeding.',
      'If the file contains invalid data, a warning appears before import.',
    ],
    caution: 'Replacing removes records added since the export. Merging keeps existing records.',
    uiText: ['Settings and data'],
  },
];

const RECENT_COUNT = 8;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderGuide(container) {
  container.textContent = '';
  for (const item of isEnglish() ? GUIDE_EN : GUIDE) {
    const card = el('div', 'card');
    card.appendChild(el('h3', '', item.task));
    card.appendChild(el('div', 'where', item.where));
    const steps = el('ol');
    for (const step of item.steps) steps.appendChild(el('li', '', step));
    card.appendChild(steps);
    if (item.caution) card.appendChild(el('p', 'caution', item.caution));
    container.appendChild(card);
  }
}

function renderRelease(entry, compact) {
  const box = el('div', compact ? 'older' : 'release');
  const head = el('div', 'release-head');
  head.appendChild(el('span', 'ver', 'v' + entry.version));
  if (entry.date) {
    // Preserve the original Japanese display and format date-only values in UTC.
    const date = isEnglish() && /^\d{4}-\d{2}-\d{2}$/.test(entry.date)
      ? new Date(entry.date + 'T00:00:00Z').toLocaleDateString(whatsnewUILanguage(),
        { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
      : entry.date;
    head.appendChild(el('span', 'date', date));
  }
  box.appendChild(head);
  if (entry.summary) box.appendChild(el('p', 'summary', entry.summary));
  if (!compact && entry.points.length) {
    const list = el('ul');
    for (const point of entry.points) list.appendChild(el('li', '', point));
    box.appendChild(list);
  }
  return box;
}

function main() {
  applyStaticWhatsnewI18n();
  document.getElementById('releaseLanguageNote').hidden = !isEnglish();
  const releases = Array.isArray(globalThis.YWH_WHATSNEW) ? globalThis.YWH_WHATSNEW : [];
  const recent = document.getElementById('recent');
  const olderWrap = document.getElementById('olderWrap');
  const older = document.getElementById('older');

  renderGuide(document.getElementById('features'));

  const version = globalThis.chrome?.runtime?.getManifest?.()?.version || releases[0]?.version;
  if (version) document.getElementById('currentVersion').textContent = 'v' + version;

  recent.textContent = '';
  recent.className = '';
  if (!releases.length) {
    recent.className = 'empty';
    recent.textContent = whatsnewMessage('whatsnew_load_failed', '更新履歴を読み込めませんでした。');
    return;
  }

  for (const entry of releases.slice(0, RECENT_COUNT)) {
    recent.appendChild(renderRelease(entry, false));
  }

  const rest = releases.slice(RECENT_COUNT);
  if (!rest.length) return;
  document.getElementById('olderSummary').textContent =
    whatsnewMessage(rest.length === 1 ? 'whatsnew_older_one' : 'whatsnew_older_many',
      'それより前の更新 ' + rest.length + ' 件を表示',
      [isEnglish() ? rest.length.toLocaleString(whatsnewUILanguage()) : String(rest.length)]);
  for (const entry of rest) older.appendChild(renderRelease(entry, true));
  olderWrap.hidden = false;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GUIDE, GUIDE_EN, RECENT_COUNT };
} else {
  main();
}
