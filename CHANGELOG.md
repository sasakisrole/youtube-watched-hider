# Changelog

## v1.31.1 (2026-04-26)
- Fix: ページング取得が初回100件で止まる問題を修正
  - 原因: continuation API への送信 context が最小構成 (`client.clientName/clientVersion`) で、YouTube側がリクエストを拒否していた可能性
  - 修正: HTMLから `INNERTUBE_CONTEXT` フルオブジェクトをbalanced-brace抽出して送信
  - 同期完了時に diagnostics（continuation検出有無・apiKey有無・context有無）を console に出力

## v1.31.0 (2026-04-26)
- Feature: 高評価プレイリストのページング対応（過去分まで遡れる）
  - `youtubei/v1/browse` API のcontinuation tokenを使って2ページ目以降を取得
  - 最大50ページ（≒5000件）まで自動取得
  - HTMLから `INNERTUBE_API_KEY` / `INNERTUBE_CLIENT_NAME` / `INNERTUBE_CLIENT_VERSION` を抽出してbrowse APIへ
  - `content.js` に `FETCH_INNERTUBE_BROWSE` 中継ハンドラ追加
  - 同期完了メッセージにページ数・警告件数を表示
  - 取得時間目安: 数十秒〜2分（件数による）

## v1.30.2 (2026-04-26)
- Fix: DB読み込み無限フリーズ時のフェイルセーフを追加
  - `openDB` に5秒タイムアウト → 旧バージョン接続を握ったタブが居る場合に明示的にreject
  - `EXPORT_DATA` エラーをhistory.jsで `__error` 形式で受け取り、復旧手順を画面に表示
  - 旧Y2Tubeタブが古い content.js を保持している環境向けに、画面上で「すべてのYouTubeタブを閉じる→拡張リロード→YouTubeを開く→History再読込」の手順を案内

## v1.30.1 (2026-04-26)
- Fix: v1.30.0 で発生したDB読み込みのフリーズ問題を修正
  - 原因1: DBスキーマアップグレード(v3→v4)時に `onversionchange` ハンドラが無く、古いタブの旧バージョン接続が残ったままで新しいタブの open がブロックされ続ける
  - 原因2: Analyzer の高評価データ取得 (`GET_LIKED`) が background→content.js に中継されておらず、応答がない
  - 修正:
    - `db.js` に `onversionchange` ハンドラ追加（既存接続が自動でcloseしてアップグレードを通す）
    - `background.js` に `GET_LIKED` `GET_LIKED_STATS` `CLEAR_LIKED` の中継を追加
    - `analyzer.js` の `loadLiked` に3秒タイムアウト追加（YouTubeタブ未起動でもAnalyzerが固まらない）

## v1.30.0 (2026-04-26)
- Feature: 高評価（LL）プレイリスト同期機能を追加
  - Analyzerに「高評価」タブ追加。「高評価を同期」ボタンで `youtube.com/playlist?list=LL` から直近100件を取得しIndexedDBに保存
  - DBバージョン 3 → 4。新ストア `likedVideos`（`videoId, title, channel, likedAt, accountId, syncedAt, playlistIndex`）
  - アカウント変更検知：`chrome.storage.local.likedSyncMeta` に前回のアカウント情報を保存し、別アカウントの高評価が混ざる前に確認ダイアログを表示
  - Claude推薦プロンプトに「高評価Top30アーティスト」セクション追加
  - 動作には YouTube タブを開いた状態が必要（既存の Fix Credits と同じ仕組み）
  - ※初回ページ（≒最近の高評価100件）のみ。ページング対応は次バージョン予定

## v1.29.1 (2026-04-26)
- Fix: Fix Credits 抽出時に Twitter URL・括弧内URLをクリーンアップ
  - `parseCreditsFromDescription` で `(Twitter: https://...)` 等を抽出時点で除去
  - Analyzer 側のサニタイズと二重ガード（既存データもAnalyzer側で除外される）
  - 今後 Fix Credits を再実行した videoId からはノイズが入らなくなる

## v1.29.0 (2026-04-26)
- Improve: Analyzer「次に聴くべきアーティスト」プロンプトを大幅刷新
  - 旧「音楽系と思われる一般チャンネル Top15」はクレジット紐づき率40%以上＆5件以上の条件で再フィルタ → 実況・ラジオ等の混入を排除
  - 作曲家 Top20・編曲家 Top10 をプロンプトに追加（自編曲率も併記）
  - 作曲家名の Twitter URL・括弧崩れ等のノイズをサニタイズ
  - 「直近の傾向 Top15」（視聴期間後半1/3）を追加
  - プロンプト末尾に「既出は除外」「作家性も対象」等の制約を明示

## v1.28.1 (2026-04-20)
- Improve: Analyzer「クレジット」パネルの絞り込みUIをシンプル化
  - `全体 / Topic / 一般` の3ボタン → `一般も含める` チェックボックスに変更
  - デフォルトは Topic のみ（OFF）、チェックON で一般も合算
  - 同一行に集中していたボタンが減り、作曲/作詞/編曲タブとの競合も解消

## v1.28.0 (2026-04-20)
- Feature: Fix Credits を一般チャンネル（MV・公式配信など）にも拡張
  - ツールバーに `一般も含める` チェックボックス追加（デフォルトOFF＝従来通りTopicのみ）
  - 抽出は既存の「ラベル付き行のみ」正規表現を流用 → 誤検出を最小化
  - DB に `creditsSource`（'topic' | 'general'）フィールド追加 → 抽出元を記録
  - Analyzer「クレジット」パネルに `全体 / Topic / 一般` の絞り込みトグル追加
  - 既存データ（`creditsSource` 未記録）は channel 名から後方互換で推定

## v1.27.3 (2026-04-20)
- Improve: Fix Credits に「チェック済みスキップ」トグル追加（デフォルトON）
  - DBに `creditsCheckedAt`（スキャン日時）フィールド追加
  - 取得成功時（情報有り/無し問わず）にタイムスタンプを記録
  - トグルON時は前回スキャン済みのvideoIdを対象から除外 → 再実行が軽くなる
  - 新メッセージ `MARK_CREDITS_CHECKED`（no-credits時に呼ばれる）

## v1.27.2 (2026-04-20)
- Fix: Fix Credits が Google の bot 検知（`google.com/sorry/index` リダイレクト）で全件失敗する問題を修正
  - watch HTML 取得を拡張オリジン直接 fetch から **content script 経由プロキシ** に変更
    - YouTubeタブのCookie付き same-origin リクエストとして飛ぶためbot検知されにくい
    - 新メッセージ `FETCH_WATCH_HTML`（content.js がfetch実行しHTMLを返す）
  - `sorry-redirect` 検知で **バッチ自動停止**（レート制限を深掘りしないため）
  - `Fix Credits` ボタンが処理中は **「■ 中止」** に切替、クリックで即停止
  - 完了ステータスに「⚠ 自動停止」「⏸ 中止」の区別を表示
  - 実行前確認ダイアログに「YouTubeタブを開いたままに」の注意書き追加

## v1.27.1 (2026-04-20)
- Improve: Fix Credits の診断強化
  - 失敗を「情報なし（クレジット行がそもそも無い）」と「取得失敗（HTTP/redirect/DB）」に分類表示
  - HTMLスライス窓を 20,000→100,000 文字に拡大（keywords等で押し出されるケース対策）
  - 抽出ラベル拡張（`Music` / `Composed by` / `Written by` / `Arranged by` / `Composition` 等）
  - 並列数 5→3 に抑制（スロットリング回避）
  - 完了時に失敗理由の内訳をステータスバー＋コンソールに出力

## v1.27.0 (2026-04-20)
- Add: Topic動画のクレジット（作曲・作詞・編曲）補完機能
  - `Fix Credits` ボタン：Topicチャンネルの動画のみを対象にwatchページ概要欄から `Composer:` `Lyricist:` `Arranger:` を抽出
  - DBスキーマv3：`composer` / `lyricist` / `arranger` フィールド追加
  - Analyzeに「クレジット」タブ新設：作曲/作詞/編曲の切替＋名義同一率（作曲者＝編曲者）表示
  - `background.js` で並列5本の watch HTML fetch（Fix Channelsと同構造）

## Unreleased
- Chore: Chrome Web Store 公開準備
  - `docs/privacy.html` 追加（プライバシーポリシー・GitHub Pagesで公開）
  - `docs/index.html` 追加（Pages ルート用）
  - 提出用素材を `store-assets/` に集約（STORE_LISTING / PUBLISH_STEPS / SCREENSHOT_GUIDE）

## v1.26.1 (2026-04-18)
- Improve: History Harvest の状態表示を強化
  - 走行中: 赤い点滅ドット＋`Running · +N / M · idle K/6`（停止まで何回残か可視化）
  - 自動停止: 緑バナー `✅ 完了（履歴末尾）` を表示
  - 手動停止: 灰バナー `⏸ 停止` を表示

## v1.26.0 (2026-04-18)
- Add: History Harvest モード（Settingsでトグル）
  - 履歴ページ右下に `▶ Start Harvest` ボタンを表示
  - 実行中: サムネイル画像を非表示にして読込コストを削減＋自動スクロールでYouTubeの無限スクロールをトリガ
  - スキャン済みカードをDOMから即削除してページ長を一定に保ち、Chromeクラッシュを回避
  - 95%以上視聴のみをDBに取り込み（既存の判定ロジックをそのまま利用）
  - 新規6連続0件で自動停止 / `■ Stop` で任意停止
  - OFF時は完全に非表示（通常の履歴閲覧に影響なし）

## v1.25.0 (2026-04-17)
- Add: 視聴済みDBへの新規取り込みを画面右下にトースト表示（`+N件 視聴済みに取り込み`）
  - 発火: シークバー検知（おすすめ・検索結果・視聴ページ等）および履歴ページのバッチ取り込み
  - 連続取り込みは件数を加算し、3秒静かになるとフェードアウト
- Internal: `WatchedDB.addWatched()` が `{ isNew }` を返すよう変更（既存record時は発火しない）

## v1.24.3 (2026-04-17)
- Fix: 「キューに追加」ボタンが定期的に消える問題を修正
  - firstCard セレクタの緩いfallbackを廃止し `findWatchLaterAnchor()` に統一
    - 旧: 関連動画コンテナ外の `yt-lockup-view-model` を拾うと、観測対象の親ノードが
      YouTube側で破棄されMutationObserverが無効化してボタン消失
  - 既存ボタン再配置時に親ノードの違いも検知してObserverを再設定
  - SPAナビ完了時にも `ensureQueueAllButton()` を呼ぶよう追加

## v1.24.0 (2026-04-16)
- Improve: Aboutバージョン表示を `chrome.runtime.getManifest().version` で動的取得に変更
- Improve: Export形式をversioned envelope（schemaVersion, exportedAt, appVersion, count, records）に変更
  - 旧形式（raw array）のインポートは引き続き互換あり
- Improve: Import時にレコードの型を正規化（videoId/title/channel/watchedAt等の型チェック）
- Improve: 履歴ページからのImport時、セクションヘッダーの日付（今日/昨日/4月14日等）をwatchedAtに使用
  - 旧: 取り込み時点のDate.now() → 新: 実際の視聴日に近い日付を保持
- Fix: Watch Later の findWatchLaterAnchor() から /watch 以外の到達不能分岐を削除

## v1.23.9 (2026-04-16)
- Fix: キューに追加・後で見るボタンがYouTubeのDOM入れ替えで消える問題を修正
  - ボタン挿入後、親要素をMutationObserverで監視し削除検知後100ms以内に自動再挿入
  - 旧: recoInterval（最大1秒）まで消えたまま → 新: ほぼ即時復元

## v1.22.4 (2026-04-15)
- Fix: Queue All で関連動画が現在再生中の動画より上に追加されるのを修正
  - 処理開始時にまず現在再生中の動画をキューに追加してシード（`seedQueueWithCurrentVideo()`）
  - 以降の関連動画は現在の動画の下に順次追加される

## v1.22.3 (2026-04-15)
- Fix: Queue All で全件失敗していた問題を修正
  - 新UIのメニュー項目 `yt-list-item-view-model` をセレクタに追加（旧UIの `tp-yt-paper-item` のみヒットしなくなっていた）
  - クリックターゲットを内側の `button` / `[role="menuitem"]` / `.yt-list-item-view-model-wiz__container` に変更

## v1.22.2 (2026-04-15)
- Fix: Queue Allボタンが縦方向に引き伸ばされるビジュアル崩れを修正
  - 親要素のflex/grid stretchを回避するため、最初の関連動画カードの直前に挿入する方式に変更
  - ボタン自体にmax-height / flex:0 0 auto / align-self:flex-start を明示

## v1.22.1 (2026-04-15)
- Fix: Queue All が新UI（`yt-lockup-view-model`）で動作しない問題を修正
  - kebabボタンのセレクタに `aria-label="その他の操作"` / `More actions` を追加
- 狭いウィンドウ幅でQueue Allボタンが表示されない問題を修正
  - anchor候補に `#secondary-inner` / `#secondary` を追加、最終フォールバックでカードの親要素を使用

## v1.22.0 (2026-04-15)
- Queue All 機能追加
  - watchページの関連動画サイドバー上部に「⏭ キューに追加 (N)」ボタンを挿入
  - クリックで表示中の関連動画を順次キューに追加（各カードの「︙」メニュー→「キューに追加」を自動操作）
  - Shorts / Live配信 / 視聴済みで非表示にされた動画は自動スキップ
  - 処理中は「追加中 N/M」表示、クリックで中止可能
  - 関連動画リストが増えた時点でボタンラベルの件数も自動更新

## v1.21.0 (2026-04-15)
- Music Taste Analyzer を history.html に統合
  - `Analyze` ボタンで分析ビューに切替
  - アーティスト（-Topic）/ 全チャンネル / キーワード / Claude推薦プロンプト の4タブ
  - Topic検索 / YT検索 / 類似検索 のワンクリックリンク
  - プロンプトTop40アーティスト+Top15一般チャンネルをClaudeに渡して推薦取得

## v1.20.1 (2026-04-14)
- 埋め込み禁止動画（oEmbed 401/403）のフォールバック対応
  - `fetchWatchPageMeta()`: watchページHTMLから `ytInitialPlayerResponse.videoDetails` の title/author を抽出
  - `fetchVideoMeta()` で oEmbed → HTML の順に試行
  - 公式MV・年齢制限・生配信アーカイブ・CM動画等も補正可能に

## v1.20.0 (2026-04-14)
- 録画時タイトル/チャンネルの取得を堅牢化
  - `backfillTitleChannel()` を新設：0.5秒間隔で最大12秒 DOM一致を待ち、タイムアウト時は oEmbed API にフォールバック
  - `recordCurrentVideo()`: DOM不整合 or 空フィールド時に backfill 予約
  - 視聴開始時の backfill も同関数に統合（単発setTimeoutから堅牢な再試行へ）
  - シークバー検知経路でカードからtitle/channelが取れなかった場合もoEmbed補完

## v1.19.2 (2026-04-14)
- Fix: oEmbed URLの `url=` パラメータ未エンコードで全件失敗していたバグ修正
- エラー時にconsole.warnで詳細を出力

## v1.19.1 (2026-04-14)
- Fix Channels の進捗をストリーム表示（chrome.runtime.Port）
  - ステータス欄に「残りN/総件数（更新X / 失敗Y）」をリアルタイム更新
  - No Channel フィルタ有効時は、補完できた行から即座に一覧から消える

## v1.19.0 (2026-04-14)
- チャンネル名の補正機能を追加（YouTube oEmbed API経由）
  - `Fix Channels`: チャンネル未記録エントリをoEmbedで補完
  - `Fix (force)`: 表示中エントリをoEmbedで上書き補正（誤登録の修復用）
- db.js `updateTitleAndChannel(..., force)` で強制上書きをサポート
- background.js で並列5本の oEmbed fetch（レート制限対策）

## v1.18.1 (2026-04-14)
- history画面に「No Channel」フィルタ追加（チャンネル未記録エントリの洗い出し用）

## v1.18.0 (2026-04-14)
- Fix: 再生履歴に誤ったチャンネル名が登録されるバグを修正
  - SPA自動再生時のURL/DOMレースを `watchMetadataMatches()` でガード
  - `getWatchPageChannel()` を `ytd-watch-metadata` / `#owner` 配下に限定（サイドバー推奨の誤拾い防止）
  - DOM不整合時は videoId のみ記録し、DOM安定後に backfill

## v1.17.0 以前
- 履歴タイトル表示・再生回数記録・ended検知（〜2026-03-20）
- おすすめ動画非表示（v1.9.0 / 2026-03-20）
