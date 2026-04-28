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
