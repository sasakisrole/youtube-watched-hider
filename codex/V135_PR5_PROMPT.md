[SESSION] 目的:youtube-watched-hider v1.35.0系 PR5（ドキュメント追従） | 編集:実装主導 | 出力:プロジェクトパスに直接書込 | 完了条件:README/CHANGELOG/PRIVACY/STORE_LISTING 等が v1.38.1 の実装と整合し、レポートに差分要約

# タスク: youtube-watched-hider v1.35.0系 PR5 — ドキュメント追従

> 全体方針: `C:\Users\sasaki\Dropbox\claude-workspace\.claude\codex-context.md` に従う。
> 設計書: `projects/youtube-watched-hider/codex/V135_DESIGN.md` の §「PR 5: ドキュメントと回帰確認」を参照。

## 背景

v1.35.0設計書の推奨PR分割のうち、PR1（offscreen DB owner）・PR3（Export schema v2 + Blob URL backup）は v1.35.0〜v1.36.0 で実装済み、v1.37.0 で durationSec 追加・v1.38.x で関連バグ修正済み。一方で **README / CHANGELOG / プライバシーポリシー / ストア掲載文 が、これらの変更を反映しきれていない疑い** がある（特に `docs/privacy.html` と `store-assets/PRIVACY_POLICY.md` は 2026-04-26 付け＝PR1反映前のまま）。

今回（PR5）はコードを触らず、**ドキュメント類のみを v1.38.1 の実装に追従させる**。実機回帰確認はこの委託の範囲外（このPC環境ではCodexからChrome実機操作不可のため、別途Claude/ユーザー側で実施する）。

## プロジェクト

- パス: `C:\Users\sasaki\Dropbox\claude-workspace\projects\youtube-watched-hider`
- 現在のリリース: **v1.38.1**（`manifest.json` 参照）
- 対象ドキュメント候補:
  - `README.md`
  - `CHANGELOG.md`（履歴追記のみ・既存エントリは触らない）
  - `docs/privacy.html`（GitHub Pages公開・最終更新 2026-04-26 で古い）
  - `store-assets/PRIVACY_POLICY.md`（同上）
  - `store-assets/STORE_LISTING.md`（Chrome Web Store掲載文）
  - `store-assets/PUBLISH_STEPS.md`（公開手順・必要に応じて）
  - `store-assets/SCREENSHOT_GUIDE.md`（必要に応じて）
- 参照すべき実装ファイル（事実確認用・編集禁止）:
  - `manifest.json`（permissions に `offscreen` が入っている前提）
  - `offscreen.html` / `offscreen.js`（PR1で追加）
  - `db.js`（DBスキーマ・Export v2 envelope定義）
  - `background.js`（Export/Backup経路）
  - `CHANGELOG.md` の v1.35.0〜v1.38.1 の各エントリ

## 会話文脈サマリ（Claude側で確定済み・Codexは会話履歴を見られない前提）

### 確定前提

- ユーザーは1アカウント運用のため、設計書 §1「likedVideos複合キー化」と §4「Innertube複数アカウント耐性」は **凍結中**（PR2）。PR5のドキュメントでも「複数アカウント保存」「accountId複合キー」を将来仕様として書かない。
- 設計書 §5「Cache LRU」は未着手（PR4）。「5万件超で cache を捨てる」既存仕様のままなので、ドキュメントに「LRUに変更済み」と書かないこと。
- durationSec は v1.37.0 で追加済み（設計書 §6）。Export v2 envelope にも含まれる。
- 拡張機能はGitHubで公開済み: https://github.com/sasakisrole/youtube-watched-hider
- privacy.html は GitHub Pages で公開されている。文面更新時は HTML構造（既存スタイル）を保ち、本文と「最終更新」日付のみ更新する。

### 未決事項

- ストア掲載は未公開の可能性あり。`store-assets/STORE_LISTING.md` の更新は「Chrome Web Store掲載前提の文面」として扱い、最新機能（offscreen化・Export v2・durationSec集計）を反映する: **仮置きOK**
- privacy.html の最終更新日: 今日（2026-05-14）に更新: **仮置きOK**

### 変更禁止

- 実装コード（`*.js` / `*.html`（privacy.html / index.html 除く） / `*.css` / `manifest.json` / `db.js` 等）は **一切触らない**。
- CHANGELOG.md の既存エントリ（v1.38.1〜v1.31.3）は文言改変しない。新規エントリも今回追加しない（PR5自体がドキュメント追従のみのため、リリースバンプを伴わない）。
- privacy.html の `<style>` ブロック・全体レイアウトは触らない（本文 `<section>` と `.meta`（最終更新日）のみ更新）。

### 検証条件（ルーブリック）

各条件を pass/fail で採点する：

1. **README.md の「必要な権限」「技術的な注意」セクション**: 現行 `manifest.json` の permissions と一致しているか（`offscreen` が含まれている前提で記述されているか）pass/fail
2. **README.md の「Export schema v2」セクション**: v1.36.0以降の v2 envelope について現実装と整合しているか（watchedVideos / likedVideos / likedSyncMeta / durationSec / records alias の言及があり、誤った仕様がないか）pass/fail
3. **README.md の「主な機能」セクション**: v1.37.0で追加された durationSec ベースの累計再生時間集計（analyzer のチャンネル別・クレジット別ランキングの「合計時間」列）について言及があるか pass/fail
4. **store-assets/PRIVACY_POLICY.md**: ローカル保存データの列挙が現行実装と一致しているか（IndexedDB に保存される項目: watchedVideos / likedVideos / 設定値、`chrome.storage.local`: likedSyncMeta / lastBackup / lastBackupCount 等）pass/fail
5. **store-assets/PRIVACY_POLICY.md**: 「offscreen document を使用する」旨と「外部送信なし」の整合説明があるか pass/fail
6. **docs/privacy.html**: store-assets/PRIVACY_POLICY.md と内容が同期しているか（HTML側は日本語のみで可・最終更新日が今日）pass/fail
7. **store-assets/STORE_LISTING.md**: 現在の主要機能（視聴済み非表示 / 履歴ビューア / Music Taste Analyzer / Fix Credits / Auto Backup / Export-Import v2 / durationSec累計）が掲載文に反映されているか pass/fail
8. **既存実装コード・既存CHANGELOGエントリへの変更なし**: `git diff` 相当でドキュメントファイルと納品レポート以外に差分が出ないか pass/fail
9. **複数アカウント関連・LRU関連の未来仕様を書いていない**: PR2/PR4 由来の未着手仕様を「実装済み」と誤記していないか pass/fail
10. **成果物レポートの作成**: `codex-reports/ad-hoc/youtube-watched-hider-v135-pr5_2026-05-14.md` が作成されているか pass/fail

全条件 pass になるまでは「完成」と判定しない。

## やってほしいこと

1. まず `manifest.json` / `offscreen.html` / `offscreen.js` / `db.js`（特に Export v2 envelope の組み立て箇所）/ `background.js`（Export/Backup経路）/ `CHANGELOG.md` の v1.35.0〜v1.38.1 を読んで、**現状の実装事実**を把握する。
2. 上記の「変更禁止」を厳守したうえで、README.md / docs/privacy.html / store-assets/PRIVACY_POLICY.md / store-assets/STORE_LISTING.md（および必要なら PUBLISH_STEPS.md・SCREENSHOT_GUIDE.md）を、v1.38.1 の実装事実に追従させる。
3. 変更したファイルと変更内容を、納品レポート（後述）に diff サマリ形式で残す。
4. **実機回帰確認は実施しない**。納品レポートに「実機回帰は別途Claude/ユーザー側で実施予定」と明記し、回帰時の推奨確認手順だけリスト化する（後述）。

## 要件

1. 文体は既存ドキュメントのトーンに合わせる（README は日本語、CHANGELOG エントリは追加しない、privacy.html は日本語＋簡潔）。
2. 過剰な装飾は避ける。絵文字は既存ドキュメントが使っていなければ追加しない。
3. プライバシー関連の記述は **過大な約束をしない**。「収集しない」「外部送信しない」など事実ベースの記述のみ。
4. offscreen document の説明は技術ユーザー向けに簡潔に（「Chrome 拡張のオフスクリーンドキュメント機能を使い、YouTube タブを開いていない状態でも履歴ビューア・エクスポートが動作するようにしました」程度）。
5. Export v2 envelope の仕様は README に1セクションを残す（既存セクションが古ければ更新）。フィールド一覧（`schemaVersion`, `watchedVideos`, `likedVideos`, `likedSyncMeta`, `records` alias, `durationSec`）を `db.js` の実装と一致させる。
6. PR2/PR4 由来の未来仕様（複数アカウント保存・cache LRU化）には触れない。「将来予定」とも書かない（凍結中のため）。
7. ファイル冒頭や末尾の Markdown lint 系の余計な変更は最小化する（無関係な行の改行・スペース変更を避ける）。

## 制約・注意

- 文字コードは UTF-8（BOM なし）。既存改行コードを維持する。
- privacy.html は HTML 構造を保つ。`<style>` ブロックは変更禁止。
- `store-assets/STORE_LISTING.md` の文字数制限（Chrome Web Store 短い説明 132文字以内・詳細説明 16,000文字以内）を意識する。
- 修正範囲が不明瞭な場合は、納品レポートに「迷った箇所」セクションを設けて判断材料を残す。
- 既存仕様と矛盾する記述を見つけた場合、**勝手に書き換えず納品レポートで報告**する（実装側が正しいのかドキュメント側が正しいのか判断保留）。

## 既存OSS実装・参考資料

- Chrome Offscreen API: https://developer.chrome.com/docs/extensions/reference/api/offscreen
- 既存 PR1 委託書: `projects/youtube-watched-hider/codex/V135_PR1_PROMPT.md`
- 既存 PR3 委託書: `projects/youtube-watched-hider/codex/V136_PR3_PROMPT.md`

## 完成物

1. **更新されたドキュメントファイル**（実物・最低でも README.md と privacy 系2ファイル）
2. **納品レポート**: `C:\Users\sasaki\Dropbox\claude-workspace\codex-reports\ad-hoc\youtube-watched-hider-v135-pr5_2026-05-14.md`
   - 変更ファイル一覧
   - 各ファイルの主な差分要約（before/after の見出し単位で）
   - 検証条件10項目の自己採点（pass/fail）
   - 矛盾を見つけて判断保留にした箇所のリスト（あれば）
   - **実機回帰の推奨確認手順チェックリスト**（Claude/ユーザー側で別途実施するためのもの）
     - 例: 「YouTube タブを閉じた状態で History Viewer を開いて履歴が表示されるか」「Popup から Export をダウンロードして JSON に schemaVersion: 2 / durationSec フィールドが含まれるか」「Auto Backup が Blob URL 経由で動作するか」「v1 envelope の Import が壊れていないか」など

## 進め方

- 設計書フェーズではないため、一気に最後まで進めてよい。
- 矛盾発見時の「勝手な書き換え禁止」だけ厳守する。
- 完了したら納品レポートのパスを示して停止。
