[SESSION] 目的:youtube-watched-hider v1.38.0（durationSec 追加・累計再生時間集計）の実装 | 編集:実装主導 | 出力:プロジェクトパスに直接書込 | 完了条件:DB v5 マイグレーション + FIX_DURATIONS バッチ + analyzer 累計時間表示 + 実機検証手順書

# タスク: v1.38.0 durationSec 集計

> 全体方針: `.claude/codex-context.md` に従う。

## プロジェクト

- パス: `C:\Users\sasaki\Dropbox\claude-workspace\projects\youtube-watched-hider`
- 現行バージョン: v1.37.1
- 設計書: `codex/V135_DESIGN.md` §6「durationSec 取得・累計再生時間集計」必読
- 関連設計（参考のみ・本PRでは扱わない）: §1 likedVideos 複合キー化 / §4 Innertube 同期堅牢化 → **複数アカウント運用は実需薄のため凍結**。本PRに含めない

## 目的

analyzer でチャンネル別・クレジット（作詞作曲編曲）別の **累計再生時間（=視聴済み動画の総尺）** を表示できるようにする。

現状の `watched` レコードは `title` / `channel` / credits 系のみで `durationSec` を保持していないため、件数集計しかできない。

## スコープ

### A. DB v4 → v5 マイグレーション

- `db.js:6` の `DB_VERSION = 4` を **5** に上げる
- `watchedVideos` レコードに `durationSec: number | null` フィールドを追加（既存レコードは `null` のまま）
- マイグレーション処理: `event.oldVersion < 5` で `watchedVideos` を cursor 走査し、`durationSec` が未定義のレコードに `null` をセット（明示的に `null` を入れることで FIX_DURATIONS の対象判定 `=== null` が動く）
- 既存の `oldVersion < 2` / `oldVersion < 4` の処理は維持
- `feedback_indexeddb_upgrade.md` 準拠（`onversionchange` / `onblocked` / timeout は現行維持）

### B. 新規視聴時の durationSec 記録

`content.js:415` 等の `DBClient.addWatched(videoId, title, source, channel)` 経路で、可能なら `durationSec` も一緒に保存する。

- 取得経路: watch ページの `ytInitialPlayerResponse.videoDetails.lengthSeconds`（DOM から直接読める）
  - `document.querySelector('meta[itemprop="duration"]')` でも取れるが ISO 8601（PT4M33S）なので lengthSeconds の方が単純
  - 取得失敗時は `null` を渡す（必須にしない・記録自体は止めない）
- `DBClient.addWatched` のシグネチャを拡張: `addWatched(videoId, title, source, channel, durationSec = null)`
- DB RPC `ADD_WATCHED` の payload に `durationSec` を追加し、offscreen 側の保存ロジックも対応

シグネチャ変更前に **全呼出元を grep** して `null` 引数を補うこと（`feedback_signature_change_grep.md` 準拠）。現状の呼出元: `content.js:415` / `:523` / `:1129`。

### C. FIX_DURATIONS バッチ（バックフィル）

既存 `FIX_CREDITS`（`background.js:977` `fixCreditsBatch` / `:1080` `chrome.runtime.onConnect` `fix-credits` port）と **同じ構造** で `FIX_DURATIONS` を新設する。

- 対象: `durationSec === null` の watched レコード（約11,500件想定）
- 取得経路: `FETCH_WATCH_HTML` 経路（`fetchCreditsFromWatch` と同じ・`background.js:923`）
  - HTML の `ytInitialPlayerResponse.videoDetails.lengthSeconds` を文字列で抽出 → `Number()` で数値化
  - **`isLiveContent: true` の動画は `durationSec = -1` 等のセンチネル値で「対象外マーク」**（再ループ防止・lengthSeconds は信頼できない）
  - 抽出失敗（削除済み・privé・age-gate 等）は `durationSec` を埋めず、別フィールド `durationFetchFailed: <reason>` を立てて再試行から外す
- レート・並列・abort・auto-stop: `fixCreditsBatch` と同等（CONCURRENCY=2, DELAY_MS=500, JITTER_MS=200, sorry-redirect で全停止）
- 進捗 UI: 既存の Fix Credits UI（analyzer 内）と並列で配置。共通化できる部分は helper 化してよいが、過度な抽象化は避ける
- DB RPC: `UPDATE_DURATION` / `MARK_DURATION_FAILED` / `MARK_DURATION_LIVE` を offscreen に追加

### D. analyzer 累計時間表示

- **チャンネル別**（`renderChannels` `analyzer.js:85`）: 既存「再生数」列の隣に「合計時間」列を追加
  - 表示形式: `12時間34分` / `45分` / `2秒`（時間が0なら分・分が0なら秒）。`hh:mm:ss` 形式も検討してよい
  - ソート: 既存は再生数降順。合計時間でもソート可能にする（列ヘッダクリック）か、または「再生数」「合計時間」のラジオで切替
- **クレジット別**（`renderCredits` `analyzer.js:180`）: 同様に「合計時間」列追加
- **null 混入時の扱い**: 合計は null を無視して計算し、セル末尾に `（うち N件 不明）` を併記
- 全動画 null（バックフィル未実行時）は列ヘッダのみ表示し、各行は `—` 表示で混乱回避

## スコープ外（凍結）

- DB v6 / `likedVideos` 複合キー化（設計書 §1）→ 複数アカウント運用していないため凍結
- Innertube 同期の堅牢化 / `X-Goog-AuthUser` 動的化（設計書 §4）→ 同上
- Cache LRU（設計書 §5）→ 別PR
- Export v2 envelope への `durationSec` 追加 → **本PRには含めない**（既存 v2 envelope は `watchedVideos` 配列をそのまま出すため、`durationSec` フィールドが付いていれば自動的に export される。明示的なスキーマ変更は不要）

## DB スキーマ詳細

```text
DB_VERSION: 4 → 5

watchedVideos record (v5):
  videoId: string (keyPath)
  title: string
  channel: string
  source: string
  watchedAt: number
  firstWatchedAt: number
  playCount: number
  composer / lyricist / arranger: string
  creditsRaw: string
  creditsSource: string
  durationSec: number | null    ← 追加（null = 未取得、-1 = ライブ動画で対象外）
  durationFetchFailed?: string  ← 追加（取得失敗時のみ・reason 文字列）
```

## 互換性・破壊的変更

- 追加フィールドのみのため後方互換あり
- v1.37.1 以前にダウングレードしてもデータは読める（IndexedDB は未知フィールドを無視）
- DB v5 → v4 ダウングレードは IndexedDB 仕様上不可。CHANGELOG / README に明記

## 実装上の注意

- `DBClient.addWatched` のシグネチャ変更前に **全呼出元 grep** して `null` 引数を補うこと（`feedback_signature_change_grep.md`）
- offscreen DB RPC の payload にも `durationSec` を追加（v1.35.0 で DB owner が offscreen に移っている）
- FIX_DURATIONS のテスト時は 100件 → 1,000件 → 全件の3段階で（`feedback_data_analysis_pdca.md`）
- ライブ動画の `lengthSeconds` は配信前は `0`、配信中は実時間、終了後は録画時間。信頼できないので `isLiveContent: true` は問答無用で `-1` センチネル
- バッチ中断（abort/auto-stop）後の再開で重複処理されないこと（`durationSec === null` のみ対象なので自動的に再開できるはず）
- 集計の null 扱いをユーザーが理解できるよう、analyzer の表ヘッダにツールチップで「lengthSeconds は動画の長さ。実視聴時間ではない（途中離脱・倍速・リピートは反映されない）」と注記

## テスト観点

### マイグレーション
- v4 DB（durationSec フィールドなし）から v5 に上がり、既存レコードの `durationSec` が `null` になる
- v5 DB を v5 で開き直しても再マイグレーションが走らない
- 5件 / 100件 / 11,500件規模で migration が完了する

### 新規視聴
- watch ページで再生したら `durationSec` が記録される
- `lengthSeconds` が DOM から取れない場合（age-gate 等）でも記録自体は成功し `durationSec = null`
- seekbar 検出経由（`content.js:523` / `:1129`）でも `durationSec` が記録される

### FIX_DURATIONS
- 100件サンプルで `durationSec === null` のレコードのみが処理される
- ライブ動画が `durationSec = -1` でマークされ、次回ループから除外される
- 削除済み動画が `durationFetchFailed` でマークされ、次回ループから除外される
- abort 中断後、再開で重複処理されない
- sorry-redirect で auto-stop する（既存 Fix Credits と同挙動）

### analyzer
- チャンネル別タブで「合計時間」列が表示される
- null 混入時に「うち N件 不明」が併記される
- 全 null 時に列ヘッダのみ表示・各行 `—`
- クレジット別タブも同様
- ソート切替（再生数 ↔ 合計時間）が動く

## 出力先

- 実装: 既存ファイルを直接編集（`db.js` / `content.js` / `background.js` / `analyzer.js` / `manifest.json` / `CHANGELOG.md` / `README.md`）
- 完了レポート: `codex-reports/ad-hoc/yt-watched-hider-v138-durationSec_<日付>.md`
  - 変更ファイル一覧
  - DB v4→v5 マイグレーションフロー
  - FIX_DURATIONS バッチのレート設計（既存 Fix Credits との差分があれば明記）
  - analyzer の合計時間表示サンプル（モック値でよい）
  - 実機テストチェックリスト（マイグレーション/新規視聴/バックフィル/analyzer の4セクション）
  - 残課題（Export v2 envelope への明示的な durationSec 注記が必要か等）

## DoD

- `node --check` が全 JS で成功
- DB v4 から v5 への自動マイグレーションが手元の実 DB（~11,500件）で完了
- FIX_DURATIONS を 100件サンプルで実行し、`durationSec` が埋まる
- analyzer のチャンネル別タブで「合計時間」列が表示される（バックフィル前は `—` 表示）
- manifest version を `1.38.0` に更新
- CHANGELOG.md に v1.38.0 エントリ追加（DB v5 / durationSec / FIX_DURATIONS / analyzer 累計時間の4点を強調）
- README に durationSec 機能の概要追記（「視聴済み動画の総尺・実視聴時間ではない」旨を明記）
