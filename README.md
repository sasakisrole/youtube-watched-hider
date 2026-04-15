# YouTube Watched Hider

> A Chrome extension (Manifest V3) that hides watched videos from YouTube recommendations.
> Includes a history viewer and a music taste analyzer that summarizes your listening habits from YouTube Topic channels.
> **Fully local** — no external servers, no tracking, no analytics.
>
> **English:** This overview is all that's in English. Full documentation below is in Japanese.

---

YouTubeのおすすめから**視聴済み動画を非表示**にするChrome拡張機能。
視聴履歴はブラウザのローカルストレージにのみ保存され、外部には一切送信しません。

## 主な機能

### 視聴済み動画の非表示
- ホーム・検索結果・関連動画など、YouTube内の各種フィードから視聴済み動画を自動で隠す
- 動画のシークバー検知・watchページ遷移の両方で視聴を記録
- ショート動画 / 映画コンテンツも別トグルで非表示化可能

### 視聴履歴ビューア（History）
- 視聴済み動画をカレンダー形式で一覧・検索・ソート
- 個別削除、再生回数順・チャンネル名順などの並び替え
- エクスポート／インポート（JSON）で端末間移行も可能
- **自動バックアップ**：毎週JSONをダウンロードフォルダに書き出し
- **Fix Channels**：YouTube oEmbed APIを使ってチャンネル名の欠損を補完

### Music Taste Analyzer（v1.21.0〜）
Historyビューアーの「Analyze」ボタンから起動する音楽傾向分析ビュー。
- YouTube Topicチャンネル（`アーティスト名 - Topic`）を抽出してアーティストランキング表示
- 全チャンネルランキング、タイトル頻出キーワード抽出
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

- **データは全てブラウザ内（`chrome.storage.local`）に保存**
- 第三者への送信は一切ありません
- 外部通信は以下のみ：
  - **YouTube oEmbed API**（`https://www.youtube.com/oembed`）：タイトル/チャンネル名の補完
  - **YouTube watchページHTML取得**：埋め込み禁止動画のメタデータ抽出フォールバック
  - どちらもYouTube公式の公開エンドポイントで、認証情報は一切送信しません
- Analyzeの「プロンプトコピー」は**ローカルのクリップボードに書き込むだけ**。自動送信はしません

## 必要な権限

| 権限 | 用途 |
|---|---|
| `storage` | 視聴履歴と設定の保存 |
| `downloads` | 手動エクスポート / 自動バックアップのJSONダウンロード |
| `alarms` | 週次自動バックアップのスケジュール |
| `*://*.youtube.com/*` | YouTube内DOMの操作と公式APIアクセス |

## 技術的な注意

- Manifest V3
- IndexedDB（`db.js`）で視聴履歴を管理
- service workerベース（`background.js`）
- バックアップは `chrome.storage.local` 上のBlob URL生成後ダウンロード

## 非公式ツールについて

この拡張機能は**YouTube LLCおよびGoogle LLCとは無関係**の非公式ツールです。
ユーザー自身のブラウザ内でのDOM操作と公開APIの利用にとどまり、YouTubeのサービス本体には何の影響も与えません。

## ライセンス

MIT License — [LICENSE](LICENSE) を参照

## CHANGELOG

バージョン履歴は [CHANGELOG.md](CHANGELOG.md) を参照
