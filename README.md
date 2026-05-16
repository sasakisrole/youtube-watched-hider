# YouTube Watched Hider

> A Chrome extension (Manifest V3) that hides watched videos from YouTube recommendations.
> Includes a history viewer and a music taste analyzer that summarizes your listening habits from YouTube Topic channels.
> **Fully local storage** — no developer servers, no tracking, no analytics.
>
> **English:** This overview is all that's in English. Full documentation below is in Japanese.

---

YouTubeのおすすめから**視聴済み動画を非表示**にするChrome拡張機能。
視聴履歴はブラウザ内の IndexedDB にのみ保存され、外部には一切送信しません。

## 主な機能

### 視聴済み動画の非表示
- ホーム・検索結果・関連動画など、YouTube内の各種フィードから視聴済み動画を自動で隠す
- 動画のシークバー検知・watchページ遷移の両方で視聴を記録
- ショート動画 / 映画コンテンツも別トグルで非表示化可能
- 3層LRUキャッシュにより、10万件規模の視聴履歴でも5万件超過時にcacheを破棄せず watched 判定を維持

### 視聴履歴ビューア（History）
- 視聴済み動画をカレンダー形式で一覧・検索・ソート
- 個別削除、再生回数順・チャンネル名順などの並び替え
- エクスポート／インポート（JSON）で端末間移行も可能
- **自動バックアップ**：毎日JSONをダウンロードフォルダに書き出し
- Export schema v2では視聴履歴に加えて高評価同期データと同期メタ情報も保存（旧`records`形式のインポート互換も維持）
- **Fix Channels**：YouTube oEmbed APIを使ってチャンネル名の欠損を補完
- **Fix Credits**：概要欄から作曲・作詞・編曲クレジットを補完
- **Fix Durations**：watchページHTMLから視聴済み動画の長さ（`durationSec`）を補完

### Music Taste Analyzer（v1.21.0〜）
Historyビューアーの「Analyze」ボタンから起動する音楽傾向分析ビュー。
- YouTube Topicチャンネル（`アーティスト名 - Topic`）を抽出してアーティストランキング表示
- 全チャンネルランキング、タイトル頻出キーワード抽出
- チャンネル別・作曲/作詞/編曲クレジット別に、視聴済み動画の総尺を「合計時間」として表示
  - これは動画そのものの長さの合計であり、途中離脱・倍速・リピートを反映した実視聴時間ではありません
- 高評価プレイリスト（LL）を同期し、高評価チャンネルランキングを表示
- Top40アーティストを組み込んだ**Claude推薦用プロンプト**を生成（コピー→Claudeに貼るだけ）

## インストール（開発者モード）

1. このリポジトリをクローン or ZIPダウンロード
   ```bash
   git clone https://github.com/sasakisrole/youtube-watched-hider.git
   ```
2. Chrome で `chrome://extensions/` を開く
3. 右上の「**デベロッパーモード**」をオン
4. 「**パッケージ化されていない拡張機能を読み込む**」をクリック
5. このリポジトリのフォルダを選択

## 使い方

- **視聴済み隠しの有効/無効**：拡張アイコン → トグルスイッチ
- **履歴を見る**：拡張アイコン → 「Open History Viewer」
- **音楽傾向分析**：Historyビューアー右上の「Analyze」ボタン
- **データの書き出し/復元**：拡張アイコン → Export / Import

## プライバシー

- **データは全てブラウザ内（IndexedDB / `chrome.storage.local`）に保存**
- 保存したローカルデータを開発者サーバーや解析ツールへ送信しません
- 外部通信は以下のみ：
  - **YouTube oEmbed API**（`https://www.youtube.com/oembed`）：タイトル/チャンネル名の補完
  - **YouTube watchページHTML取得**：埋め込み禁止動画のメタデータ抽出フォールバック、動画長（`lengthSeconds`）の補完
  - **YouTube playlist / Innertube browse API**：ユーザー操作時の高評価プレイリスト同期
  - 認証が必要な高評価同期では、YouTubeページ上のcontent scriptからYouTube自身へ同一オリジン通信します。認証ヘッダは外部サーバーには送信・保存しません
- Analyzeの「プロンプトコピー」は**ローカルのクリップボードに書き込むだけ**。自動送信はしません

## 必要な権限

| 権限 | 用途 |
|---|---|
| `storage` | 視聴履歴と設定の保存 |
| `downloads` | 手動エクスポート / 自動バックアップのJSONダウンロード |
| `alarms` | 日次自動バックアップのスケジュール |
| `contextMenus` | 動画リンク右クリックメニュー（キューに追加 / 後で見る）の追加 |
| `offscreen` | IndexedDB操作と大容量JSONバックアップ用Blob URLの生成 |
| `*://*.youtube.com/*` | YouTube内DOMの操作とYouTube公式エンドポイントへのアクセス |

## 技術的な注意

- Manifest V3
- IndexedDB（`db.js`）で視聴履歴を管理
- v1.38.0 でDB schema v5へ更新し、`watchedVideos.durationSec` / `durationFetchFailed` を追加
- DB v5へ更新後、IndexedDB仕様上 v1.37.1以前のDB v4へはダウングレードできません
- IndexedDB ownerは extension offscreen document（`offscreen.html` / `offscreen.js`）
- service worker（`background.js`）はUI/アラーム/ダウンロードを中継
- バックアップは offscreen document でBlob URLを生成し、`chrome.downloads.download` で保存
- watched ID の初期読み込みは paged key load（8,000件単位）で実行し、content script 側で positive Set / recent LRU / pending lookup の3層キャッシュを管理

## Export schema v2

v1.36.0以降のエクスポートJSONは`schemaVersion: 2`のenvelopeです。

- `schemaVersion`: 現行は`2`
- `exportedAt` / `appVersion` / `source`: 書き出し日時・拡張バージョン・書き出し元
- `counts`: `watchedVideos` / `likedVideos` の件数
- `watchedVideos`: 視聴履歴。`videoId`、タイトル、チャンネル、視聴日時、再生回数、検出元、クレジット情報、`durationSec`（動画長。ライブは`-1`、未取得は`null`）などを含みます
- `likedVideos`: ユーザー操作で同期した高評価動画
- `likedSyncMeta`: 高評価同期のメタ情報（Cookie / 認証ヘッダは含めません）

旧形式のraw arrayと`{ records: [...] }`は引き続きインポートできます。v2エクスポートはファイルサイズ抑制のため`records`エイリアスを出力しません。v1.35.0以前へダウングレードする必要がある場合は、v2 JSON内の`watchedVideos`を手動で抜き出して視聴履歴のみ復元してください。

## 非公式ツールについて

この拡張機能は**YouTube LLCおよびGoogle LLCとは無関係**の非公式ツールです。
ユーザー自身のブラウザ内でのDOM操作と公開APIの利用にとどまり、YouTubeのサービス本体には何の影響も与えません。

## ライセンス

MIT License — [LICENSE](LICENSE) を参照

## CHANGELOG

バージョン履歴は [CHANGELOG.md](CHANGELOG.md) を参照
