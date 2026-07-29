'use strict';

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

const RECENT_COUNT = 8;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderGuide(container) {
  container.textContent = '';
  for (const item of GUIDE) {
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
  if (entry.date) head.appendChild(el('span', 'date', entry.date));
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
    recent.textContent = '更新履歴を読み込めませんでした。';
    return;
  }

  for (const entry of releases.slice(0, RECENT_COUNT)) {
    recent.appendChild(renderRelease(entry, false));
  }

  const rest = releases.slice(RECENT_COUNT);
  if (!rest.length) return;
  document.getElementById('olderSummary').textContent =
    'それより前の更新 ' + rest.length + ' 件を表示';
  for (const entry of rest) older.appendChild(renderRelease(entry, true));
  olderWrap.hidden = false;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GUIDE, RECENT_COUNT };
} else {
  main();
}
