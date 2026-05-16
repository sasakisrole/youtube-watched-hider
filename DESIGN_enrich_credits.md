# Enrich Credits UI（yt-watched-hider 機能追加）

## 目的

YouTube Watched Hider の history.html に「Enrich Credits」ボタンを追加し、
未割当の `creditsRaw`（2026-05-16時点 903件 / 148チャンネル）を外部DB照合で
composer / lyricist / arranger に自動補完する。

検証では33%（297件）の補完が可能と確認済み。
従来は概要欄fetch（`history.js:412 fixCreditsForRange`）でしか補完できなかったが、
Topic以外のチャンネル・概要欄に役割明記のない楽曲は未割当のまま残っていた。
本機能で「アーティスト名 → 外部DB → 役割確定」のルートを追加する。

### 現状の課題
1. 未割当 creditsRaw が 903件残っており、az（あ・あ・あ）タブの集計から漏れている
2. 概要欄fetchルート（`fixCreditsForRange`）では補完できないチャンネルが多い
3. 既存の credits-enrich/ 検証はPythonスクリプト単発実行で、拡張ユーザー（自分）が日次運用できない

### このツールでやること
- history.html に「Enrich Credits」ボタン追加 → モーダルでチャンネル単位タブUI表示
- 補完優先順: ①100%固定ルール（composer_rules.json 同梱）→ ②uta-net → ③MusicBrainz
- sim（タイトル類似度）に応じた表示制御（≥0.95自動✓ / 0.85-0.95要目視 / <0.85非表示）
- ユーザー確定 → IndexedDB（既存 `composer/lyricist/arranger` フィールド）に書き戻し
- 各補完値に `creditsSource` を `"enrich:rule"` / `"enrich:utanet"` / `"enrich:mb"` で記録

### このツールでやらないこと（スコープ外）
- 概要欄fetchルート（`fixCreditsForRange`）の変更 — 既存ロジックは温存
- 全自動補完（必ずユーザーが目視・確定する）
- MusicBrainz の網羅的マッチ精度向上 — 検証時の v2 ロジック（35%）をそのまま流用
- composer_rules.json の自動拡張機構 — 同梱JSONを手動更新する運用
- 拡張外部（クラウド・サーバ）への依存 — 全処理を拡張内で完結

---

## 配置・命名

- DESIGN.md: `projects/youtube-watched-hider/DESIGN_enrich_credits.md`
- 既存拡張への機能追加（新規HTMLツールではない）
- 追加・変更ファイル:
  - `manifest.json` — host_permissions に2ドメイン追加 / version 1.40.0 へ
  - `history.html` — 「Enrich Credits」ボタンとモーダルDOM追加
  - `history.js` — モーダル開閉・結果テーブル制御
  - `enrich_credits.js` — 新規。チャンネル抽出・候補生成・確定処理（UIスレッド側）
  - `background.js` — message handler 追加（uta-net / MB fetch リレー）
  - `composer_rules.json` — 新規。100%固定ルール（同梱アセット）
  - `CHANGELOG.md` — v1.40.0 エントリ追加

---

## 画面構成

history.html の上部ツールバーに「Enrich Credits」ボタンを追加。
クリックでフルスクリーンモーダルを開く（既存の az クレジット表示と独立）。

### モーダルレイアウト（縦長1ページ・チャンネル単位タブ）

```
┌──────────────────────────────────────────────────────┐
│ Enrich Credits                            [×]        │
├──────────────────────────────────────────────────────┤
│ [候補生成] 進捗: 12/148ch・残レート N/min  [×中止]    │
├──────────────────────────────────────────────────────┤
│ チャンネルタブ（横スクロール）                          │
│ [fripSide(123)] [Nobuo Uematsu(97)] [HIMEHINA(43)] … │
├──────────────────────────────────────────────────────┤
│ 候補テーブル（現在のタブ）                              │
│ ┌──┬────────────────┬──────────┬──────┬──────┬────┐ │
│ │✓│動画タイトル        │補完値    │role  │source│sim │ │
│ ├──┼────────────────┼──────────┼──────┼──────┼────┤ │
│ │✓│ promenade       │Satoshi Y.│作曲  │rule  │ -  │ │
│ │✓│ only my railgun │Satoshi Y.│作曲  │rule  │ -  │ │
│ │□│ infinite synth. │Sat. Yag.. │作曲  │utanet│0.88│ │
│ └──┴────────────────┴──────────┴──────┴──────┴────┘ │
│ チャンネル小計: 確定予定 124件 / 候補 130件             │
├──────────────────────────────────────────────────────┤
│ [全タブ累計] 確定予定: 281件 / 候補: 297件             │
│              [キャンセル] [選択を確定して書き戻し]       │
└──────────────────────────────────────────────────────┘
```

### セクション1: ヘッダー操作バー
- 「候補生成」ボタン（初回 or 再生成）
- 進捗表示（処理中チャンネル数 / レート制御の残量 / 経過時間）
- 「中止」ボタン（fetch中断・既取得分は保持）

### セクション2: チャンネルタブ
- 候補が見つかったチャンネルのみ表示（候補ゼロのチャンネルは表示しない）
- ラベル形式: `{チャンネル名}({候補件数})`
- 確定済（チェック有）件数を強調色（青）で表示
- 件数降順ソート

### セクション3: 候補テーブル（現在のタブのみ表示）
- カラム: チェックボックス / 動画タイトル / 補完値 / role / source / sim
- sim≥0.95 → チェックボックスON初期値・行背景うすい緑
- 0.85≤sim<0.95 → チェックボックスOFF初期値・行背景うすい黄
- sim<0.85 → 表示しない（テーブル内に入れない）
- rule 由来は sim カラム空欄（`-` 表示）、チェックON初期値
- 動画タイトルクリック → 新タブで `https://youtu.be/{videoId}` を開く（目視確認用）

### セクション4: フッター
- 全タブ累計（確定予定数 / 候補総数）
- 「キャンセル」「選択を確定して書き戻し」ボタン

---

## プリセット項目

### composer_rules.json（拡張同梱・JSON）

```json
{
  "version": "1.0",
  "updated": "2026-05-16",
  "rules": [
    {
      "channel": "fripSide - Topic",
      "composer": "Satoshi Yaginuma",
      "evidence": "creditsRaw 全曲に Satoshi Yaginuma が出現"
    },
    {
      "channel": "Nobuo Uematsu - Topic",
      "composer": "Nobuo Uematsu",
      "evidence": "ソロ作曲家チャンネル"
    }
  ]
}
```

- 初版は検証済の2件のみ収録（fripSide / Nobuo Uematsu）
- 将来の追加はJSONを手編集してリリース（自動拡張機構は持たない）
- マッチ条件: 動画の `channel` フィールドと完全一致

---

## データ構造

### 入力（IndexedDB から読み出し）
既存スキーマ（`db.js` 確認済）:
```javascript
{
  videoId, title, channel,
  composer: "", lyricist: "", arranger: "",
  creditsRaw: "Satoshi Yaginuma · ...", // ← 未割当
  creditsSource: ""
}
```

抽出条件:
```javascript
record.creditsRaw && !record.composer && !record.lyricist && !record.arranger
```

### 中間データ（モーダル内のメモリ・永続化なし）

```typescript
type Candidate = {
  videoId: string;
  title: string;
  channel: string;
  // 補完値
  composer?: string;
  lyricist?: string;
  arranger?: string;
  source: "rule" | "utanet" | "mb";
  sim: number | null;  // rule は null
  selected: boolean;   // チェックボックス状態
};

type EnrichSession = {
  startedAt: number;
  candidatesByChannel: Map<string, Candidate[]>;
  fetchCache: {
    utanet: Map<string, UtanetArtistData>;  // channel名 → 曲リスト
    mb: Map<string, MBData>;
  };
};
```

### 出力（IndexedDB 書き戻し）

既存 `composer` / `lyricist` / `arranger` フィールドへ書き込み、
`creditsSource` に source（`enrich:rule` / `enrich:utanet` / `enrich:mb`）を記録。
既存値が空のフィールドのみ上書き（既に composer がある行は触らない）。

---

## 計算ロジック

### Step 1: 候補抽出（UIスレッド）

```javascript
const all = await db.getAll();
const unassigned = all.filter(r => r.creditsRaw && !r.composer && !r.lyricist && !r.arranger);
const byChannel = groupBy(unassigned, r => r.channel);
```

### Step 2: 100%固定ルール適用（同期・即時）

```javascript
for (const channel in byChannel) {
  const rule = rules.find(r => r.channel === channel);
  if (rule) {
    for (const v of byChannel[channel]) {
      addCandidate({ ...v, composer: rule.composer, source: "rule", sim: null, selected: true });
    }
  }
}
```

### Step 3: uta-net 検索（SW経由・チャンネル単位逐次）

ルール未該当チャンネルのみ。SWへ `enrichCreditsUtanet` メッセージ送信。

```javascript
// SW側（background.js）
async function fetchUtanet(artist) {
  await rateLimitWait('utanet', 1000);  // 1req/秒
  const url = `https://www.uta-net.com/search/?Aselect=1&Bselect=4&Keyword=${encodeURIComponent(artist)}`;
  const html = await fetch(url).then(r => r.text());
  return parseUtanetSearchHtml(html);  // {songs: [{title, composer, lyricist, arranger}, ...]}
}
```

チャンネル名から「- Topic」サフィックスを除去してアーティスト名を抽出。

### Step 4: マッチング（タイトル類似度）

```javascript
function similarity(a, b) {
  // 正規化: 全半角統一・記号除去・小文字化
  const na = normalize(a), nb = normalize(b);
  // 既存 credits-enrich/match.py と同等のロジック（difflib ratio 相当）
  return seqRatio(na, nb);
}

for (const v of channelVideos) {
  const best = utanetSongs
    .map(s => ({ ...s, sim: similarity(v.title, s.title) }))
    .sort((a, b) => b.sim - a.sim)[0];
  if (best && best.sim >= 0.85) {
    addCandidate({
      ...v,
      composer: best.composer, lyricist: best.lyricist, arranger: best.arranger,
      source: "utanet", sim: best.sim,
      selected: best.sim >= 0.95
    });
  }
  // sim<0.85 は候補に追加しない
}
```

### Step 5: MusicBrainz 補完（uta-net で0件のチャンネルのみ）

`credits-enrich/mb_trial2.py` のv2正規化ロジックを移植（タイトル末尾の括弧除去・小文字化・記号除去）。
カバー率35%・sim≥0.85で同様フィルタ。

### Step 6: 確定 → 書き戻し

```javascript
const confirmed = candidates.filter(c => c.selected);
for (const c of confirmed) {
  await db.update(c.videoId, {
    composer: c.composer || '',
    lyricist: c.lyricist || '',
    arranger: c.arranger || '',
    creditsSource: `enrich:${c.source}`
  });
  // 既存値が空のフィールドのみ上書き（db.js 既存ロジックの "Force overwrites non-empty" は使わない）
}
```

### エッジケース
- チャンネル名 = アーティスト名でない場合（Topicでないチャンネル）→ uta-net検索で0件のことが多い。スキップ
- uta-net 404 / レート制限ヒット → 該当チャンネルをエラー表示・他チャンネルは継続
- IndexedDB 書き込み中に拡張無効化 → 部分書き込み許容（同一動画への再実行は冪等）
- composer_rules.json と uta-net で異なる結果 → rule 優先（rule適用済 videoId は utanet 検索しない）

---

## UI仕様詳細

### 「Enrich Credits」ボタン配置
- history.html のヘッダー右上「同期」ボタン群の隣
- 押下でモーダル表示（既存モーダル機構が無ければ新規実装）

### モーダル
- 背景クリックで閉じない（誤クリック防止・誤った確定の取り消し不能なため）
- 「キャンセル」「×」「Escキー」でのみ閉じる
- 候補生成中はモーダルを閉じても fetch は中断しない（再開ボタンで進捗保持）

### 進捗表示
- 「12/148ch」形式（現在処理中のチャンネル番号 / 総チャンネル数）
- 残レート: uta-net 残数（1req/秒で N秒後に次fetch可）

### 候補テーブル
- sortable: 既存の az テーブルにあるソート機構を流用
- 大量行（数百件）はchunked rendering（50件ずつ・スクロールで追加）

### 書き戻し
- 確認ダイアログ: `「{N}件の動画にcomposer/lyricist/arrangerを書き込みます。既存値が空のフィールドのみ上書きされます。続行しますか？」`
- 書き戻し中はモーダル全体を disable
- 完了後にトースト表示「N件を更新しました」

### 印刷・コピー・エクスポート
- 不要（IndexedDBへの書き戻しが目的）

---

## デザインシステム準拠

`memory/feedback_html_design_ops.md` 準拠:
- 既存 history.html のネイビー基調・ダークモード対応をそのまま継承
- Lucide SVGアイコン使用（ボタンアイコンは既存と統一）
- 絵文字なし
- ASCII art不使用（flexbox/grid CSSで組む）

---

## 実装ステップ

1. composer_rules.json 作成（fripSide / Nobuo Uematsu の2件）
2. manifest.json 更新（host_permissions に `https://www.uta-net.com/*` `https://musicbrainz.org/*` 追加・version 1.40.0）
3. background.js に message handler 追加（`enrichCreditsUtanet` / `enrichCreditsMb`）
4. enrich_credits.js 新規作成（候補抽出・ルール適用・マッチング・選択管理）
5. history.html にモーダルDOM追加
6. history.js にモーダル開閉・ボタンハンドラ追加
7. uta-net HTML パーサ実装（既存 `utanet_fetch.py` のロジックをJSに移植）
8. MusicBrainz fetch + v2正規化（既存 `mb_trial2.py` ロジック移植）
9. 動作確認（テストケース消化）
10. CHANGELOG.md に v1.40.0 エントリ追加

実装規模: 単一拡張への機能追加で **600〜900行想定**
- enrich_credits.js: 300〜400行（候補抽出・マッチング・選択管理）
- history.js 追加分: 100〜150行（モーダル制御・テーブル描画）
- history.html 追加分: 80〜120行（モーダルDOM・CSS）
- background.js 追加分: 100〜150行（fetch リレー・レート制御・HTMLパース）
- composer_rules.json: 30行

---

## テストケース

### Case 1: 100%固定ルール適用（fripSide）
- 入力: fripSide - Topic チャンネルの未割当 creditsRaw を含む動画
- 期待: composer="Satoshi Yaginuma" / source="enrich:rule" / sim=null / チェックON初期値で候補表示

### Case 2: uta-net 高精度マッチ（HIMEHINA）
- 入力: HIMEHINA チャンネルの「ヒバリ」（タイトル完全一致）
- 期待: sim≥0.95 → チェックON初期値・行背景緑

### Case 3: uta-net 要目視マッチ（sim 0.85-0.95）
- 入力: タイトルに括弧付きサフィックスがある楽曲（例: `「曲名」(TVサイズ)`）
- 期待: sim 0.85-0.95 → チェックOFF初期値・行背景黄・動画タイトルクリックで YouTube 確認可能

### Case 4: マッチ失敗（sim<0.85）
- 入力: 既存 `no_match.json` 相当の6件
- 期待: 候補テーブルに表示されない

### Case 5: レート制限
- 入力: 連続でuta-net取得を発生させるチャンネルが20件
- 期待: 1req/秒で逐次処理・進捗バー更新・中止ボタンで停止可能

### Case 6: 書き戻し冪等性
- 入力: 同じ動画に対して2回 Enrich Credits 確定実行
- 期待: 2回目は composer が既に埋まっているので候補抽出時点でスキップされる（多重書き込みなし）

### Case 7: ルール未該当・uta-net 0件・MB 0件
- 入力: 無名アーティストのTopicチャンネル
- 期待: 該当チャンネルが候補テーブルに表示されない（タブにも出ない）

### Case 8: composer_rules.json と uta-net の競合
- 入力: fripSide の楽曲（rule該当）
- 期待: rule が優先され、uta-net 検索はスキップされる

---

## 公開・配布

- 配布先: 自分用（GitHub公開リポジトリだが、本機能のCWS公開は次フェーズ）
- 公開URL: なし（拡張機能のため）

### 配布前提チェック（自分用のため省略）
- [x] APIキー不要（uta-net / MusicBrainz とも認証なし）
- [x] 外部有料サービス不要
- [x] 個人情報送信なし（送信するのはアーティスト名・曲名のみ）
- [x] ブラウザのみで完結

---

## 想定リスク（Premortem）

### FAILURE STORIES（3つ）
1. **uta-net HTML構造変更で全件パース失敗** → セレクタ依存。検証時点（2026-05-16）のHTMLに準拠
2. **MusicBrainzレート制限違反で拡張がBANされる** → 1req/秒の厳守必須。SW側で確実に制御
3. **誤マッチ書き戻し後の取り消し不能** → 書き戻し前の確認ダイアログ + 既存値が空のフィールドのみ上書き、で軽減

### EARLY WARNING SIGNS
- uta-net パーサが連続でエラー返す → HTML構造変更の兆候
- 候補生成完了まで5分以上かかる → レート制御 or fetch 失敗
- 確定後の az タブで「想定外のアーティスト」が増える → 誤マッチが書き戻された

### HIDDEN ASSUMPTION（最も危険な隠れ前提・1つ）
**「動画タイトルとuta-net曲タイトルの類似度0.85〜0.95は人間が目視で判断可能」** —
実際は曲名違いの同名カバー曲・instrumentalバージョン等、目視でも判別困難なケースがある。
初回運用で誤確定が発生したら、ロールバック手順（書き戻し前のスナップショット保存）を追加で検討。

### 今日進める最小アクション
書き戻し前に「対象 videoId と上書き予定フィールド」を JSON でダウンロード可能にしておく
（事後ロールバック用の最小手段）。設計書「UI仕様詳細 → 書き戻し」に追記済。

---

## バージョン管理

- v1.40.0: Enrich Credits UI 初版（rule / uta-net / MB の3ソース）
- 将来検討:
  - v1.41.x: composer_rules.json への「ソロ作詞家」「ソロ編曲家」ルール追加
  - v1.42.x: 誤確定ロールバック機構（書き戻し履歴の保持と取り消しUI）
  - v1.43.x: 検証データ（mb_trial v3）の精度改善反映

---

## 設計確定日

2026-05-16
