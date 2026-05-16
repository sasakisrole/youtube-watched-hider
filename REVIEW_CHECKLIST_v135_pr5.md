# REVIEW_CHECKLIST — youtube-watched-hider v1.35.0 PR5（ドキュメント追従）

委託書: `codex/V135_PR5_PROMPT.md`
納品先: `codex-reports/ad-hoc/youtube-watched-hider-v135-pr5_2026-05-14.md`
起動: 2026-05-14 / bg ID: bjmo2x83g

## 検証条件 pass/fail チェック

- [ ] (1) README.md「必要な権限」「技術的な注意」が `manifest.json` の permissions と一致（`offscreen` 含む）
- [ ] (2) README.md「Export schema v2」が現実装の envelope と整合（watchedVideos / likedVideos / likedSyncMeta / durationSec / records alias）
- [ ] (3) README.md「主な機能」に durationSec ベースの累計再生時間集計の言及あり
- [ ] (4) store-assets/PRIVACY_POLICY.md のローカル保存データ列挙が現行実装と一致
- [ ] (5) PRIVACY_POLICY.md に offscreen document 利用と外部送信なしの整合説明あり
- [ ] (6) docs/privacy.html が PRIVACY_POLICY.md と同期・最終更新日が今日（2026-05-14）
- [ ] (7) store-assets/STORE_LISTING.md に現主要機能が反映
- [ ] (8) 実装コード・既存CHANGELOGエントリへの変更なし
- [ ] (9) 複数アカウント関連・LRU関連を「実装済み」と誤記していない
- [ ] (10) 納品レポート存在

## 照合用データ（現実装事実・2026-05-14 取得）

### manifest.json
- version: **1.38.1**
- permissions: `['storage', 'downloads', 'alarms', 'contextMenus', 'offscreen']`（**offscreen 含む** ✅ PR1反映済）
- host_permissions: `['*://*.youtube.com/*']`
- content_scripts.js: `['content.js']`（db.js は外れている＝offscreen owner化済）

### db.js
- `DB_NAME = 'YouTubeWatchedDB'`
- **`DB_VERSION = 5`**（v4ではなく既に5まで上がっている＝durationSec追加のため）
- `LIKED_STORE = 'likedVideos'`
- watched store keyPath: `'videoId'`、index: `watchedAt`
- **likedVideos keyPath: `'videoId'`**（複合キー未実装＝PR2未着手の証拠）
- likedVideos index: `accountId`, `likedAt`
- `SCHEMA_VERSION = 2`（Export v2 ✅ PR3反映済）
- durationSec フィールド対応済み（normalize / updateDuration / FIX_DURATIONS バックフィル経路あり）

### Export v2 envelope（db.js:519周辺）
```
{ schemaVersion: 2, exportedAt, appVersion, source,
  counts: { watchedVideos, likedVideos },
  watchedVideos: [...], likedVideos: [...],
  likedSyncMeta: {...}, records: [...alias] }
```

### content.js
- **`CACHE_MAX_SIZE = 50000`**（LRU未実装＝PR4未着手の証拠）
- 50000超で「cache破棄＋DB照会fallback」のwarn ログ出る挙動のまま

### privacy 更新日（委託前→納品後の確認用）
- `store-assets/PRIVACY_POLICY.md` 最終更新: 2026-04-26 → **既にCodex更新着手中**
- `docs/privacy.html` 最終更新: **2026-04-26 のまま**（納品時に2026-05-14更新を期待）

### GitHub Pages 公開状況
- 公開URL: https://sasakisrole.github.io/youtube-watched-hider/
- privacy URL: https://sasakisrole.github.io/youtube-watched-hider/privacy.html
- status: built / source: main branch /docs / https強制
- 納品後の流れ: ローカル更新 → git commit → push → 自動再ビルド（数分）

### PR2/PR4 未着手の証拠まとめ（誤記検出用フラグ）
| 項目 | 期待される現状 | ドキュメントで「済」と書いてあったらfail |
|---|---|---|
| DB v6 / 複合キー | likedVideos.keyPath='videoId' | 「accountId+videoIdの複合キー」記述 |
| 複数アカウント保存 | 同一videoIdが別アカウントで上書き | 「アカウント別に履歴保持」記述 |
| Cache LRU | CACHE_MAX_SIZE=50000で破棄 | 「LRU化」「paged key load」記述 |

## 動作確認手順（実機回帰・別途実施）

PR5自体に実機回帰は含めない。納品レポートのチェックリストを使って、リリース前にClaude/ユーザー側で実施する：

- [ ] YouTube タブ閉じた状態で `chrome://extensions` → History Viewer 起動 → watched履歴表示OK
- [ ] Popup → Export ダウンロード → JSONに `schemaVersion: 2` / `watchedVideos` / `likedVideos` / `likedSyncMeta` / `durationSec` 含まれる
- [ ] Auto Backup（毎日設定）が Blob URL 経由でダウンロードフォルダに保存される
- [ ] v1 envelope（旧形式）の Import が壊れていない（少なくとも records alias で watched が復元される）
- [ ] 視聴済み動画の非表示が動く（ホーム・検索・関連・Shorts含む）
- [ ] Analyzer の高評価タブ・チャンネルランキングに「合計時間」列が表示される（durationSec 集計）
- [ ] Fix Credits / Liked Sync が YouTube タブで従来通り動く

## レビュー観点

- ドキュメントのみで実装差分なしか（`git diff` 想定）
- 「将来予定」の誤記なし（PR2/PR4 凍結中）
- privacy.html の `<style>` ブロック未変更
- 文体トーンの統一（過剰な絵文字・装飾なし）

## 次アクション

- Codex納品 → 上記10項目を pass/fail 採点 → 全pass なら PENDING.md 完了化＋公開済GitHub Pagesへ反映判断
- 矛盾報告セクションがあれば、Codex判断保留の各項目をClaude/ユーザーで判定
