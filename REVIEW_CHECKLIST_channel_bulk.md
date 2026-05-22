# REVIEW_CHECKLIST: チャンネルページ一括キュー/後で見る（v1.41.0）

委託: 2026-05-22 / 納品先: `codex-reports/ad-hoc/yt-watched-hider-channel-bulk_2026-05-22.md`

## 検証条件 自己採点照合（Codexレポートと突合）

| # | 条件 | コード上の確認ポイント | pass/fail |
|---|------|----------------------|-----------|
| 1 | チャンネルページにボタン2つ表示 | チャンネル判定で `ensureQueueAllButton`/`ensureWatchLaterButton` が早期returnしないこと。アンカー関数がrich-gridを拾うこと | |
| 2 | キュー追加が動作 | `queueOneCard()` 流用・チャンネルカードのケバブ取得経路 | |
| 3 | 後で見る追加が動作 | `watchLaterOneCard()` 流用 | |
| 4 | 中止ボタン挙動 | `queueInProgress`/`watchLaterAbort` ロジック流用 | |
| 5 | Shorts/ライブ/プレイリスト除外 | チャンネル版 find関数に既存除外条件が移植されているか | |
| 6 | **watch既存挙動 不変（リグレッション）** | `/watch` 経路の find関数・seedQueue・アンカーが変わっていないか diff確認 | |
| 7 | SPA遷移で幽霊ボタン残らない | ページ種別変化時のbtn破棄・observer disconnect | |
| 8 | 大量カード警告 | confirm文言が件数連動で警告 | |

## 重点レビュー観点（リグレッション最優先）

1. **既存watch関数のシグネチャ温存**
   - `findQueueableCards()` / `findWatchLaterableCards()` を引数化 or 分岐したか。watch経路の戻り値が以前と同一になるか。
   - `RELATED_CARD_SELECTORS` は watch専用のまま残っているか（チャンネルは別セレクタ）。
   - `findWatchLaterAnchor()`（watch専用）を壊していないか。

2. **コンテキスト判定の堅牢性**
   - `/videos` で終わる判定が `/feed/...` 等の誤検出を起こさないか。
   - `ytd-rich-grid-renderer` 存在チェックを併用しているか（DOM未ロード時の早期return）。

3. **state変数のリーク**
   - `queueAllBtn` / `watchLaterBtn` シングルトンが、watch→channel遷移時に前ページの参照を破棄して作り直すか。

4. **grid-column対策**
   - チャンネルグリッド（display:grid）でボタンが0px潰れしないか。`grid-column:1/-1` 相当の対策があるか。

## 動作確認手順（納品後・実機）

```
1. chrome://extensions で yt-watched-hider をリロード
2. https://www.youtube.com/@ferumi/videos を開く
3. グリッド上部に「⏭ キューに追加 (N)」「後で見る (N)」が出るか
4. 少しスクロールしてカードを増やし、N が更新されるか
5. 「キューに追加」→ 確認ダイアログ件数 → 数件で中止ボタン動作確認
6. /watch ページ（任意の動画）で既存2ボタンが従来通り動くか ★リグレッション確認
7. チャンネル→watch→ホーム を行き来して幽霊ボタンが残らないか
```

## 納品後アクション
- 全pass → manifest 1.41.0 / CHANGELOG確認 → publish-release
- リグレッション懸念 → 該当diff精査 → 修正依頼（Phase 2に戻る）
