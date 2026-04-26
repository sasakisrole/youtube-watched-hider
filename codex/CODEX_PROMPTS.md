[SESSION] 目的:LLプレイリスト全件取得のページング修正 | 編集:実装主導 | 出力:プロジェクトパスに直接書込 | 完了条件:実機で100件超を取得できる実装案＋修正コード

# タスク: youtube-watched-hider のLLプレイリスト・ページング機能の修正

> 全体方針: `.claude/codex-context.md` に従う。

## 背景

Chrome拡張機能 `youtube-watched-hider` に「YouTube高評価プレイリスト（LL = Liked Videos）の全件同期」機能を追加した。初回ページの100件は取れるが、**continuation token を使った2ページ目以降の取得が失敗** している。

ユーザーのconsoleログ：
```
[liked-sync diagnostics] {initialContinuation: false, ytcfgApiKey: true, ytcfgContext: true, clientVersion: '2.20260424.01.00'}
```

つまり initial HTML から continuation token が取れていない（v1.31.2でstringify+regexフォールバックを追加したが、それでも `initialContinuation: false`）。

## プロジェクト

- パス: `C:\Users\sasaki\Dropbox\claude-workspace\projects\youtube-watched-hider`
- 主に見るべきファイル:
  - `background.js`（行 482〜700 あたり、特に `parseLikedPlaylistHtml`, `extractItemsAndContinuation`, `extractInnertubeContext`, `syncLikedPlaylist`）
  - `content.js`（`FETCH_PLAYLIST_HTML`, `FETCH_INNERTUBE_BROWSE` ハンドラ）
- 拡張機能のmanifest.jsonは MV3、host_permissions は `*://*.youtube.com/*` のみ

## 現在の実装方針（要修正）

1. content.jsから `https://www.youtube.com/playlist?list=LL` を `fetch()` でHTML取得（cookie同送、ユーザーのログイン状態で）
2. HTML中の `var ytInitialData = {...};</script>` を抽出
3. ytInitialData をJSON.parseしてDFSで `playlistVideoRenderer` を全部拾う（→ 100件）
4. 同じくDFSで `continuationItemRenderer.continuationEndpoint.continuationCommand.token` を探す（→ **見つからない**）
5. (v1.31.2) フォールバック1: stringify(ytInitialData) を `/"continuationCommand":\{"token":"([^"]+)"/` で正規表現マッチ → これも見つからない
6. (v1.31.2) フォールバック2: raw HTML 全体を同正規表現でマッチ → 結果不明（多分これも空）
7. continuation が取れたら、`POST https://www.youtube.com/youtubei/v1/browse?prettyPrint=false&key=<API_KEY>` で次ページ取得を想定
   - body: `{ context: <INNERTUBE_CONTEXT全オブジェクト>, continuation: token }`
   - context は HTML中の `"INNERTUBE_CONTEXT":{...}` を balanced-brace 抽出して使用

## 仮説

LL は private playlist なので：

- **仮説A**: continuation token は HTML 初期ロードには含まれず、最初から `youtubei/v1/browse` への POST でしか取得できない（`browseId: 'VLLL'` を送る）
- **仮説B**: HTMLには含まれるが、別キー名（例: `nextContinuationData` `reloadContinuationData` `loadMoreContinuationItem`）で記述されている
- **仮説C**: SAPISIDHASH ヘッダが必要で、未付与のため API がエラー（しかし初期HTMLが取れている時点でcookieは効いているはず...）
- **仮説D**: そもそも `playlist?list=LL` ページは動的レンダリングで初期100件もJS実行で入る形になっており、`fetch` で取った素のHTMLには100件もcontinuationも入っていない
  - ※ただし、ユーザーは100件は取れているのでこの仮説は否定的
- **仮説E**: x-youtube-client-name / x-youtube-client-version ヘッダを送らないとAPIがエラー（あるいはレスポンスが縮退する）
- **仮説F**: yt-dlp 等のメンテされている実装は別エンドポイント（例: `/feed/library` や `/youtubei/v1/browse` を `browseId: 'FElikes'` で呼ぶ）を使っているかもしれない

## やってほしいこと

1. **yt-dlp の YouTube extractor 実装を WebSearch で調査**して、LL（または通常のYouTubeプレイリスト）のページング方式の確実な実装パターンを特定する
   - 特に最近（2025年以降）の YouTube 構造変更にどう追従しているか
   - 必要なヘッダ（X-YouTube-Client-Name, Authorization SAPISIDHASH, X-Origin, X-Goog-AuthUser 等）
   - INNERTUBE_CONTEXT に最低限必要なフィールド
   - 初回ページ取得は HTML スクレイピング vs `youtubei/v1/browse` POST どちらが確実か
   - LL の正しい browseId（`VLLL` か `FElikes` か他か）
2. 上記を踏まえ、現在の `background.js` / `content.js` の実装の問題点を特定
3. **修正コードを直接書く**（small fix で済むなら直接 edit、根本見直しが必要なら設計書を先に出す）
4. 修正後、ユーザーが Chrome で実行する際の動作確認手順を `codex-reports/ad-hoc/yt-watched-hider-pagination_2026-04-26.md` に記載

## 制約・注意

- Manifest V3 service worker から fetch しても private playlist は取れない（cookie が乗らないため）。**必ず content.js 経由でYouTubeタブのコンテキストで fetch する**（既存設計を踏襲）
- 既存の `FETCH_PLAYLIST_HTML` `FETCH_INNERTUBE_BROWSE` ハンドラを活用してOK。ヘッダを追加したいなら content.js のハンドラを拡張する
- SAPISIDHASH 計算が必要なら、SHA1 を Web Crypto API で計算する形で実装可能（背景: SHA1(`<unix_seconds> <SAPISID> https://www.youtube.com`) → ヘッダ `Authorization: SAPISIDHASH <unix_seconds>_<hash>`）
- ユーザーは Chrome on Windows、ja-JP / Asia/Tokyo
- スタイル: 既存コードに合わせる（const + arrow / async-await、コメント簡潔）
- node 22 で `node --check` が通ること

## ⚠️ 重要: 既存モジュールの実態

### 既存メッセージ型（変更しない）
```
FETCH_PLAYLIST_HTML  : { listId } → { success, html, finalUrl }
FETCH_INNERTUBE_BROWSE: { apiKey, body } → { success, data }
UPSERT_LIKED         : { items, accountId } → { success, added }
```

### 既存parserの構造（参考）
- `extractItemsAndContinuation(data)`: ytInitialDataやAPIレスポンスをDFSで walk して `playlistVideoRenderer` と `continuationItemRenderer` を抽出
- `parseLikedPlaylistHtml(html)`: HTML から `var ytInitialData = {...};</script>` を取り出して上記に渡す
- `extractInnertubeContext(html)`: HTMLの `"INNERTUBE_CONTEXT":` の値を balanced-brace で抽出
- `syncLikedPlaylist({confirmAccountChange, maxPages})`: 全体オーケストレーション。最大50ページ

### 触っていい範囲
- `background.js` 全体
- `content.js` のメッセージハンドラ（既存ハンドラの引数増設はOK、削除はNG）
- 必要なら新規ヘルパー関数追加

### 触らない
- `db.js`（DB スキーマには関与しない）
- `analyzer.js`（同期側ロジックの問題）
- `manifest.json`（permissions変更は不要のはず。yt-dlp等を参考に必要なら別途相談）

## 完成物

1. `background.js` / `content.js` の修正版（直接書込）
2. `codex-reports/ad-hoc/yt-watched-hider-pagination_2026-04-26.md` に：
   - 調査サマリ（yt-dlp等から得た知見、3〜5行）
   - 採用した方式の説明（なぜそれを選んだか）
   - 主な変更点リスト
   - ユーザーがChromeで動作確認する手順（DevTools console で何を見るか含む）
   - 既知の限界・将来の改善点（あれば）

## 進め方

- 調査だけで止まる必要はない。**修正まで一気にやってOK**
- ただし大幅な設計変更（既存メッセージ型を壊す等）が必要だと判断したら、修正前にその旨を成果物レポートに先に書いて止めること
- WebSearch を積極的に使うこと（yt-dlp のソースコード・GitHub Issue・Stack Overflow 等）
