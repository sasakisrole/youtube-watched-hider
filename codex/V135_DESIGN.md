# youtube-watched-hider v1.35.0 設計書

作成日: 2026-04-27  
対象バージョン: v1.35.0 minor  
対象プロジェクト: `projects/youtube-watched-hider`

## スコープ

v1.35.0 では、2026-04-26 のコードレビューで warning として残した次の5項目を一括で扱う。

1. `likedVideos` の複合キー化
2. Export schema v2
3. Offscreen document への DB owner 移動と大容量バックアップ
4. Innertube 同期の複数アカウント耐性強化
5. 5万件超キャッシュの LRU / 分割キャッシュ化

実装はこの文書の対象外。v1.31.x の高評価同期、v1.34.x の Fix Credits、v1.31.4 の XSS 耐性改修は温存する。

## 共通設計

### 基本方針

- DB owner を `content.js` から extension 側の offscreen document に移す。
- YouTube 認証が必要な HTML / Innertube fetch は、引き続き YouTube タブ上の `content.js` で実行する。
- `chrome.storage.local` と `chrome.downloads` は background service worker が担当する。offscreen document は Chrome 公式仕様上、基本的に `chrome.runtime` 経由の messaging に限定して使う。
- Export / Auto Backup のファイル生成は offscreen document で Blob URL を作り、background が `chrome.downloads.download()` を呼ぶ。
- `likedVideos` は DB v6 で `[accountId, videoId]` の複合キーへ移行する。
- Export schema は v2 に上げるが、v1 raw array / v1 envelope の import は維持する。

### 追加予定ファイル

- `offscreen.html`: `db.js` と `offscreen.js` を読み込む静的 extension page。
- `offscreen.js`: DB RPC、Export v2 組み立て、Blob URL 作成 / revoke を担当。
- 既存 `db.js`: offscreen document から再利用する。最終形では `manifest.json` の `content_scripts.js` から外す。

### メッセージフロー

擬似フロー:

```text
Popup / History / Analyzer / content.js
  -> background.js
    -> ensureOffscreenDocument()
    -> offscreen.js
      -> WatchedDB

background.js
  -> YouTube tab content.js
    -> authenticated fetch to youtube.com

background.js
  -> offscreen.js: create export Blob URL
  -> chrome.downloads.download(blobUrl)
  -> offscreen.js: revoke Blob URL
```

主要 RPC:

| RPC | 呼び出し元 | owner | 用途 |
|---|---|---|---|
| `DB_GET_STATS` | popup/background | offscreen | 件数・cache表示用 |
| `DB_CHECK_MULTIPLE` | content | offscreen | 表示カードの watched 判定 |
| `DB_ADD_WATCHED` | content | offscreen | 再生済み記録 |
| `DB_EXPORT_V2` | background/popup/history | offscreen + background | watched / liked / meta の export |
| `DB_IMPORT_V2` | popup/background | offscreen + background | v1/v2 import |
| `DB_UPSERT_LIKED` | background | offscreen | 高評価同期結果の保存 |
| `DB_GET_LIKED` / `DB_GET_LIKED_STATS` | analyzer/background | offscreen | Analyzer の高評価タブ |
| `DB_UPDATE_CREDITS` 系 | background | offscreen | Fix Credits 結果保存 |

既存の `EXPORT_DATA` / `IMPORT_DATA` / `MERGE_IMPORT` / `GET_LIKED` などは外部公開 API ではないが、同一リリース内の UI 消費側をすべて更新する。移行中は background 側で旧 message 名を受け、新 RPC に転送する。

### DB version

現行コードでは `db.js:6` が `DB_VERSION = 4`。依頼書では DB v6 / v5→v6 と指定されているため、v1.35.0 の設計上は `DB_VERSION = 6` とする。

⚠️判断要:

- 現行リポジトリ上に DB v5 の実装は見当たらない。v5 が別ブランチで予約済みでないなら、IndexedDB は `oldVersion < 6` 条件で 4→6 へ直接アップグレードしてよい。
- v5 に別用途を割り当てる予定がある場合は、v1.35.0 実装前に v5 の責務を確定する。

## 1. likedVideos 複合キー化

> **【2026-05-12 凍結】** ユーザーは複数 Google アカウントを所有するが、再生は1アカウントに固定運用しているため実需薄と判断。同一動画を別アカウントで高評価しても「1件」として扱って実用上問題なし。複数アカウント運用を始めた時点で復活検討。

### 現状コード位置

- `db.js:6`: `DB_VERSION = 4`
- `db.js:33-36`: `likedVideos` を `keyPath: 'videoId'` で作成し、`accountId` / `likedAt` index を追加
- `db.js:526-547`: `upsertLiked()` が `store.get(it.videoId)` / `store.put({ videoId, ..., accountId })`
- `db.js:556-563`: `getAllLiked()` が全件取得
- `db.js:567-579`: `clearLikedByAccount()` が `accountId` index で削除
- `db.js:590-597`: `getLikedStats()` が `accountId || '(unknown)'` で集計
- `background.js:1072-1102`: `syncLikedPlaylist()` が `accountId` と `likedSyncMeta` を保存

### 目的・解決する問題

現行の `likedVideos` は `videoId` が主キーなので、複数 Google アカウントで同じ動画を高評価した場合に1レコードへ潰れる。v1.35.0 では `accountId + videoId` を1件の同一性として扱い、アカウント別の高評価履歴を失わないようにする。

### 設計案

DB v6 の `likedVideos` record:

```text
{
  accountId: string,       // stable account key。未確定時は "__unknown__"
  videoId: string,
  title: string,
  channel: string,
  likedAt: number,
  syncedAt: number,
  playlistIndex: number,
  ownerName?: string,
  ownerHandle?: string,
  ownerChannelId?: string,
  accountSource?: "ownerChannelId" | "ownerHandle" | "datasyncHash" | "unknown"
}
```

Object store:

```text
likedVideos keyPath: ["accountId", "videoId"]
indexes:
  accountId: "accountId", non-unique
  videoId: "videoId", non-unique
  likedAt: "likedAt", non-unique
  syncedAt: "syncedAt", non-unique
```

API 方針:

- `upsertLiked(items, accountInfo)` は `accountInfo.accountId` を必須扱いにし、欠落時のみ `__unknown__` を補う。
- `store.get([accountId, videoId])` で既存確認する。
- 既存 `likedAt` は v1.31.4 の改修どおり上書きしない。
- `getAllLiked({ accountId? })` を用意し、未指定時は全アカウント横断で返す。
- `clearLikedByAccount(accountId)` は `accountId === undefined` と `accountId === "__all__"` を全消去扱いにする。空文字 `''` は未知アカウントとして使わない。
- Analyzer はまず全件横断を維持し、後続でアカウントフィルタ UI を追加できる形にする。

### DBマイグレーション

対象: `oldVersion < 6`

IndexedDB は既存 object store の `keyPath` を直接変更できないため、v6 upgrade 内で旧 `likedVideos` を読み取り、新しい複合キー store に移す。

推奨手順:

1. 旧 `likedVideos` が無い場合は、複合キーの新 store を作成して終了。
2. 旧 `likedVideos` がある場合は versionchange transaction 内で全レコードを cursor 取得する。
3. 各レコードを normalize する。
   - `videoId` が無いものは破棄し、件数を migration diagnostics に残す。
   - `accountId` が空 / 欠落なら `__unknown__` を設定する。
   - `likedAt` は既存値を優先し、無ければ `syncedAt`、それも無ければ `Date.now()`。
4. 旧 store を削除し、同名 `likedVideos` を `keyPath: ["accountId", "videoId"]` で再作成する。
5. normalized record を `put()` する。
6. 衝突時は `[accountId, videoId]` 単位で1件にまとめる。
   - `likedAt`: 古い値を優先
   - `syncedAt`: 新しい値を優先
   - `title` / `channel`: 空でない値を優先
   - `playlistIndex`: 正の数を優先

大きな注意点:

- v4 から直接 v6 に上がる環境を必ず `oldVersion < 6` で拾う。
- `db.js:59-62` の `onversionchange` と `db.js:71-74` の `onblocked` / open timeout は維持する。
- 古い YouTube タブに orphaned content script が残ると upgrade blocked が再発し得る。v1.30.1 の復旧案内は残す。

### 破壊的変更

- DB の一方向 migration。v6 に上げた後、古い拡張へ戻すと `likedVideos` を読めない。
- `likedVideos` の主キーが `videoId` から `[accountId, videoId]` に変わる。
- `accountId === ''` を「全アカウント削除」の暗黙指定に使わない設計へ変える。
- Export v2 では `likedVideos` の各レコードに `accountId` が必須になる。

後方互換:

- v1/v4 の `likedVideos` は migration で保全する。
- `accountId` 不明レコードは `__unknown__` として残す。勝手に特定アカウントへ寄せない。

### テスト観点

- v4 DB に `likedVideos` が無い状態から v6 へ上がる。
- v4 DB に `likedVideos` があり、`accountId` が空の record が `__unknown__` で残る。
- 同一 `videoId` を異なる `accountId` で2件保存できる。
- `upsertLiked()` 再同期で既存 `likedAt` が保持される。
- `clearLikedByAccount(accountId)` が対象アカウントだけを消す。
- `GET_LIKED_STATS` がアカウント別件数を返す。
- downgrade はサポート外であることを README / CHANGELOG に明記できる。

## 2. Export schema v2

### 現状コード位置

- `db.js:340-348`: `exportAll()` は `watchedVideos` の配列のみ返す
- `db.js:351-363`: `SCHEMA_VERSION = 1` / `wrapExport(records)`
- `db.js:366-370`: `unwrapImport()` は raw array と `{ records }` のみ対応
- `content.js:1638-1642`: `EXPORT_DATA` が `WatchedDB.exportAll()` を返す
- `content.js:1645-1668`: `IMPORT_DATA` / `MERGE_IMPORT` は watched records 前提
- `popup.js:45-50`: `getExportRecords()` は配列のみ正常扱い
- `popup.js:320-342`: 手動 Export は popup 側で schema v1 envelope を作る
- `popup.js:352-356`: `unwrapImportData()` は raw array と `{ records }` のみ対応
- `background.js:133-160`: Auto Backup は `EXPORT_DATA` の配列を data URL 化
- `background.js:194-197`: `EXPORT_DATA` message は YouTube tab に中継

### 目的・解決する問題

現行 Export / Auto Backup は `watchedVideos` だけを保存するため、高評価同期データと `likedSyncMeta` がバックアップされない。v1.35.0 では watched / liked / sync meta を同じ export に含め、v1 import 互換を維持する。

### 設計案

Export v2 envelope:

```text
{
  schemaVersion: 2,
  exportedAt: string,
  appVersion: string,
  source: "manual" | "auto" | "backup-now",
  counts: {
    watchedVideos: number,
    likedVideos: number
  },
  watchedVideos: [...],
  likedVideos: [...],
  likedSyncMeta: {
    schemaVersion: 2,
    lastAccountId: string,
    accounts: {
      [accountId]: {
        accountId,
        ownerName,
        ownerHandle,
        ownerChannelId,
        lastSyncedAt,
        count,
        accountSource
      }
    }
  },
  records: [...] // v1 importer 用の watchedVideos alias
}
```

`records` alias を残す理由:

- 古い extension は v2 envelope 全体を理解できないが、`records` があれば watched history だけは取り込める。
- 新 extension は `schemaVersion === 2` のとき `watchedVideos` を優先し、`records` は後方互換 alias として扱う。

Import:

- raw array: v1 legacy watched records として import。
- `{ schemaVersion: 1, records }`: watched records として import。
- `{ schemaVersion: 2, watchedVideos, likedVideos, likedSyncMeta }`: watched / liked / meta を import。
- `MERGE_IMPORT` は watched / liked とも merge。`IMPORT_DATA` は現行挙動に合わせ、明示的な clear はしない。
- `likedSyncMeta` は background が `chrome.storage.local` に保存する。offscreen document は storage API を直接使わない。

Message:

- ファイル出力用: `EXPORT_DOWNLOAD` を追加し、background が offscreen に Blob URL 作成を依頼する。
- データ読取用: `EXPORT_DATA` は v2 envelope を返す。ただし `unwrapWatchedRecords(data)` を全 UI に導入し、array / v1 / v2 を読めるようにする。
- Import 用: 既存 `IMPORT_DATA` / `MERGE_IMPORT` に v2 envelope を渡せるようにする。レスポンスは旧 UI 用の `count` / `added` も残しつつ、詳細を `watched` / `liked` に分ける。

### DBマイグレーション

Export schema 自体に DB migration は不要。ただし `likedVideos` を v2 export 対象にするには、項目1の DB v6 migration 完了後のデータ構造を前提にする。

### 破壊的変更

- `EXPORT_DATA` の返却型を v2 envelope に変える場合、既存 UI が配列前提だと壊れる。v1.35.0 では全消費側を同時に `unwrapWatchedRecords()` へ更新する。
- 旧 extension が v2 backup を完全復元することはできない。`records` alias により watched history だけを復元可能にする。
- `likedSyncMeta` の export はアカウント識別情報を含む。Cookie、SAPISIDHASH、Authorization header は絶対に含めない。

後方互換:

- v1 raw array / v1 envelope import は維持する。
- v2 import で `likedVideos` が無い場合は watched のみ import として成功させる。
- `likedSyncMeta` が無い場合は meta import をスキップする。

### テスト観点

- v1 raw array を import できる。
- v1 envelope `{ records }` を import できる。
- v2 envelope から watched / liked / meta を import できる。
- v2 envelope を古い importer に渡しても `records` で watched だけは拾える。
- Popup History / History Viewer / Analyzer が v2 envelope で表示できる。
- Export JSON に auth header / cookie が含まれない。
- 10万 watched + 1万 liked の export で UI が固まりにくい経路を使う。

## 3. Offscreen document でDBオーナーを拡張側に移す

### 現状コード位置

- `manifest.json:6`: permissions は `storage` / `downloads` / `alarms` / `contextMenus`
- `manifest.json:10-16`: content scripts に `db.js` / `content.js` を inject
- `background.js:99-112`: `sendToYouTubeTab()` が DB 操作を YouTube tab の content script に中継
- `background.js:125-170`: `performAutoBackup()` が YouTube tab 依存かつ data URL 方式
- `background.js:188-253`: `GET_STATS` / `EXPORT_DATA` / `IMPORT_DATA` / `GET_LIKED` 系が YouTube tab 中継
- `content.js:1626-1668`: stats / export / import / merge を `WatchedDB` で処理
- `content.js:1764-1788`: liked DB 操作を `WatchedDB` で処理
- `content.js:1792-1845`: Fix Credits の DB 更新を `WatchedDB` で処理
- `history.js:464-500`: History Viewer が `EXPORT_DATA` に依存
- `popup.js:240-253` / `popup.js:320-342`: Popup history / export が `EXPORT_DATA` に依存

### 目的・解決する問題

YouTube タブが無いと History Viewer、Popup Export、Auto Backup が DB を読めない。加えて service worker では Blob URL を作れないため、Auto Backup が JSON 全体を base64 data URL 化しており、大容量時に失敗しやすい。offscreen document を DB owner にして、拡張ページと自動処理を YouTube タブから切り離す。

### 設計案

Manifest:

```text
permissions: ["storage", "downloads", "alarms", "contextMenus", "offscreen"]
content_scripts.js: ["content.js"] // 最終形。db.js は offscreen.html 側で読む
```

Offscreen creation:

- `background.js` に `ensureOffscreenDocument()` を追加する。
- Chrome 116+ は `chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [...] })` で既存 document を確認する。
- Chrome 109-115 をサポートする場合は `clients.matchAll()` fallback を入れる。
- `chrome.offscreen.createDocument()` は `url`, `reasons`, `justification` が必須。
- 理由は Blob URL 作成を伴うため `["BLOBS"]` を第一候補にする。

⚠️判断要:

- Offscreen API の `reasons` は `BLOBS` のみでよいか。DB owner だけを見ると専用 reason が無いため、Blob URL を同じ document で扱う設計に寄せる。
- Chrome 109-115 を公式サポートするか。サポートするなら `runtime.getContexts()` fallback が必要。
- offscreen document を常時維持するか、一定時間アイドルで閉じるか。性能優先なら常時維持、メモリ優先なら idle close。

DB RPC:

- `offscreen.js` は `chrome.runtime.onMessage` で `target: "offscreen-db"` のみ処理する。
- background はすべての DB 系 message を `sendToOffscreenDb()` に集約する。
- content.js は直接 `WatchedDB` を触らず、`DBClient` wrapper 経由で background に送る。
- YouTube fetch 系 `FETCH_WATCH_HTML` / `FETCH_PLAYLIST_HTML` / `FETCH_INNERTUBE_BROWSE` は content.js に残す。

Auto Backup / manual export:

1. background が `EXPORT_DOWNLOAD` / alarm / `BACKUP_NOW` を受ける。
2. offscreen に `DB_CREATE_EXPORT_BLOB_URL` を送り、v2 envelope を Blob URL 化する。
3. offscreen が `{ blobUrl, counts, requestId }` を返す。
4. background が `chrome.downloads.download({ url: blobUrl, filename, ... })` を呼ぶ。
5. download callback 後、background が `DB_REVOKE_BLOB_URL` を offscreen に送る。
6. `lastBackup` / `lastBackupCount` は background が `chrome.storage.local` に保存する。

### DBマイグレーション

Offscreen 化自体の DB migration は不要。ただし DB owner 移動と DB v6 migration は同じリリースで起きるため、実装順ではまず offscreen DB RPC を v4 互換で動かし、その後 v6 migration を入れる。

Upgrade blocked 対策:

- v1.35.0 初回起動時、古い content script が v4 DB connection を保持している可能性がある。
- 既存 `onversionchange` が旧接続を閉じる前提は維持する。
- `openDB()` timeout / blocked error message は offscreen 経由でも UI に返す。

### 破壊的変更

- `manifest.json` に `offscreen` permission を追加する。
- content script から `db.js` を外すため、`content.js` の DB 呼び出しはすべて RPC に置き換える必要がある。
- DB 操作の失敗経路が「YouTube tab 無し」から「offscreen 作成失敗 / DB open blocked」に変わる。
- Auto Backup の保存経路が data URL から Blob URL に変わる。

後方互換:

- ユーザーの保存データは同じ IndexedDB database 名 `YouTubeWatchedDB` に残す。
- YouTube 認証 fetch は従来どおり YouTube tab 経由にして、SAPISIDHASH の取り扱いを変えない。
- Host permission は `*://*.youtube.com/*` のまま広げない。

### テスト観点

- YouTube タブ無しで History Viewer が watched history を表示できる。
- YouTube タブ無しで Popup Export / Backup Now / Auto Backup が動く。
- YouTube タブ無しで Fix Credits / Liked Sync は明示的に `no-youtube-tab` を返す。
- Offscreen document が未作成、作成済み、同時作成競合の3ケースで1個だけ作られる。
- Blob URL download 後に revoke される。
- `lastBackup` / `lastBackupCount` が storage に保存される。
- v4 DB を持つ状態で v6 upgrade が offscreen から成功する。
- 古い YouTube タブを開いたまま upgrade した場合に blocked error が UI へ出る。

## 4. Innertube同期の堅牢化

> **【2026-05-12 凍結】** §1 と一括で凍結。1アカウント運用前提なら `X-Goog-AuthUser: '0'` 固定で実害なし。複数アカウント運用を始めた時点で §1 と同時に再検討。

### 現状コード位置

- `background.js:904-909`: HTML から `INNERTUBE_API_KEY` / client 情報 / context を抽出
- `background.js:913-975`: `parseLikedPlaylistHtml()` が ownerName / ownerHandle / ownerChannelId / continuation を推定
- `background.js:978-1120`: `syncLikedPlaylist()` が LL playlist を取得し、`accountId` と `likedSyncMeta` を保存
- `background.js:1072`: `accountId = ownerChannelId || ownerHandle || ownerName || 'unknown'`
- `content.js:1552-1568`: `computeSapisidHash()` が `document.cookie` から SAPISIDHASH を生成
- `content.js:1731-1750`: `FETCH_INNERTUBE_BROWSE` が `X-Goog-AuthUser: '0'` 固定で POST
- `analyzer.js:277-283`: 高評価タブに `likedSyncMeta` を表示
- `analyzer.js:441-469`: `SYNC_LIKED` 実行と account-changed confirm

### 目的・解決する問題

現行同期は `X-Goog-AuthUser: '0'` 固定、owner identity の DOM 推定、単一 `likedSyncMeta` に依存している。複数 Google アカウントや YouTube DOM 変更で、別アカウントの LL を混ぜたり同期が失敗したりする。v1.35.0 ではリクエスト時の auth context と保存時の account identity を分離し、複数アカウントを前提にする。

### 設計案

Account identity:

```text
accountInfo = {
  accountId: string,        // DB key。ownerChannelId 優先
  accountSource: string,    // ownerChannelId / ownerHandle / datasyncHash / unknown
  ownerName: string,
  ownerHandle: string,
  ownerChannelId: string,
  sessionIndex: string | number | null,
  dataSyncIdHash: string | null,
  visitorData: string | null
}
```

優先順位:

1. `ownerChannelId` が取れれば `accountId = ownerChannelId`
2. `ownerHandle` が取れれば `accountId = ownerHandle`
3. `ytcfg.DATASYNC_ID` / response の `datasyncId` が取れれば raw 値は保存せず、SHA-256 などで `ds:<hash-prefix>` にする
4. それも無ければ `__unknown__`

Auth context:

- `ytcfg` から `SESSION_INDEX`、`DATASYNC_ID`、`INNERTUBE_CONTEXT.client.visitorData`、`LOGGED_IN` を抽出する。
- `FETCH_INNERTUBE_BROWSE` に `authContext` を渡し、`X-Goog-AuthUser` は `authContext.sessionIndex` があるときだけその値を使う。
- `X-Goog-AuthUser` を固定 `0` にしない。
- `Authorization: SAPISIDHASH ...` は従来どおり content.js で生成し、保存しない。
- `X-Goog-PageId` 相当の delegated session id を使うかは判断要。yt-dlp は ytcfg の delegated/user/session 情報から header を組み立てているため、参考にする。

Storage:

```text
chrome.storage.local.likedSyncMeta = {
  schemaVersion: 2,
  lastAccountId,
  accounts: {
    [accountId]: {
      accountId,
      accountSource,
      ownerName,
      ownerHandle,
      ownerChannelId,
      sessionIndex,
      lastSyncedAt,
      count
    }
  }
}
```

UI:

- Analyzer の高評価タブは当面 `lastAccountId` の表示を維持する。
- 複数アカウントがある場合は「現在表示中の account label」と総件数を出せる形にする。
- 別アカウント同期時の confirm は維持するが、「旧データは保持され、同一動画も account 別に保存される」旨に文言を変える。

### DBマイグレーション

Innertube 同期自体の DB migration は項目1に集約する。既存 `likedSyncMeta` は v2 形式へ storage migration する。

Storage migration:

1. `likedSyncMeta.schemaVersion !== 2` の場合、既存 meta を読み込む。
2. `meta.accountId` を normalize し、`accounts[accountId] = meta` に格納。
3. `lastAccountId = accountId` を設定。
4. 旧 `ownerName` / `ownerHandle` / `ownerChannelId` / `count` / `lastSyncedAt` は保持。

### 破壊的変更

- `likedSyncMeta` の shape が v2 になる。既存 Analyzer / background は同時更新が必要。
- `X-Goog-AuthUser` 固定をやめるため、同期対象アカウントが現行より正しくなる一方、従来偶然 `0` で取れていた環境の動作が変わる可能性がある。
- `accountId` が `ownerName` から `ownerChannelId` / `ownerHandle` / hash へ変わる環境がある。

後方互換:

- v1 meta は migration で `accounts` 配下に移す。
- 既存 liked records の `accountId` は DB migration で保全する。不明なものは `__unknown__`。
- SAPISIDHASH や Cookie は保存・export しない。

### テスト観点

- `SESSION_INDEX = 0` / `1` の ytcfg sample で `X-Goog-AuthUser` が期待値になる。
- `ownerChannelId` がある HTML で `accountId` が channel ID になる。
- `ownerChannelId` が無く handle だけある HTML で fallback する。
- owner 情報が取れない HTML で `__unknown__` になり、同期自体は失敗ではなく degraded success として扱える。
- アカウント A / B で同じ videoId が2件保存される。
- 旧 `likedSyncMeta` が v2 に移行され、Analyzer 表示が崩れない。
- 同期レスポンス diagnostics に `accountSource`, `sessionIndexPresent`, `visitorDataPresent`, `ytcfgContext` を含める。

## 5. 5万件超キャッシュのLRU化

### 現状コード位置

- `content.js:89-123`: `CACHE_MAX_SIZE = 50000`、起動時に `WatchedDB.getAllIds()` を Set へ全読み込みし、超過時は cache を clear
- `content.js:424-444`: `processPage()` が `watchedCache.has()` 後、残りを `WatchedDB.checkMultiple()`
- `content.js:968-1044`: watch ページの `checkRecommendations()` が cache / DB batch 判定
- `content.js:1518-1527`: watch ページで1秒ごとに recommendation check
- `db.js:297-326`: `isWatched()` / `checkMultiple()` は store.get を複数発行
- `db.js:425-431`: `getAllIds()` は `getAllKeys()` で全キー取得

### 目的・解決する問題

現在は watched 件数が 50,000 を超えると cache を破棄するため、watch ページの1秒ポーリングで DB 問い合わせが増える。10万件級の watched history を前提に、positive hit を維持しつつ negative / recent lookup を LRU で抑える。

### 設計案

Cache を3層に分ける。

```text
watchedPositive: Set<string>
  - watched と判定済みの videoId
  - full preload 成功時は全 watched ID
  - partial mode でも DB hit / seekbar detection / addWatched で増える

recentLookup: LRU Map<string, { watched: boolean, expiresAt?: number }>
  - positive / negative 両方の直近判定を保持
  - max 20,000 件を初期値
  - negative は TTL 5-15 分

pendingLookup: Map<string, Promise<boolean>>
  - 同じ videoId の並行 DB 問い合わせを coalesce
```

Cache mode:

```text
cacheMode: "full" | "partial" | "error"
```

- `full`: watched ID の preload が完了。`watchedPositive.has(videoId)` は authoritative positive。
- `partial`: 件数が上限を超える、または preload が中断された状態。positive Set と recent LRU を使い、miss は DB batch に回す。
- `error`: DB 初期化失敗。seekbar detection のみで degraded 動作。

Preload:

- `getAllKeys()` 一括取得は 10万件級ならまだ許容範囲だが、offscreen RPC で大きな配列を content に送る負荷がある。
- `DB_GET_WATCHED_IDS_PAGE { cursor, limit }` を追加し、5,000-10,000 件単位で content 側へ送る。
- 目安:
  - `FULL_CACHE_SOFT_LIMIT = 120000`
  - `FULL_CACHE_HARD_LIMIT = 200000`
  - hard 超過時は full preload をやめ、partial + LRU に切り替える。

Lookup:

1. DOM の `dataset.watchedHidden` / `dataset.watchedCheckedId` を先に見る。
2. `watchedPositive.has(videoId)` が true なら DB へ行かない。
3. `recentLookup` に fresh value があれば使う。
4. 残りを unique 化し、`DB_CHECK_MULTIPLE` で offscreen に batch 照会する。
5. true は `watchedPositive` と `recentLookup` に入れる。
6. false は `recentLookup` に TTL 付きで入れる。

Mutation:

- `DB_ADD_WATCHED` 成功時、content 側 cache も `watchedPositive.add(videoId)`。
- import / merge / clear / delete 後は background から content に `CACHE_INVALIDATED` を broadcast する。
- `CACHE_INVALIDATED` は全 clear ではなく、可能なら差分 `{ addedIds, deletedIds, mode }` を渡す。

Stats:

- `GET_STATS` に `cacheMode`, `positiveCacheSize`, `recentCacheSize`, `cacheLoadTime`, `cacheLoadedPages` を含める。
- Popup の表示は現行互換として `cacheSize` も残す。

### DBマイグレーション

Cache redesign 自体に DB migration は不要。offscreen 化後は `DB_CHECK_MULTIPLE` / paged key load の RPC を追加する。

### 破壊的変更

- `CACHE_MAX_SIZE` 超過時の「cache を捨てる」挙動をやめる。
- `content.js` が直接 `WatchedDB.getAllIds()` / `checkMultiple()` を呼ばなくなる。
- `GET_STATS` の cache 関連 field が拡張される。

後方互換:

- watched 判定のユーザー向け挙動は変えない。
- `cacheSize` は旧 UI 用に残す。
- DB が使えない場合は現行どおり seekbar detection へ fallback する。

### テスト観点

- 49,999件 / 50,001件 / 100,000件 / 200,001件の seed data で cache mode が期待どおりになる。
- watch ページ1秒ポーリングで同じ未視聴動画に対する DB 照会が LRU TTL 内で再発しない。
- DOM recycle 時、別 videoId は再判定される。
- import / merge / delete / clear 後に cache が不整合にならない。
- `DB_CHECK_MULTIPLE` の入力が重複 videoId を含んでも1回分にまとまる。
- Service worker / offscreen 再起動後も content 側 cache が復旧する。

## 6. durationSec 取得・累計再生時間集計（v1.37.0 追加項目・2026-05-12）

### 目的・解決する問題

- analyzer でチャンネル別・クレジット（作詞作曲編曲）別の **累計再生時間（=視聴済み動画の総尺）** を表示できるようにする。
- 現状 `watched` レコードは `title` / `channel` / credits 系のみで、`durationSec` を保持していないため、件数集計しかできない。

### 設計案

- DB v6 へのマイグレーション時に `durationSec: number | null` を `watched` レコードに追加（既存は `null`）。
- 取得経路は Innertube `player` レスポンスの `videoDetails.lengthSeconds` を採用。content.js の watch ページ取得時に title/channel と一緒に保存する。
- バックフィル：既存 Fix Credits / Fix Channels と同じバッチ基盤（background.js）に `FIX_DURATIONS` を追加し、`durationSec === null` のレコードを Innertube `player` で埋める。レート・同時実行・abort/auto-stop は credits 経路と同等。
- Analyzer：`azChannelRanking` / credits ランキングに `合計時間` 列を追加。null 混入時は `（うちN件 不明）` を併記。

### 注意点

- `lengthSeconds` は動画の長さ。**実視聴時間ではない**（途中離脱・倍速・リピートは反映されない）。UI ラベルは「視聴済み動画の総尺」とし、誤解を招かない表現にする。
- ライブ配信・プレミア公開は `lengthSeconds` が信頼できないケースがある。`isLiveContent` を併用して除外候補にする。
- バックフィルは ~11,500 件規模で数時間。Fix Credits 経路を流用し、進捗 UI を共通化する。

### 破壊的変更

- なし（追加フィールドのみ・既存レコード互換）。Export v2 にも `durationSec` を含める（PR3 の schema に追記）。

### テスト観点

- 新規視聴時に `durationSec` が記録されるか。
- ライブ動画で `null` または除外扱いになるか。
- バックフィル中断（abort/auto-stop）後の再開で重複処理されないか。
- analyzer の総尺集計が `null` を無視して計算するか。

## 実装順序とフェーズ分け

### 依存関係

- Offscreen DB owner は Export v2、Blob URL backup、cache RPC の前提。
- `likedVideos` 複合キー化は Innertube 複数アカウント設計と強く依存する。
- Export v2 は v6 liked schema と `likedSyncMeta` v2 を前提にすると整理しやすい。
- Cache LRU は offscreen RPC 後に実装する方が、DB call 経路を二度作らずに済む。

### 推奨 PR 分割

PR 1: Offscreen DB RPC foundation

- `offscreen` permission、`offscreen.html` / `offscreen.js`、background の `ensureOffscreenDocument()` を追加。
- v4 schema のまま、`GET_STATS` / `EXPORT_DATA` / `IMPORT_DATA` / `DELETE_VIDEO` / credits DB 更新を offscreen 経由に移す。
- YouTube fetch 系は content.js に残す。
- YouTube タブ無しで History / Popup Export が読めることを確認。

PR 2: DB v6 + account identity foundation **【2026-05-12 凍結（§1/§4）+ §6 v1.38.0 実装済】**

- `likedVideos` を `[accountId, videoId]` に migration。**【凍結】**
- `likedSyncMeta` を v2 storage 形式に migration。**【凍結】**
- `syncLikedPlaylist()` の accountInfo 抽出を導入。**【凍結】**
- `X-Goog-AuthUser: '0'` 固定をやめる。**【凍結】**
- `watched` レコードに `durationSec` を追加（既存 `null`）。content.js watch ページ取得・`FIX_DURATIONS` バックフィル・analyzer の累計時間集計を同梱。**【v1.38.0 実装済】**

PR 3: Export schema v2 + Blob URL backup

- v2 envelope、v1 import 互換、`records` alias を導入。
- `EXPORT_DOWNLOAD` / `BACKUP_NOW` / Auto Backup を offscreen Blob URL 経路へ移す。
- Popup / History / Analyzer の unwrap helper を v2 対応にする。

PR 4: Cache LRU / paged key load **【v1.39.0 実装済】**

- `DB_GET_WATCHED_IDS_PAGE` / `DB_CHECK_MULTIPLE` を使う content cache に更新。
- `watchedPositive` / `recentLookup` / `pendingLookup` を導入。
- 5万件超で cache を破棄しない。

PR 5: ドキュメントと回帰確認

- README / CHANGELOG / privacy 文面を v1.35.0 に追従。
- DB downgrade 非対応、Export v2、offscreen permission、複数アカウント保存を明記。
- Chrome 実機で upgrade / export / sync / cache の手動確認を行う。

### v1.35.0 DoD

- 実装後、`node --check` が既存 JS と新規 `offscreen.js` で成功。
- YouTube タブ無しで History Viewer / Popup Export / Auto Backup が動く。
- YouTube タブ有りで Fix Credits / Liked Sync が従来どおり動く。
- 同一 `videoId` の liked record を複数 `accountId` で保持できる。
- v1 raw array / v1 envelope / v2 envelope を import できる。
- 100,000 watched records で watch ページの recommendation polling が DB 連打にならない。

## 前提・未決事項

⚠️判断要:

1. DB v5 の用途。現行ファイルは v4 なので、v6 へ直接上げるか、v5 を別用途として残すか確認が必要。
2. Offscreen `reasons` は `BLOBS` のみで進めるか。Blob URL export と DB owner を同一 offscreen document に置く設計なら自然。
3. Chrome 109-115 をサポートするか。サポートするなら `runtime.getContexts()` fallback が必要。
4. Offscreen document の lifetime。常時維持か idle close かを決める。
5. `DATASYNC_ID` fallback の保存形式。raw は保存せず hash 化推奨だが、hash prefix 長を決める必要がある。
6. Analyzer の複数アカウント UI を v1.35.0 に含めるか。今回の最小案は「全件横断 + last account 表示」。
7. Export v2 に settings を含めるか。今回の最小案は watched / liked / likedSyncMeta のみ。

## 参考資料

- Chrome Offscreen API: https://developer.chrome.com/docs/extensions/reference/api/offscreen
- Chrome downloads API: https://developer.chrome.com/docs/extensions/reference/api/downloads
- yt-dlp YouTube extractor reference: https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/youtube/_base.py
