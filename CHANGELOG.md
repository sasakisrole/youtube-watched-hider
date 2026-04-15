# Changelog

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
