[SESSION] 目的:youtube-watched-hider v1.38.0 のバグ・回帰リスクレビュー | 編集:分析のみ（読み取り専用） | 出力:codex-reports/ad-hoc/yt-watched-hider-v138-review_2026-05-12.md | 完了条件:重要度別バグリスト＋根拠コード位置

# タスク: v1.38.0 第三者レビュー

> 全体方針: `C:\Users\sasaki\Dropbox\claude-workspace\.claude\codex-context.md`

## レビュー対象

v1.37.1 → v1.38.0 のすべての working tree 変更。直近の commit は v1.35.0 (`3796f9c`) で、v1.36.x / v1.37.x / v1.38.0 はすべて未コミット状態（CHANGELOG 上で履歴を確認可能）。

**主な変更点**:
- `db.js`: DB v4 → v5・`durationSec` フィールド追加・`addWatched` シグネチャ拡張
- `content.js`: watch ページの `lengthSeconds` 抽出・seekbar 経由の duration 記録・「キューに追加 / 後で見る」ボタンの `findWatchLaterAnchor()` 修正
- `background.js`: `FIX_DURATIONS` バッチ（`fixDurationsBatch`・`fix-durations` port）
- `offscreen.js`: `MARK_DURATION_FAILED` / `MARK_DURATION_LIVE` / `UPDATE_DURATION` RPC
- `history.html` / `history.js`: Fix Durations UI・durationSec ソート
- `analyzer.js`: チャンネル別・クレジット別の「合計時間」列・`formatDurationStat`
- `manifest.json`: 1.38.0
- `CHANGELOG.md` / `README.md`

設計書: `codex/V135_DESIGN.md` §6（凍結された §1 §4 は対象外）
委託書: `codex/V138_PROMPT.md`
実装レポート: `codex-reports/ad-hoc/yt-watched-hider-v138-durationSec_2026-05-12.md`

## 観点

以下を最優先で見る：

1. **DB マイグレーション安全性**
   - `oldVersion < 5` の cursor 走査と既存 `oldVersion < 2` の cursor 走査の競合
   - 大量データ（~24,000件）での migration がブロックしないか
   - upgrade transaction 内での `cursor.update` の正しさ
   - `onversionchange` / `onblocked` の挙動が壊れていないか

2. **`addWatched` シグネチャ変更の波及**
   - 旧呼出元（v1.35.0 以前から残るコード）で `durationSec` を渡し忘れていないか
   - default `null` で互換が取れていることを全 caller で確認
   - DBClient RPC payload と offscreen.js 受け側の整合性

3. **FIX_DURATIONS バッチのエッジケース**
   - abort 中断後の再開で重複処理されないか
   - sorry-redirect auto-stop 後の状態リセット漏れ
   - `durationFetchFailed` が立った後の再試行ロジック
   - 環境要因（`no-youtube-tab` / `429` 等）と動画固有失敗の切り分けが正しいか
   - レート設計（CONCURRENCY=2, DELAY=500, JITTER=200）が Fix Credits との二重実行で問題ないか

4. **lengthSeconds 抽出の堅牢性**
   - `ytInitialPlayerResponse` パースの balanced JSON extraction にエッジケース穴がないか
   - ライブ動画判定（`isLiveContent: true` → `-1`）が確実か
   - `meta[itemprop="duration"]` / `<video>.duration` フォールバックの順序が妥当か
   - seekbar 経由の `getDurationFromCard` のセレクタが現行 YouTube DOM に追随しているか

5. **analyzer 合計時間集計**
   - null / -1 / 0 / 正の値が混在したときの集計ロジック
   - `formatDurationStat` の境界条件（0秒 / 24時間超 / 1秒未満）
   - ソート切替（再生数 ↔ 合計時間）でクレジット別タブの「セルフアレンジ曲」列が壊れないか
   - 23,590 件規模の集計でメインスレッドが固まらないか

6. **既存機能への回帰リスク**
   - Auto Backup (v1.36.0) / Export v2 (v1.36.0) / 推移タブ (v1.37.0) が壊れていないか
   - Fix Credits / Liked Sync / Cache 初期化が壊れていないか
   - content.js の新規ヘルパー（duration 抽出系）が startup 時の処理を遅らせていないか

7. **その他バイアスチェック**
   - 委託書で指定した範囲外で勝手に変更されたものはないか
   - 仕様 §6 と乖離している実装はないか

## 出力形式

`codex-reports/ad-hoc/yt-watched-hider-v138-review_2026-05-12.md` に以下構造で：

```markdown
# v1.38.0 レビューレポート

## サマリー
- Critical: N件 / High: N件 / Medium: N件 / Low: N件
- 結論: リリース可否（OK / 修正後OK / 要根本対応）

## Critical（リリースブロッカー）
### 件名
- 場所: `<file>:<line>`
- 症状: 〜
- 根拠: 〜
- 修正案: 〜

## High / Medium / Low
（同様の形式）

## 良かった点
（特になければ省略）

## 仕様逸脱・スコープ外変更
（あれば列挙）
```

## 制約

- **読み取り専用**。ファイル編集禁止
- 推測補完しない（不明点は「要確認」と明示）
- v1.38.0 範囲外の既存バグは「既知の枠外」として軽く触れるに留める
- 1500-2500 字程度で完結に。網羅性より重要度の高い指摘を優先

## DoD

- 上記レポートが指定パスに生成される
- Critical / High があれば明確に列挙され、根拠コード位置と修正案が併記される
- Critical ゼロなら「リリース可否: OK」と明記
