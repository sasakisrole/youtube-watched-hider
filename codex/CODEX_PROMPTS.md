[SESSION] 目的:youtube-watched-hider 全体コードレビュー＋改善提案＋安全な改修 | 編集:実装主導 | 出力:プロジェクトパスに直接書込 | 完了条件:レビューレポート＋低リスク改善のコード反映

# タスク: youtube-watched-hider コードレビュー＆改善

> 全体方針: `.claude/codex-context.md` に従う。

## 背景

このChrome拡張機能は数ヶ月かけて機能追加してきたため、コード全体の整合性・品質を一度棚卸ししたい。現在 v1.31.3。

## プロジェクト

- パス: `C:\Users\sasaki\Dropbox\claude-workspace\projects\youtube-watched-hider`
- 主要ファイル:
  - `manifest.json` (MV3)
  - `background.js`（service worker）
  - `content.js`（YouTube DOMで動く content script）
  - `db.js`（IndexedDB ラッパー、`var WatchedDB`）
  - `popup.html` / `popup.js` / `popup.css`
  - `history.html` / `history.js`（拡張内Viewer + Analyzer）
  - `analyzer.js`（音楽嗜好分析・推薦プロンプト生成）
- README: `README.md`、CHANGELOG: `CHANGELOG.md`
- リポジトリ: https://github.com/sasakisrole/youtube-watched-hider （公開済み）

## 主な機能

1. YouTube視聴済み動画をホーム/検索結果/関連動画から非表示
2. 視聴履歴をIndexedDBに記録（タイトル・チャンネル・再生回数・視聴元）
3. オートバックアップ（毎日JSONダウンロード）/ Import & Merge
4. Fix Credits: Topic／一般チャンネルから作曲・作詞・編曲クレジットを抽出してDB保存
5. Analyzer: アーティスト・チャンネル・キーワード・クレジット・高評価のランキング表示＋Claude推薦プロンプト生成
6. 高評価プレイリスト（LL）同期: SAPISIDHASH認証つきinnertube API でページング取得（v1.31.3で実装）

## やってほしいこと

### Phase A: 全体レビュー（必須）

以下の観点でファイル全体を読んでチェックし、問題点とその深刻度（critical / warning / info）を整理する：

1. **MV3 / Chrome拡張のベストプラクティス**
   - service worker のライフサイクル考慮（イベントリスナーがトップレベルで登録されているか・state はchrome.storage.localか）
   - メッセージパッシングの設計（content↔background↔popup の役割分担）
   - permissions の最小化（不要な権限がないか）
2. **セキュリティ**
   - innerHTML の使用箇所（XSS耐性）
   - ユーザー入力のサニタイズ
   - 第三者スクリプト読み込みの有無
   - SAPISIDHASH等の認証ヘッダ取り扱い
3. **IndexedDB**
   - スキーマupgrade時のversionchange/blocked対応（v1.30.1で修正済み）
   - 古いタブとの整合性
   - データ移行・accountId管理
4. **パフォーマンス**
   - DOM変更検知（MutationObserver）の効率
   - 大量データ（数万件）のレンダリング・検索
   - 不要な再描画
5. **コード品質**
   - 重複コード・未使用コード・dead code
   - 関数の責務肥大化
   - エラーハンドリングの粒度・統一性
   - 命名規則の一貫性
6. **YouTube構造変更への耐性**
   - セレクタが脆い箇所
   - ytInitialData/innertube API パスの脆さ
   - フォールバックの有無
7. **UI/UX**
   - 設定項目の発見性
   - エラー表示の親切さ
   - 空状態の扱い
8. **ドキュメント**
   - README の現状追従
   - CHANGELOG の網羅性

### Phase B: 安全な改修の実施（推奨）

レビュー結果のうち、**リスクが低く効果が明確な改修** は **そのままコード反映してOK**。判断基準：

- ✅ 反映してよい:
  - 未使用変数・コメント削除
  - エラーハンドリングの追加（既存挙動を変えない範囲で）
  - 重複コードのDRY化（小規模）
  - セレクタのフォールバック追加
  - 型・フォーマットの統一
  - innerHTML→textContent への置換（XSS対策）
  - パフォーマンス最適化（小規模）
- ⚠️ 反映前にレポートで提案して止まる:
  - 機能追加・削除
  - データスキーマ変更
  - メッセージ型の変更
  - 大規模リファクタ（100行超の構造変化）
  - permissions の追加・削除

### Phase C: レポート作成（必須）

`codex-reports/ad-hoc/yt-watched-hider-review_2026-04-26.md` に：

- 概要（一行サマリ）
- 反映済みの改修リスト（ファイル別、変更点を簡潔に）
- 提案だけ残した項目（critical / warning / info で分類）
- バージョン更新の提案（patch / minor / major と理由）
- ユーザー側で動作確認すべきポイント

## 制約・注意

- 既存の機能挙動を壊さないこと（リグレッションNG）
- node 22 で `node --check <file>.js` が通ること
- ユーザー設定（chrome.storage.local の既存キー: `enabled`, `recordWhileOff`, `hideShorts`, `hideMovies`, `harvestMode`, `autoBackup`, `lastBackup`, `lastBackupCount`, `likedSyncMeta` 等）の互換性維持
- IndexedDB スキーマ（DB_VERSION=4, STORE_NAME='watchedVideos', LIKED_STORE='likedVideos'）の互換性維持
- メッセージ型は既存のものを壊さない（追加はOK）
- スタイル: 既存コードに合わせる（const + arrow / async-await、コメント簡潔・英語可）
- バージョンアップ・タグ・publish-release は **やらない**（Claude側でやる）

## ⚠️ 重要: 既存実装の特異点

- **content.js が IndexedDB の所有者**：DB操作は必ず content.js 経由（background→content.js のメッセージ中継）。background.js から直接 indexedDB を触らない
- **`if (typeof WatchedDB === 'undefined')` ガード**：db.js は同一タブに2回 inject されることを想定
- **content scripts は extension reload 時に "orphaned" になる**：旧content.jsが残ると DB upgrade が blocked になる（v1.30.1 で `onversionchange` 追加で修正済み）
- **manifest.json の host_permissions は `*://*.youtube.com/*` のみ**：他のドメインに広げない
- **v1.31.3 で SAPISIDHASH 認証実装**：`computeSapisidHash()` in content.js。ChromiumのCookie APIではなく `document.cookie` で取得（SAPISIDはhttpOnlyではない）

## 完成物

1. 改修したコード（`background.js` / `content.js` / `db.js` / `analyzer.js` / `history.js` / `popup.js` / `history.html` / `popup.html` のうち必要なもの）
2. `codex-reports/ad-hoc/yt-watched-hider-review_2026-04-26.md` に：
   - 全体評価（5段階＋一言）
   - 反映済み改修一覧（ファイル別・diff要約）
   - 提案だけ残した項目（深刻度分類）
   - 推奨する次バージョン（v1.31.4 patch / v1.32.0 minor / v2.0.0 major）と理由
   - 動作確認ポイント

## 進め方

- Phase A → Phase B → Phase C を一気通貫でやってOK
- 大規模リファクタが必要だと判断した場合は Phase B の改修は最小限にして、Phase C の提案でメインに伝える
- WebSearch で MV3ベストプラクティス・SAPISIDHASH安全性などを必要に応じて調査してOK

---

## v1.35.0 設計フェーズ（2026-04-27 委託）

[SESSION] 目的: youtube-watched-hider v1.35.0 の設計書のみ作成（実装はしない） | 編集: 設計ドキュメント作成のみ | 出力: codex-reports/ad-hoc/yt-watched-hider-v135-design_2026-04-27.md＋プロジェクト内 V135_DESIGN.md | 完了条件: 5項目すべての設計案・移行計画・破壊的変更影響を1本のMDにまとめる

# タスク: youtube-watched-hider v1.35.0 設計書作成

## プロジェクト
- パス: `C:\Users\sasaki\Dropbox\claude-workspace\projects\youtube-watched-hider`
- 現行版: v1.34.3
- 既存ファイル: `manifest.json` / `background.js` / `content.js` / `db.js` / `popup.js` / `history.js` / `analyzer.js` / `CHANGELOG.md` / `README.md`
- レビュー元: `C:\Users\sasaki\Dropbox\claude-workspace\codex-reports\ad-hoc\yt-watched-hider-review_2026-04-26.md`（このレポートの "提案だけ残した項目 / warning" 5項目を全て対象）

## やってほしいこと

実装はせず、**v1.35.0 minor の設計書1本** を出してください。スコープは下記5項目を一括で扱います。各項目は独立に見えますが「DBオーナー位置・スキーマ」が共通基盤なので、相互依存・実装順序まで設計に含めてください。

## 対象 warning 項目（レビュー2026-04-26）

1. **likedVideos複合キー化**: 現状 `keyPath: 'videoId'`（`db.js:34`）で複数Googleアカウントの同一動画が1レコードに潰れる。DB **v6** で `[accountId, videoId]` 相当の複合キーに移行する。
2. **Export schema v2**: `EXPORT_DATA` は `WatchedDB.exportAll()` で `watchedVideos` のみ。`likedVideos` / `likedSyncMeta` も export/auto backup 対象にする。後方互換 import（v1スキーマ）も維持する。
3. **offscreen document でDBオーナーを拡張側に移す**: 現状 `background.js:99` の `sendToYouTubeTab()` で content.js に DB を寄せており、YouTubeタブが無いと History Viewer / Popup Export / Auto Backup が動かない。Chrome Extensions Offscreen API でDBを拡張側に持つ。**自動バックアップの大容量対応（base64 data URL → Blob URL）も同じ offscreen で扱う**。
4. **Innertube同期の堅牢化**: `syncLikedPlaylist()`（`background.js:845`）の `X-Goog-AuthUser` 固定や owner identity 推定が、複数Googleアカウント・YouTube DOM変更で壊れやすい。複数アカウント対応・アカウント識別の安定化方針を設計する。
5. **5万件超キャッシュのLRU化**: `content.js` の `CACHE_MAX_SIZE = 50000`（`content.js:90, 107`）超過時に cache を捨てており、watchページの1秒ポーリング（`content.js:1523`）で DB問い合わせが急増する。10万件級を見込む LRU/分割キャッシュ/セッションキャッシュ上限の再設計。

## 要件

1. **設計書1本にまとめる**（5項目を別ファイルに分割しない）。出力先は2箇所：
   - 主成果物: `projects/youtube-watched-hider/codex/V135_DESIGN.md`
   - 報告書: `codex-reports/ad-hoc/yt-watched-hider-v135-design_2026-04-27.md`（V135_DESIGN.md への参照と要点サマリ）
2. 各項目は次の小節で構成する：
   - **現状コード位置**（ファイル:行）
   - **目的・解決する問題**
   - **設計案**（データ構造・API・呼び出しフロー）
   - **DBマイグレーション**（該当項目のみ。v5 → v6 の onupgradeneeded での処理。既存レコードの保全・accountId 不明レコードの扱い）
   - **破壊的変更**（manifest 権限追加・メッセージ型変更・export schema 変更・後方互換）
   - **テスト観点**
3. **実装順序とフェーズ分け**を最後に1セクションで提示。①〜⑤の依存関係を整理し、PR分割案も。
4. **前提・未決事項**は明示。Codex独断で決めない（例: offscreen化に伴う `offscreen` 権限・`reasons` 配列の選択、複数アカウント識別の具体手段）。
5. 既存の v1.31.x の同期実装、v1.34.x の Fix Credits、v1.31.4 の XSS耐性改修などは温存前提で設計する（破壊しない）。

## 制約・注意

- **実装はしない**。コードスニペットは「設計を伝えるための擬似コード」までに留める。実コード差分は出さない。
- 既存ファイル構成・命名規則・MV3 service worker前提を踏襲。
- 言語は日本語（コード識別子は英語のまま）。
- WebSearch で Chrome Offscreen API・IndexedDB v6移行ベストプラクティス・YouTube Innertube の `X-Goog-AuthUser` 周辺を必要に応じて調査してOK。

## 既存OSS実装・参考資料

- Chrome Offscreen API: https://developer.chrome.com/docs/extensions/reference/api/offscreen
- yt-dlp `_tab.py` の `generate_api_headers`（複数アカウント・SAPISIDHASH）
- `db.js` の現行 onversionchange / onblocked / open timeout 実装は v1.30.1 で導入済（破壊しない）

## 完成物

1. `projects/youtube-watched-hider/codex/V135_DESIGN.md`（本体・5項目の詳細設計＋実装順序）
2. `codex-reports/ad-hoc/yt-watched-hider-v135-design_2026-04-27.md`（要点サマリ・本体への参照・判断ポイント・未決事項一覧）

## 進め方

- 設計書を出した段階で **停止**。実装フェーズは別委託。
- 設計だけで判断不能な箇所は「⚠️判断要」として未決のまま残す（Claude+ユーザーで決める）。

---

## Enrich Credits UI 委託（v1.40.0・2026-05-16）

返答は `C:\Users\sasaki\Dropbox\claude-workspace\codex-reports\ad-hoc\yt-watched-hider-enrich-credits_2026-05-16.md` に出力してください。方針は `.claude/codex-context.md` および `AGENTS.md` に従う。

[SESSION] 目的:Chrome拡張 yt-watched-hider に Enrich Credits UI 追加 | 編集:実装主導 | 出力:projects/youtube-watched-hider/ 直下に直接書込 | 完了条件:設計書テストケース Case 1-8 を全てpassかつ動作確認可能なv1.40.0が成立

# タスク: yt-watched-hider Enrich Credits UI 実装

## プロジェクト
- パス: `C:\Users\sasaki\Dropbox\claude-workspace\projects\youtube-watched-hider\`
- **設計書（必読・本タスクの正本）**: `projects/youtube-watched-hider/DESIGN_enrich_credits.md`
- 既存ファイル（変更対象）: manifest.json / background.js / history.html / history.js / CHANGELOG.md
- 既存ファイル（参照のみ・変更禁止）: content.js / popup.js / db.js / analyzer.js
- 既存検証成果物（リファレンス実装・Python）: `projects/youtube-watched-hider/credits-enrich/`
  - `utanet_fetch.py` — uta-net HTML パース実装の参考
  - `mb_trial2.py` — MusicBrainz v2正規化ロジックの参考
  - `match.py` — タイトル類似度マッチングの参考
  - `step1_rule_based.py` — 固定ルール適用の参考
  - `enrichment_step1.json` / `enrichment_step2_utanet.json` — 期待出力の参考データ

## 会話文脈サマリ

### 確定前提
- バージョン: v1.40.0（manifest.json の version 1.39.0 → 1.40.0）
- アーキテクチャ: content script (history.js) → SW (background.js) → uta-net/MB fetch のリレー構成（MV3 CORS制約のため）
- uta-net 正規URL: `https://www.uta-net.com/search/?Aselect=1&Bselect=4&Keyword=<artist>`（Aselect=1, Bselect=4 で確定済み）
- レート制限: uta-net 1req/秒・MusicBrainz 1req/秒（SW側で厳守）
- composer_rules.json は拡張同梱（初版は fripSide / Nobuo Uematsu の2件のみ）
- 書き戻し方針: 既存値が空のフィールドのみ上書き（既に composer がある行は触らない）
- 補完優先順: ①固定ルール → ②uta-net → ③MusicBrainz（ルール適用済はuta-net検索スキップ）
- sim 閾値: 0.95以上で自動チェック / 0.85以上0.95未満で要目視（チェックOFF初期） / 0.85未満は非表示
- 各候補に `source` 記録（"rule" / "utanet" / "mb"）→ DB書き戻し時 `creditsSource` を `enrich:rule` / `enrich:utanet` / `enrich:mb` で記録
- UI: history.html にモーダル追加（背景クリックで閉じない・Esc/×/キャンセルでのみ閉じる）

### 未決事項
- Lucide SVGアイコンの具体的な選定: 仮置きOK
- モーダルのCSSアニメーション: 仮置きOK（既存トーンに合わせる）
- 大量行のchunked rendering詳細: 仮置きOK（50件/chunk）

### 変更禁止
- 既存 `fixCreditsForRange`（history.js:412〜）の概要欄fetchルートは温存・変更しない
- content.js / popup.js / db.js / analyzer.js は変更しない
- 既存 manifest.json の host_permissions（`*://*.youtube.com/*`）・permissions は維持（追加のみ）
- 既存IndexedDBスキーマ（db.js）の変更禁止。書き込みは既存 `composer/lyricist/arranger/creditsSource` フィールドのみ
- 既存 history.html のヘッダー・既存ボタン群のレイアウト変更禁止（「Enrich Credits」ボタンを追加するのみ）

### 検証条件（ルーブリック）
1. **manifest.json**: version="1.40.0" / host_permissions に `https://www.uta-net.com/*` `https://musicbrainz.org/*` が追加されている → pass/fail
2. **composer_rules.json**: 拡張ルートに存在し、fripSide-Topic と Nobuo Uematsu-Topic の2ルールを含む → pass/fail
3. **Case 1 (rule適用)**: fripSide-Topic チャンネルの未割当行に対し source="rule" sim=null selected=true の候補が生成される → pass/fail
4. **Case 2 (uta-net高精度)**: uta-net 検索でタイトル完全一致時 sim>=0.95 / selected=true / 行背景緑 → pass/fail
5. **Case 3 (uta-net要目視)**: sim 0.85-0.95 で selected=false / 行背景黄 / タイトルクリックで youtu.be/{videoId} が新タブで開く → pass/fail
6. **Case 4 (マッチ失敗)**: sim<0.85 は候補テーブルに表示されない → pass/fail
7. **Case 5 (レート制限)**: uta-net への連続fetch が1req/秒以下に制御される（SW側のタイマーで確認可能） → pass/fail
8. **Case 6 (冪等性)**: 既に composer が埋まっている行は候補抽出時点でスキップされる → pass/fail
9. **Case 7 (全ソース0件)**: ルール未該当・uta-net 0件・MB 0件のチャンネルはタブ表示されない → pass/fail
10. **Case 8 (rule優先)**: rule該当チャンネルは uta-net 検索がスキップされる → pass/fail
11. **書き戻し**: 確認ダイアログ → 既存値が空のフィールドのみ上書き → 完了トースト → モーダル閉じる、の動線が成立 → pass/fail
12. **デザイン**: 絵文字なし・Lucide SVG・ネイビー基調・ダークモード対応 → pass/fail
13. **CHANGELOG.md**: v1.40.0 エントリが先頭に追加されている → pass/fail
14. **既存機能の回帰なし**: 既存の az クレジットタブ・概要欄fetch（fixCreditsForRange）・履歴同期等が破壊されていない → pass/fail

## ⚠️ 重要: 既存ストレージへの書き戻し

書き戻しは **既存IndexedDB（db.js）の既存スキーマ・既存フィールドのみ** に行う。新スキーマ追加禁止。

### 書き込み対象フィールド
既存db.js のレコード構造（スキーマ変更禁止）:
- `videoId`: string（変更禁止）
- `composer`: string（既存値が空文字の場合のみ上書き）
- `lyricist`: string（既存値が空文字の場合のみ上書き）
- `arranger`: string（既存値が空文字の場合のみ上書き）
- `creditsSource`: string（"enrich:rule" / "enrich:utanet" / "enrich:mb" を記録）
- `creditsRaw`: string（変更禁止・読み出しのみ）

### 書き込み実装
db.js の既存メソッド（既存 updateCredits 系・db.js:228 付近）を活用すること。新規メソッド追加が必要なら最小限に。

## やってほしいこと

1. **設計書 `DESIGN_enrich_credits.md` を最初に熟読** し、未決事項以外は設計書の指示に従う。
2. composer_rules.json を新規作成（fripSide / Nobuo Uematsu の2件）。
3. manifest.json 更新（host_permissions追加・version=1.40.0）。
4. background.js に message handler 追加: `enrichCreditsUtanet`（artist → 曲リスト）/ `enrichCreditsMb`（artist+title → composer候補）。レート制御は SW グローバル状態で実装。HTMLパース処理も SW 側で完結（content scriptに渡さない）。
5. enrich_credits.js 新規作成: 候補抽出（DB読み出し+フィルタ）/ ルール適用 / マッチング（タイトル類似度・正規化はPython `match.py` 同等）/ 選択管理 / 書き戻し。
6. history.html にモーダルDOM・CSS追加（ネイビー基調・ダークモード対応・Lucide SVG）。
7. history.js に「Enrich Credits」ボタン押下ハンドラ・モーダル開閉・候補テーブル描画（chunked rendering 50件/chunk）追加。
8. CHANGELOG.md に v1.40.0 エントリ追加（先頭に追加・既存エントリ削除禁止）。
9. Playwright等での実画面検証は **不要**（拡張機能のためE2E困難）。代わりに各JSファイルの構文チェック（`node -c` 相当）と、設計書テストケース Case 1-8 のロジックを単体検証可能な形でコードコメントに残すこと。

## 入力データ仕様

### IndexedDB 抽出条件
`record.creditsRaw && !record.composer && !record.lyricist && !record.arranger`

### uta-net HTMLパース対象（リファレンス: credits-enrich/utanet_fetch.py）
- 検索結果ページのアーティスト一覧テーブル → アーティスト詳細ページURL抽出
- アーティスト詳細ページの曲リスト → 各曲の composer/lyricist/arranger 抽出
- 文字コード: UTF-8（uta-net は標準UTF-8配信）

### MusicBrainz API（リファレンス: credits-enrich/mb_trial2.py）
- エンドポイント: `https://musicbrainz.org/ws/2/recording/?query=...&fmt=json`
- User-Agent ヘッダ必須: `yt-watched-hider/1.40.0 (https://github.com/yourrepo)` 形式
- レート: 1req/秒

## テストデータ・サンプルパス（絶対パス）
- 期待出力リファレンス（rule適用済220件）: `C:\Users\sasaki\Dropbox\claude-workspace\projects\youtube-watched-hider\credits-enrich\enrichment_step1.json`
- 期待出力リファレンス（uta-netマッチ77件・sim付き）: `C:\Users\sasaki\Dropbox\claude-workspace\projects\youtube-watched-hider\credits-enrich\enrichment_step2_utanet.json`
- uta-net取得済キャッシュ: `C:\Users\sasaki\Dropbox\claude-workspace\projects\youtube-watched-hider\credits-enrich\cache\utanet_*.json`
- 未解決チャンネル一覧: `C:\Users\sasaki\Dropbox\claude-workspace\projects\youtube-watched-hider\credits-enrich\unresolved.tsv`

これらは「Python版で動作確認済の期待挙動」を示すリファレンス。JS実装は同等のマッチング結果を再現することが望ましい。

## 制約・注意

- **Chrome MV3 制約**: content scriptから直接 uta-net.com / musicbrainz.org への fetch は CORS で失敗する。必ず Service Worker (background.js) 経由でリレーする
- **レート制御**: SW のグローバル状態で「最後にfetchした時刻」を保持し、1秒経過していなければ `setTimeout` で待機。複数チャンネル並列処理時も全体で1req/秒を厳守
- **HTMLパース**: DOMParser を SW で使う場合は offscreen document が必要（background.js は DOMParser を持たない）。既存 `offscreen.html`/`offscreen.js` の活用検討（既にoffscreen permission 付与済）。または正規表現ベースのパースで対応
- **デザインシステム**: `AGENTS.md`（ワークスペースルート）の規約に従う。ネイビー基調 / 絵文字なし / Lucide SVG / ダークモード対応
- **既存スタイル整合**: history.html の既存CSS変数（`--text-muted` 等）を流用すること

## ⚠️ 重要: 想定リスク（設計書「想定リスク」セクション再掲）

**HIDDEN ASSUMPTION**: 「動画タイトルとuta-net曲タイトルの類似度0.85-0.95は人間が目視で判断可能」 — 同名カバー曲・instrumentalバージョン等で目視判別困難なケースがある。書き戻し前のロールバック手段として、確定対象の `{videoId, composer, lyricist, arranger, source, sim}` を JSON でダウンロードできるボタンをモーダルフッターに追加すること（設計書セクション「UI仕様詳細 > 書き戻し」記載済）。

## 完成物

1. `projects/youtube-watched-hider/composer_rules.json`（新規）
2. `projects/youtube-watched-hider/manifest.json`（更新）
3. `projects/youtube-watched-hider/background.js`（追記）
4. `projects/youtube-watched-hider/history.html`（追記）
5. `projects/youtube-watched-hider/history.js`（追記）
6. `projects/youtube-watched-hider/enrich_credits.js`（新規）
7. `projects/youtube-watched-hider/CHANGELOG.md`（追記）
8. **成果物レポート**: `codex-reports/ad-hoc/yt-watched-hider-enrich-credits_2026-05-16.md`
   - 作成・変更ファイル一覧
   - 検証条件1-14のpass/fail判定（自己採点）
   - 設計書からの逸脱があれば項目別に明記
   - 未決事項の仮置き判断とその根拠
   - 動作確認手順（Chrome に読み込ませてから何を確認すべきか）

## 進め方

- 設計書 `DESIGN_enrich_credits.md` を熟読 → 不明点があればレポート冒頭に「⚠️判断要」として記載しつつも、未決事項に該当する範囲なら仮置きで進めて構わない
- 既存ファイル（manifest.json / background.js / history.html / history.js）は **必ず先にRead** してから編集。既存スタイル・既存命名規則に合わせる
- credits-enrich/ 配下のPythonリファレンス実装を読んで、同等のマッチングロジックをJSで再現する


---

## チャンネルページ 一括キュー/後で見る 対応（v1.41.0・2026-05-22 委託）

[SESSION] 目的:チャンネル動画ページで表示中動画を一括キュー/後で見る追加するボタンを設置 | 編集:実装主導 | 出力:プロジェクトパスに直接書込 | 完了条件:検証条件を全てpass

# タスク: yt-watched-hider チャンネルページ一括キュー/後で見るボタン

> 全体方針: `.claude/codex-context.md` に従う。HTMLデザインシステムは対象外（拡張機能のUI注入であり既存ボタンのスタイルを踏襲する）。

## プロジェクト

- パス: `C:\Users\sasaki\Dropbox\claude-workspace\projects\youtube-watched-hider`
- 改修対象: `content.js`（2237行・MV3 content script）、`manifest.json`（versionバンプ）、`CHANGELOG.md`（追記）
- リポジトリ: https://github.com/sasakisrole/youtube-watched-hider （公開済み・MV3）

## 背景

現在 v1.40.0 で、**watchページ（/watch）の関連動画サイドバー** に対しては既に2つの一括ボタンが実装済み：

- 「⏭ キューに追加 (N)」… `ensureQueueAllButton()` / `findQueueableCards()` / `queueOneCard()` / `onQueueAllClick()`
- 「後で見る (N)」… `ensureWatchLaterButton()` / `findWatchLaterableCards()` / `watchLaterOneCard()` / `onWatchLaterClick()`

仕組みは「対象カードのケバブ（︙ = `button[aria-label*="その他の操作"]`）をプログラムからクリック → ポップアップから『キューに追加』『後で見る』の項目を探してクリック」という DOM 自動操作。

これを **チャンネルの動画一覧ページ（例: https://www.youtube.com/@ferumi/videos）** でも使えるようにしたい。「表示中の動画一式」をまとめてキュー追加・後で見る追加できるボタンをグリッド上部に出す。

## 会話文脈サマリ（Claude側で確定済み・Codexは会話履歴を見られない前提）

### 確定前提
- 対象は **チャンネルの「動画」タブ**（`/@handle/videos`, `/channel/<ID>/videos`, `/c/<name>/videos`, `/user/<name>/videos`）。「ライブ」「ショート」タブやホームタブは今回スコープ外（ただし誤動作せず単に非表示ならOK）。
- 「表示中の動画一式」= DOMにレンダリング済みのグリッドカードを対象とする（既存watch実装と同じ「可視カードのみ」方針）。ユーザーがスクロールして読み込んだ分が対象。全動画の自動スクロール収集は **しない**。
- 既存のwatchページ向け挙動は **一切変えない**（リグレッション厳禁）。チャンネル対応は追加であって置換ではない。
- ボタンのスタイル・文言・確認ダイアログ・中止ボタン挙動は既存2ボタンを踏襲する。

### 実機確認済みDOM（2026-05-22 ユーザーのブラウザのコンソールで確認）
チャンネル動画ページ `https://www.youtube.com/@ferumi/videos` で実測：
```json
{
  "gridExists": true,                  // ytd-rich-grid-renderer が存在
  "richItemCount": 777,                // ytd-rich-item-renderer の数（スクロール蓄積分）
  "mediaTag": "yt-lockup-view-model",  // カード内のメディア要素は新UIの yt-lockup-view-model
  "kebabAria": "その他の操作",          // ★既存コードのケバブセレクタと完全一致
  "linkSel": "/watch?v=GneSXH6lt0Q",   // a[href*="/watch?v="] で動画リンク取得可
  "firstItemTags": ["div", "yt-interaction"]  // rich-item-renderer直下はdiv/yt-interaction（lockupはさらに内側）
}
```
→ **カードコンテナは `ytd-rich-item-renderer`**。その内側に `yt-lockup-view-model` と動画リンク `a[href*="/watch?v="]`、ケバブ `button[aria-label*="その他の操作"]`（=既存 `queueOneCard`/`watchLaterOneCard` のセレクタがそのまま当たる）。

### 未決事項（Codex仮置き判断でOK）
- ボタンの正確な挿入位置: グリッド最上部（フィルターチップ行の下・1枚目のカードの上あたり）に横並びで2ボタン。具体的なアンカー要素はDOM構造に合わせてCodexが選定してよい。`ytd-rich-grid-renderer` の直前、または `#contents.ytd-rich-grid-renderer` の最初のカードの前など、レイアウトが崩れない位置を選ぶ。
- 大量カード時の安全策のUI文言（下記「要件7」参照）。

### 変更禁止
- 既存の `/watch` ページ向けボタン挙動・セレクタ・関数の外部から見える振る舞い。
- `seedQueueWithCurrentVideo()` の watch時の動作。
- IndexedDB・background.js・popup 系には触らない。

### 検証条件（ルーブリック・全てpassで完成）
1. `/@handle/videos` を開くと、グリッド上部に「⏭ キューに追加 (N)」「後で見る (N)」の2ボタンが表示される（N=対象カード数）。pass/fail
2. 「キューに追加」を押すと確認ダイアログ → OKで各カードのケバブが順次開閉し、表示中動画がYouTubeのキューに追加される。pass/fail
3. 「後で見る」を押すと同様に各動画が「後で見る」に追加される。pass/fail
4. 処理中はボタンが「追加中 i/N（クリックで中止）」表示になり、クリックで中止できる（既存挙動と同じ）。pass/fail
5. Shorts・ライブ・プレイリスト/ミックスのカードは対象から除外される。pass/fail
6. **`/watch` ページの既存2ボタンが従来通り動作する**（リグレッションなし）。pass/fail
7. チャンネルページ ⇄ watchページ ⇄ ホーム のSPA遷移でボタンが正しく出現/消滅し、二重生成・幽霊ボタンが残らない。pass/fail
8. 対象カード数が多い場合（例: 50件超）に確認ダイアログで件数と所要見込みを警告する。pass/fail

## やってほしいこと

既存のwatchページ向け一括ボタン実装を **チャンネル動画ページにも対応させる**。実装方針はCodexが選んでよいが、推奨は「ページコンテキスト（watch / channel）を判定し、カード探索セレクタ・アンカー探索・現在動画シードの有無をコンテキストで分岐させる」リファクタ。既存watch挙動を壊さない範囲で共通化する。

## 要件

1. **ページ判定の追加**: 現状 `ensureQueueAllButton()` は `location.pathname !== '/watch'` で早期return、`isWatchLaterSupportedPage()` も `=== '/watch'` 限定。これをチャンネル動画ページでも有効になるよう拡張する。チャンネル動画ページの判定は `location.pathname` が `/videos` で終わる、かつ `ytd-rich-grid-renderer` が存在することを条件にする（`/@`, `/channel/`, `/c/`, `/user/` 配下いずれも）。
2. **チャンネルグリッド用カードセレクタ**: 対象カード = `ytd-rich-grid-renderer ytd-rich-item-renderer` のうち、内部に `a[href*="/watch?v="]` を持つもの。既存の除外条件（`offsetParent === null` 非可視、`dataset.watchedHidden/shortsHidden/movieHidden === 'true'`、Shortsリンク `a[href*="/shorts/"]`、ライブバッジ、プレイリスト/ミックス）をチャンネルカードにも適用する。`isPlaylistCard()` 相当の判定も流用する。
3. **per-card処理の流用**: `queueOneCard()` / `watchLaterOneCard()` のケバブ→メニュー項目クリックのロジックはチャンネルカードでもそのまま使える（ケバブ `aria-label="その他の操作"` 一致を実機確認済み）。新規に書き直さず流用すること。
4. **現在動画シードのスキップ**: チャンネルページには再生中動画が無いため、`onQueueAllClick()` の `seedQueueWithCurrentVideo()` 呼び出しはチャンネルコンテキストでは実行しない（watch時のみ）。
5. **ボタン挿入とアンカー**: チャンネル用のアンカー探索関数を用意し、グリッド上部にボタンを置く。`grid-column:1 / -1` 等で grid セル内に押し込まれて 0px にならないよう注意（既存watch実装の `queueAllBtn` で同じ対策あり・content.js内コメント参照）。既存watchボタンと同じスタイル/文言を使う。
6. **SPA遷移・DOM再生成への追従**: 既存の MutationObserver 再挿入（`onQueueBtnMutation` 等）と `ensureQueueAllButton`/`ensureWatchLaterButton` 呼び出し箇所（content.js 1352-1385 付近の observer デバウンス・初期 setTimeout）を、チャンネルページでも正しく出現/消滅するよう調整する。watch→channel→home の遷移で幽霊ボタンが残らないこと。
7. **大量カード時の安全策**: チャンネルページは数百カードがDOMに載りうる（実測777件）。確認ダイアログに件数を明示し、件数が多いと処理に時間がかかり順次メニューが開閉する旨を警告する（既存の confirm 文言を活かしつつ件数連動で注意を強める）。可能なら処理間 sleep は既存値を踏襲（キュー120ms / 後で見る150ms）。

## ⚠️ 重要: 既存実装の特異点（必ず content.js を Read してから着手）

- `RELATED_CARD_SELECTORS`（content.js:1510付近）は **watch関連動画専用**。チャンネルグリッドには使えないので別セレクタを用意する。
- `findQueueableCards()` / `findWatchLaterableCards()` は現状 `RELATED_CARD_SELECTORS` をハードコード参照。コンテキスト分岐 or 引数化して、チャンネル時は rich-grid セレクタを使うようにする。
- `findWatchLaterAnchor()` は watch専用（`ytd-watch-next-secondary-results-renderer` 等）。チャンネル用アンカーは別関数に。
- ボタンのstate変数（`queueAllBtn`, `queueInProgress`, `watchLaterBtn` 等）はモジュールスコープのシングルトン。ページ種別が変わったときに前ページのボタン参照が残らないよう破棄する（既存の `if (location.pathname !== '/watch') { ...remove... }` パターンを一般化）。
- 既存の getter（`getVideoIdFromHref`, `getCurrentVideoId`）を流用する。チャンネルでは現在動画IDは無いので watch later の「現在動画を除外」条件はチャンネル時はスキップでよい。

## 完成物

1. `content.js`（チャンネルページ対応の追加・既存watch挙動は不変）
2. `manifest.json`（version 1.40.0 → 1.41.0 にバンプ）
3. `CHANGELOG.md`（v1.41.0 エントリ追記。先頭に追加）
4. **成果物レポート**: `codex-reports/ad-hoc/yt-watched-hider-channel-bulk_2026-05-22.md`
   - 作成・変更ファイル一覧と差分概要
   - 検証条件1-8の自己採点（pass/fail）。実ブラウザ動作はCodexでは確認不能なので「コード上の根拠」で判定し、ブラウザ実機確認が必要な項目はその旨明記
   - 採用した実装方針（コンテキスト分岐 or 共通化の設計）
   - 未決事項（ボタン位置等）の仮置き判断とその根拠
   - **ユーザー（Claude/けんと）が手元のChromeで確認すべき手順**（拡張リロード→対象URL→何を見るか）

## 進め方

- まず `content.js` の該当領域（1352-1385 の observer 呼び出し / 1509-1761 の Queue All / 1775-2000付近の Watch Later）を **必ず Read** してから着手。既存命名・既存スタイルに合わせる。
- watch挙動のリグレッションを避けるため、既存関数の振る舞いは温存し、チャンネル分岐を「足す」方針を優先する。大規模な共通化リファクタをするなら、watch経路の出力が変わらないことをコード上で担保する。
- 実ブラウザ検証はCodex環境では不可。コードレビューで通る形まで仕上げ、レポートに「人間が実機で確認すべきチェックリスト」を残す。
