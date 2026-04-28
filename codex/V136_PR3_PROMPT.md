[SESSION] 目的:youtube-watched-hider v1.36.0 PR3（Export v2 + Blob URL backup）の実装 | 編集:実装主導 | 出力:プロジェクトパスに直接書込 | 完了条件:設計書 §2 + Auto Backup の Blob URL 化＋実機検証手順書

# タスク: v1.36.0 PR3 Export v2 + Blob URL backup

> 全体方針: `.claude/codex-context.md` に従う。

## プロジェクト

- パス: `C:\Users\sasaki\Dropbox\claude-workspace\projects\youtube-watched-hider`
- 現行バージョン: v1.35.0（PR1 適用済み・Offscreen DB owner化済み）
- 設計書: `codex/V135_DESIGN.md`（§2「Export schema v2」必読）

## 緊急度（実装の動機）

- ユーザーの watched 件数: **23,590件 / 12.4MB（v1 envelope JSON）**
- 現状の Auto Backup は `background.js:217-220` で `data:application/json;base64,...` 形式
- base64エンコードで約33%膨張 → **約16.5MBのdata URL** を `chrome.downloads.download()` に渡す
- Chrome の data URL ダウンロードは大容量で **静かに失敗** する事例があり、ユーザーは既に Auto Backup が壊れている可能性がある
- **Auto Backup の Blob URL 化を最優先**で行い、その上で Export schema v2 に揃える

## スコープ（このPRの範囲）

### A. Auto Backup の Blob URL 化（最優先・即効性）

- `background.js:201-249` の `performAutoBackup()` を改修
- 仕組み: background が offscreen に「Export blob URL を作って渡せ」と依頼 → offscreen で `Blob` + `URL.createObjectURL()` → background が `chrome.downloads.download({ url: blobUrl, ... })` → ダウンロード完了後 offscreen 側で `URL.revokeObjectURL()`
- 新メッセージ: `OFFSCREEN_CREATE_EXPORT_BLOB`（payload: `{ schemaVersion: 2 envelope }`）→ blob URL を返す。`OFFSCREEN_REVOKE_BLOB` で後始末
- `chrome.downloads.onChanged` で `state: complete` または `interrupted` を検知してから revoke する
- 失敗時は `chrome.runtime.lastError` を `result.reason` に積んで `chrome.storage.local.lastBackupError` へ保存（popup の Settings に表示する）
- 手動 Export（popup・history からの `EXPORT_DOWNLOAD`）も同じ仕組みに統合する

### B. Export schema v2

設計書 §2 に従う。envelope:

```text
{
  schemaVersion: 2,
  exportedAt: ISO string,
  appVersion: string (manifest.json version),
  source: "manual" | "auto" | "backup-now",
  counts: { watchedVideos: number, likedVideos: number },
  watchedVideos: [...],
  likedVideos: [...],
  likedSyncMeta: {
    schemaVersion: 2,
    lastAccountId: string,
    accounts: { [accountId]: { accountId, ownerName, ownerHandle, ownerChannelId, lastSyncedAt, count, accountSource } }
  },
  records: [...]   // v1 importer 用 watchedVideos エイリアス（互換維持）
}
```

- `db.js` の `exportAll()` / `wrapExport()` を v2 envelope を返すよう改修
- 全消費側（popup.js・history.js・background.js）で `unwrapWatchedRecords(data)` ヘルパーを通して読む
- v1 raw array / v1 envelope `{ records }` の **import 互換は維持**（テスト観点参照）
- v2 envelope に `records` alias を残すことで、旧 v1.35.0 以前の extension でも watched は読める

### C. Auto Backup 失敗の可視化

- popup.html / popup.css の Settings 内 `lastBackupInfo` に、最終成功日時とエラー時のメッセージを表示
- `chrome.storage.local` キー: `lastBackup`（成功日時 ms）/ `lastBackupCount` / `lastBackupError`（最後の失敗理由文字列、成功で null）
- エラー時は赤系で表示、成功時は控えめに（既存の `.setting-desc` クラスを流用）

## スコープ外（後続PRで実施）

- DB v6 / likedVideos 複合キー化（PR2 / v1.37.0）
- Innertube 同期堅牢化（PR2 / v1.37.0）
- Cache LRU（PR4 / v1.38.0）
- 旧オリジンDBの削除（v1.35.0で残してある watched データ）

## DBスキーマ

**変更しない**（DB v4 のまま。likedVideos は accountId 不在で `__unknown__` のまま v2 export 対象に含める。複合キー化は v1.37.0）。

## 互換性・破壊的変更

- v2 envelope の `records` alias により、**v1.35.0 以前の extension にダウングレードしても watched 履歴の import は可能**
- ただし likedVideos / likedSyncMeta は旧 importer では読めない（仕様）
- v1 raw array import / v1 envelope import は維持（テスト必須）

## 実装上の注意

- offscreen 側で生成した Blob URL は **必ず revoke する**（メモリリーク防止）
- `chrome.downloads.download` の callback で downloadId が undefined のときは失敗扱い、`lastBackupError` に記録
- Auto Backup の発火は既存の `chrome.alarms` ベースを維持
- offscreen lifetime は v1.35.0 で常時維持に決定済み（再起動コスト回避）
- `likedSyncMeta` には Cookie / SAPISIDHASH / Authorization header を **絶対に含めない**（設計書 §2 「破壊的変更」項参照）
- `feedback_indexeddb_upgrade.md` 参照（DB変更しないが、export経路でDB読みが集中するので onversionchange は維持）

## テスト観点

### Auto Backup
- 23,590件規模の v2 envelope（実測 ~14MB）が Blob URL 経由で保存できる
- 5万件規模の合成データでも保存できる（境界確認）
- ダウンロードフォルダで JSON が末尾まで欠損なく書かれている
- ダウンロード失敗時に `lastBackupError` が記録される
- 連続発火時に Blob URL が leak しない（DevTools Memory タブで確認）

### Import 互換
- v1 raw array（`[{videoId, ...}, ...]`）を import できる
- v1 envelope（`{ schemaVersion: 1, records: [...] }`）を import できる
- v2 envelope から watched / liked / meta を import できる
- v2 envelope を v1.35.0 以前に渡しても `records` から watched だけは復元できる（手動でテスト推奨）
- v2 envelope に likedVideos が無い場合、watched のみ import で成功する
- `likedSyncMeta` が無い場合、meta import をスキップする
- 壊れた JSON / 異常な型のフィールドを混入したファイルが import で **拒否される**（型バリデーション強化、設計書 §2 採用済み項目）

### popup 表示
- 最終バックアップが成功した場合、日時と件数が表示される
- 失敗した場合、エラー理由が赤系で表示される

## 出力先

- 実装: 既存ファイルを直接編集 + 必要なら helper 追加
- 完了レポート: `codex-reports/ad-hoc/yt-watched-hider-v136-pr3_<日付>.md`
  - 変更ファイル一覧
  - Auto Backup の Blob URL 化フロー図（メッセージ往復）
  - Export schema v2 の実サンプル（先頭数行）
  - 互換性テスト結果
  - 残課題・既知の制約
  - 実機テストチェックリスト

## DoD

- `node --check` が全 JS で成功
- 23,590件規模で Auto Backup が成功する（手元で実測）
- v1 raw array / v1 envelope の import が引き続き成功する
- v2 envelope の export → 別ブラウザで import → 全件復元できる
- popup の Settings で最終バックアップ状態が確認できる
- manifest version を `1.36.0` に更新
- CHANGELOG.md に v1.36.0 エントリ追加（Auto Backup の Blob URL 化を強調）
- README に Export schema v2 の概要を追記（v1 互換維持の旨を明記）
