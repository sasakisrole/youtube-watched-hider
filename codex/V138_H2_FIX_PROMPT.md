[SESSION] 目的:youtube-watched-hider v1.38.0 H2 修正（Fix Credits + Fix Durations 同時実行ロック） | 編集:実装主導 | 出力:プロジェクトパスに直接書込 | 完了条件:同時実行不可 + 共通レートリミッタ

# タスク: v1.38.0 H2 修正 — メンテナンスバッチの相互排他化

> 全体方針: `C:\Users\sasaki\Dropbox\claude-workspace\.claude\codex-context.md`

## 背景

v1.38.0 レビューレポート（`codex-reports/ad-hoc/yt-watched-hider-v138-review_2026-05-12.md`）の High 指摘 #2：

> Fix Credits と Fix Durations は独立した chrome.runtime.onConnect port を持ち、それぞれ CONCURRENCY=2 で動く。両方同時に開始すると実効4並列で YouTube watch HTML を取得し、`sorry-redirect`（bot 検知 → セッション全体が動画再生不可）を誘発しやすい。進捗 UI も同じ `fixStatus` を奪い合う。

既存 Fix Credits のレート設計（`CONCURRENCY=2, DELAY_MS=500, JITTER_MS=200, sorry-redirect で auto-stop`）は意図的にユーザーの YouTube セッションを守るためのもの。同時実行で破られると本来のリスク回避目的を達成できない。

## 修正方針

以下のいずれか、または両方を組み合わせて実装：

### A. UI ロック（最小限・必須）

- `history.js` で Fix Credits / Fix Durations / Fix Channels / Fix Channels (force) のいずれかが実行中の間、他のメンテナンス系ボタンを `disabled` にする
- 進行中ボタンには「実行中…」表示、他は「他のメンテナンス処理が実行中」とツールチップ
- 中止後にロック解除
- 状態管理は `let runningMaintenance = null;` 程度のローカル変数 + ヘルパー関数で十分

### B. background 側の共通レートリミッタ（推奨・H2の本丸）

- `background.js` に `fetchWatchHtmlQueue` のようなシングルキューを置き、`fetchCreditsFromWatch` / Fix Durations の Watch HTML fetch を1経路に集約する
- グローバル設定: `CONCURRENCY=2, DELAY_MS=500, JITTER_MS=200`（既存 Fix Credits と同じ）
- `sorry-redirect` を受けたら全キューを auto-stop
- キュー内のリクエストには `source: 'fix-credits' | 'fix-durations'` を付け、進捗 callback を呼び分け可能にする

### 実装の優先順位

- **A は必須**（小さい・即効性高い）
- **B は推奨**（A だけだと「同時に押せない」だけで、将来追加するメンテナンス処理が増えたとき同じ問題が再発する）

両方やってください。

## 対象ファイル

- `history.js`: UI ロック実装（fixCredits / fixChannels / fixChannelsForce / fixDurations の click handler 周辺）
- `background.js`: 共通レートリミッタ（`fetchCreditsFromWatch` の呼出経路を統一）
- `CHANGELOG.md`: v1.38.0 エントリに Fix エントリ追加（既存の Fix 項目の隣）

## 制約・注意

- 既存 Fix Credits の挙動を壊さない（並列数2・500ms+jitter・sorry-redirect auto-stop は完全維持）
- abort / disconnect 処理は既存どおり機能すること
- 進捗 callback の payload 形式は既存 UI と互換維持
- `node --check` で全 JS 通ること
- バージョンは **1.38.0 のまま**（patch 扱い・まだ未リリース）
- 既存ファイルへの加筆は **必要最小限**（リファクタ衝動は抑える）

## 出力先

- 実装: `history.js` / `background.js` / `CHANGELOG.md` に直接編集
- 完了レポート: `C:\Users\sasaki\Dropbox\claude-workspace\codex-reports\ad-hoc\yt-watched-hider-v138-h2fix_2026-05-12.md`
  - 変更点サマリー
  - ロックの状態遷移図（簡易・ASCII でよい）
  - 共通レートリミッタの設計（経路図）
  - 既存 Fix Credits との互換性確認

## DoD

- Fix Credits 実行中に Fix Durations / Fix Channels / Fix (force) のボタンが押せない
- background 側で `fetchCreditsFromWatch` 経路と Fix Durations 経路が共通キューに通っている
- `node --check` 通過
- CHANGELOG に Fix エントリ追加
