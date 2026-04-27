[SESSION] 目的:youtube-watched-hider v1.35.0 PR1（Offscreen DB owner化）の実装 | 編集:実装主導 | 出力:プロジェクトパスに直接書込 | 完了条件:設計書 §3 PR1範囲の実装＋既存データ移行＋実機検証手順書

# タスク: v1.35.0 PR1 Offscreen DB owner 化

> 全体方針: `.claude/codex-context.md` に従う。

## プロジェクト

- パス: `C:\Users\sasaki\Dropbox\claude-workspace\projects\youtube-watched-hider`
- 現行バージョン: v1.34.4 (manifest.json)
- 設計書: `codex/V135_DESIGN.md`（必読、特に §3 と「実装順序」§PR 1）

## スコープ（このPRの範囲）

設計書 §3 のうち、**DBスキーマは v4 のままで** owner だけを offscreen document に移す。

- `manifest.json` に `offscreen` permission 追加
- `offscreen.html` / `offscreen.js` を新規作成し、`db.js` を読ませる
- `background.js` に `ensureOffscreenDocument()` を追加
- 既存メッセージ（`GET_STATS` / `EXPORT_DATA` / `IMPORT_DATA` / `MERGE_IMPORT` / `DELETE_VIDEO` / liked系 / Fix Credits 系）を offscreen 経由に置換
- YouTube認証fetch（`FETCH_WATCH_HTML` / `FETCH_PLAYLIST_HTML` / `FETCH_INNERTUBE_BROWSE`）は **content.js に残す**
- `content.js` から `db.js` の直接呼び出しを `DBClient` wrapper（background経由RPC）に置換
- `manifest.json` の `content_scripts.js` から `db.js` を外す

## スコープ外（後続PRで実施）

- DB v6 / likedVideos 複合キー化
- Export schema v2
- Cache LRU
- Innertube 同期堅牢化
- Auto Backup の Blob URL 化（PR 3で実施）

## ⚠️重要: 既存データ移行（設計書未記載・追加要件）

オリジンが `youtube.com` → `chrome-extension://<id>` に変わるため、**既存ユーザーの IndexedDB データ（約11,500件）が新オリジンから見えなくなる**。これは絶対に失わせてはいけない。

### 移行設計（実装必須）

1. 拡張更新後、background が `chrome.storage.local.migrationV135Done` を確認
2. 未完了なら、YouTube タブが開かれた最初のタイミングで以下を実行：
   - content.js が旧オリジンの `WatchedDB.exportAll()` 相当を実行（watched + liked 両方）
   - 結果を background に送信
   - background が offscreen に投げて新オリジンのDBへ import（merge方式、既存と衝突したら旧データ優先）
   - 完了したら `migrationV135Done = true` を保存
3. YouTube タブが無いユーザー向けに、popup に「初回同期のため一度YouTubeを開いてください」バナーを表示（migrationV135Done=false の間だけ）
4. 移行完了後も旧オリジンのDBは即削除しない（v1.36.0以降で削除する想定。v1.35.0では残す）

### 移行のテスト

- v1.34.4 で 100件以上 watched したDB状態から v1.35.0 にアップデート → 全件が新DBに移ること
- YouTube タブを開かない状態で popup を開く → 案内バナーが出ること
- 移行中にエラーが起きた場合、`migrationV135Done` は false のまま、再試行できること

## 実装上の注意

- Chrome 116+ 前提（`runtime.getContexts` 使用、109-115 fallback 不要）
- offscreen `reasons` は `["BLOBS"]`
- offscreen lifetime は **常時維持**（idle close しない）
- IndexedDB の `onversionchange` / `onblocked` ハンドラは維持（feedback_indexeddb_upgrade.md 参照）
- v1.30.1 の DBフリーズ復旧案内は残す
- `chrome.storage.local` / `chrome.downloads` は background 担当、offscreen からは触らない

## 出力先

- 実装: 既存ファイルを直接編集 + 新規ファイル作成
- 完了レポート: `codex-reports/ad-hoc/yt-watched-hider-v135-pr1_<日付>.md`
  - 変更ファイル一覧
  - 移行ロジックの動作確認手順
  - 残課題・既知の制約
  - 実機テストチェックリスト

## DoD

- `node --check` が全 JS で成功
- v1.34.4 のDBデータが v1.35.0 アップデート後に保全される
- YouTube タブ無しで popup 件数表示・History Viewer・手動 Export が動作
- YouTube タブ有りで Fix Credits / Liked Sync が従来どおり動作
- manifest version を `1.35.0` に更新
- CHANGELOG.md に v1.35.0 エントリ追加
