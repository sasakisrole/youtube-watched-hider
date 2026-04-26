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
