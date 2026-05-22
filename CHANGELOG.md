# Changelog

## v1.41.0 (2026-05-22)
- Feature: チャンネルの「動画」タブでも一括「キューに追加」「後で見る」ボタンを表示
  - `@handle/videos` / `channel/<id>/videos` / `c/<name>/videos` / `user/<name>/videos` のフィルター行（新しい順/人気の動画/古い順）の右端に、表示中グリッド動画数つきの既存スタイルボタンを追加（フィルター行が無い場合はグリッド先頭にフォールバック）
  - 対象はDOMにレンダリング済みの表示カードのみとし、Shorts / ライブ / プレイリスト・ミックス / 非表示カードは除外
  - チャンネルページでは現在再生動画のキューシードを行わず、既存 `/watch` ページの関連動画一括追加動作は維持
- Improve: 50件超の一括処理では確認ダイアログに所要見込みと中止方法の注意を追加
- Fix: YouTube SPA遷移時に一括ボタンをページ種別に応じて再配置・削除し、チャンネル動画ページと `/watch` 間で幽霊ボタンが残りにくいよう調整

## v1.40.0 (2026-05-16)
- Feature: History Viewer に Enrich Credits UI を追加
  - 未割当 `creditsRaw` を固定ルール、uta-net、MusicBrainz の順に照合し、composer / lyricist / arranger 候補をチャンネル単位タブで確認できるようにした
  - `composer_rules.json` を同梱し、fripSide - Topic / Nobuo Uematsu - Topic / YOASOBI - Topic / Berlinist - Topic の4件の固定作曲者ルールを初期収録
  - uta-net / MusicBrainz fetch は service worker 経由にし、各ソース1req/秒のレート制限を追加
  - 類似度 `sim >= 0.95` は自動選択、`0.85 <= sim < 0.95` は目視確認用に未選択、`sim < 0.85` は非表示
  - 書き戻し前に確定予定JSONを保存できるボタンを追加し、誤確定時のロールバック材料を残せるようにした
- Improve: Enrich Credits の書き戻しは既存DBスキーマを変更せず、既存値が空の role フィールドだけを既存 `UPDATE_CREDITS` RPC 経由で更新
- Note: 既存の Fix Credits（概要欄fetch）ルート、content.js、db.js、popup.js、analyzer.js は変更なし

## v1.39.0 (2026-05-16)
- Feature: content script の watched 判定キャッシュを3層化
  - `watchedPositive` は full preload 成功時に全 watched ID を保持し、50,000件超でも cache を破棄しない
  - `recentLookup` は positive / negative の直近判定を LRU 20,000件で保持し、未視聴カードの1秒ポーリング中 DB 再照会を TTL 10分で抑制
  - `pendingLookup` で同一 videoId の並行 `DB_CHECK_MULTIPLE` を coalesce
- Improve: watched ID preload を `DB_GET_WATCHED_IDS_PAGE` の paged key load へ変更
  - 1回 8,000件ずつ `openKeyCursor` で読み込み、巨大配列を offscreen から content へ単発転送しない
  - 120,000件超は警告のみ、200,000件超は `partial` mode に切替し、読み込んだ positive Set は保持
- Improve: import / merge / delete / clear 後に `CACHE_INVALIDATED` を YouTube タブへ broadcast
  - small import / delete は patch、merge / clear / large import は reload で content cache を同期
- Improve: `GET_STATS` に cache diagnostics を追加し、popup Settings に `cacheMode` badge と positive/recent/pages/load time を表示
- Note: DB schema は v5 のまま。追加は RPC と content-side cache のみ

## v1.38.1 (2026-05-13)
- Fix: Fix Durations のパーサー・一時失敗を `durationFetchFailed` に永続保存しないよう変更
  - 従来は env系（`no-youtube-tab` / `sorry-redirect` / `proxy-failed` / `fetch-error` / `http-429`）のみ除外する blacklist 方式
  - `no-duration` / `empty-html` / `no-playerResponse` 等の一時失敗も保存されてしまい、次回 Fix Durations の対象から永続除外される問題があった
  - whitelist 方式に変更し、`playability-*`（age-restricted・removed・private 等）の動画固有の永続失敗のみ保存するよう修正
  - history.js の in-memory キャッシュ更新も同ロジックに同期
  - レビュー指摘 M1 対応（codex-reports/ad-hoc/yt-watched-hider-v138-review_2026-05-12.md）

## v1.38.0 (2026-05-12)
- Feature: watchedVideos DB schema を v5 に更新し、視聴済みレコードへ `durationSec` を追加
  - 既存 v4 レコードはアップグレード時に `durationSec: null` を明示セットし、後続バックフィル対象として判定可能にした
  - `durationSec = -1` はライブ動画の対象外マークとして扱う
- Feature: 新規視聴記録時に `ytInitialPlayerResponse.videoDetails.lengthSeconds` 由来の動画長を保存
  - 取得できない場合は従来どおり視聴記録を優先し、`durationSec: null` のまま保存
- Feature: History のメンテナンス操作に `Fix Durations` を追加
  - `durationSec === null` かつ `durationFetchFailed` 未設定の動画だけを対象に、YouTube watch HTML から `lengthSeconds` を補完
  - Fix Credits と同じ並列数2・500ms + jitter のレート設計、abort、sorry-redirect 自動停止に対応
  - 削除済み・非公開・age-gate などの取得失敗は `durationFetchFailed` に reason を保存し、次回再処理から除外
- Feature: Analyzer のチャンネル別・クレジット別ランキングに「合計時間」列を追加
  - null は合計から除外し、既知値がある行では「うち N件 不明」を併記
  - 全件不明の行は `—` 表示。列ヘッダクリックで再生数順 / 合計時間順を切替
- Fix: 「キューに追加」「後で見る」一括追加ボタンが表示されない不具合を修正
  - 関連動画サイドバーには chip フィルター用などの 0×0 隠しセクション（`ytd-item-section-renderer`）が先頭に存在し、`querySelector` が document order で最初の隠しセクション内のカードをアンカーとして拾っていた
  - `findWatchLaterAnchor()` を `offsetParent !== null` で可視カードのみ採用するよう変更
  - 併せて可視セクション側が `display: grid` の場合に備え、ボタン style に `grid-column: 1 / -1` を追加（防御的・grid 外では無害）
- Fix: 「キューに追加 (N)」「後で見る (N)」ボタンの件数表示が実際の表示カード数より多い不具合を修正
  - 同じ隠しセクション問題で、`findQueueableCards()` / `findWatchLaterableCards()` も可視カードと隠しカードを混ぜてカウントしていた
  - 両関数に `card.offsetParent === null` のスキップを追加
- Fix: ライブ配信動画で `<video>.duration === Infinity` の判定が到達不能だった問題を修正（`Number.isFinite()` で先に弾かれていた）
- Fix: History viewer の Fix Durations / Fix Credits / Fix Channels / Analyze ボタンをクリックすると `currentSort` が破壊されて並べ替えが崩れる問題を修正
  - 旧コードは `.sort-btn` クラス全部にソートハンドラを付け、id 除外で1個ずつガードしていた
  - `data-sort` 属性を持つボタンだけにハンドラを限定する方式に変更
- Fix: History viewer のメンテナンス補完（Fix Credits / Fix Durations / Fix Channels / Fix force）を相互排他化
  - いずれかの補完中は他のメンテナンスボタンを無効化し、共有 `fixStatus` の奪い合いを防止
  - Fix Credits と Fix Durations の watch HTML 取得を共通キューへ集約し、全体で並列2・500ms + jitter を維持
  - `sorry-redirect` 検知時は共有キュー全体を自動停止し、同時実行時もYouTubeセッション保護を優先
- Fix: DB v5 マイグレーション時に `indexedDB.open()` 全体の 5秒 timeout が継続し、大量レコード（~24,000件）の cursor 全件 update が timeout で失敗するリスクを修正
  - `onupgradeneeded` が発火した時点（=blocked 状態を抜けた直後）で timer を `clearTimeout` し、upgrade transaction の完了を待つ
- Note: DB v5 へ上げた後は IndexedDB 仕様上 v4 へのDBダウングレードは不可。v1.37.1以前へ戻す場合は事前エクスポートを推奨

## v1.37.1 (2026-05-02)
- Improve: 推移タブの見え方を改善
  - 外れ値クリップの閾値を「2番目に大きい値 × 1.1」に変更（従来: P95 × 1.5）。2番手の日が常に完全表示されるため日々の変動が見やすくなる
  - 発動条件を「最大値 ≥ 2番目 × 1.8」に変更（従来: 最大値 > P95 × 3）
  - データ蓄積期間が選択範囲より短い場合は自動的に「全期間」表示に切替（初期表示時のみ）

## v1.37.0 (2026-05-02)
- Feature: Analyze に「推移」タブを追加
  - 累計総視聴数の推移（折れ線グラフ）
  - 日別 新規視聴数（棒グラフ・`firstWatchedAt` ベース）
  - KPI: 累計 / 今月の新規 / 今日（新規/再視聴）
  - 期間切替: 30日 / 90日 / 1年 / 全期間
- Feature: 日別グラフに外れ値圧縮機能を追加
  - 一括取り込み等のスパイクで他の日が潰れる問題を解決
  - P95×1.5 を上限としてバーをクリップし、上に実数を `↑10,234` 形式で表示
  - 最大値が P95×3 を超える場合のみ自動発動。チェックボックスでON/OFF切替可能
- Chore: Chart.js v4.4.7 をローカルバンドル（MV3 CSP対応）

## v1.36.0 (2026-04-29)
- Feature: Export schema v2 を導入
  - `watchedVideos` / `likedVideos` / `likedSyncMeta` / `counts` を含むv2 envelopeへ更新
  - Import側は v1 raw array / v1 envelope (`records` キー) / v2 envelope すべてに対応
  - Export側の `records` alias は廃止（ファイルサイズ約半減・25MB→13MB）。旧v1.35.0以前へのダウングレードが必要な場合は手動で `watchedVideos` を抜き出すこと
- Improve: Auto Backup / Backup Now / 手動Exportを offscreen Blob URL + `chrome.downloads.download` 経路へ統合
  - 大容量JSONをbase64 data URL化せず、23,000件級バックアップのURL膨張を回避
  - ダウンロード完了または中断を `chrome.downloads.onChanged` で検知してからBlob URLをrevoke
  - 失敗理由を `chrome.storage.local.lastBackupError` に保存
- Improve: Popup Settingsで最終バックアップ成功日時・件数・最後の失敗理由を表示
- Fix: Export envelope の `appVersion` が `unknown` になる問題を修正（backgroundから明示的に渡すよう変更）
- Improve: history viewer / popup UI を全面リデザイン
  - ライト基調（オフホワイト + ネイビーアクセント）に変更、`prefers-color-scheme: dark` で自動切替
  - ツールバーを「探す / 並べる・絞る / メンテナンス」の3行構成に再編
  - CSS変数で配色トークン化、絵文字ゼロのモノトーン設計
- Improve: Analyzeクレジットタブの「名義同一」列を「セルフアレンジ曲」に改名
  - 作曲・編曲タブのみ集計対象とし、作詞・未割当タブでは em ダッシュ表示（指標として意味を成さないため）
- Improve: Analyze「Claude推薦プロンプト」をブラッシュアップ
  - 用語注釈追加（Topic / 自編曲率 / クレジット率）
  - 多様性要件（裏方クレジット系最低3名、別ジャンル最低2名）
  - 推薦根拠の4観点を明示（共通作家・楽曲構造・コミュニティ・歌詞テーマ）
  - ハルシネーション対策と確度ラベル、YouTube検索URL生成を要件化
- Note: DB schema は v4 のまま。likedVideos複合キー化とCache LRUは後続PRで対応予定

## v1.35.0 (2026-04-28)
- Feature: IndexedDB owner を YouTube content script から extension offscreen document へ移動
  - `offscreen` permission と `offscreen.html` / `offscreen.js` を追加
  - `GET_STATS` / `EXPORT_DATA` / `IMPORT_DATA` / `MERGE_IMPORT` / `DELETE_VIDEO` / liked 系 / Fix Credits DB 更新を background → offscreen DB RPC に変更
  - content script から `db.js` injection を削除し、`content.js` は `DBClient` 経由でDB操作
- Feature: v1.34.x 以前の youtube.com origin IndexedDB から extension origin DB へ初回移行
  - 更新後、未移行なら最初に開いた YouTube タブで旧DBの watched / liked をexportし、offscreen DBへ取り込み
  - 衝突時は旧DB側レコードを優先し、旧DB自体は削除しない
  - YouTubeタブ未起動時は popup に初回同期案内を表示
- Improve: Popup件数表示、History Viewer、手動Export、Backup Now が YouTube タブ無しでも DB を読める経路へ移行
- Note: DB schema は v4 のまま。DB v6 / Export schema v2 / Blob URL backup / Cache LRU は後続PRで対応予定

## v1.34.4 (2026-04-27)
- Feature: Analyzerクレジットタブに「未割当」ボタンを追加
  - Phase B `·` 区切り解析で取得した `creditsRaw` のうち、役割が確定しなかったレコード（978件相当）を可視化
  - 名前単位で再生数集計・絞り込み検索に対応
  - 一般含めるトグル・名前フィルタ・Topic/Generalフィルタは既存と共通
- Improve: `splitCreditField` が U+00B7 (`·`) も区切り文字として認識するよう変更（従来は U+30FB `・` のみ）

## v1.34.3 (2026-04-27)
- Fix: Fix Credits の取得ペースを下げて bot 判定回避を強化
  - 並列数 3 → 2 に削減
  - 各 worker でフェッチ完了後に 500ms ± 200ms ジッターのウェイトを挟む
  - 実効レート: 約 4 req/秒（従来は無遅延で 3 同時）
  - 7,500件級の一括処理で実セッションが「動画再生不可」になる症状の対策

## v1.34.2 (2026-04-27)
- Fix: Fix Credits の対象選定ロジックで、`creditsRaw` を持つ動画も「処理済」として除外
  - 従来は `composer / lyricist / arranger` のいずれかが空なら対象に含めていたため、Phase B で `·` 区切り異名パターンを `creditsRaw` に保存した動画（978件＋部分的に1,715件）が毎回再処理されていた
  - 再フェッチしても同じ説明文から同じ結果しか得られないため無駄
  - 役割フィールド or `creditsRaw` のいずれかに値があれば対象外に変更

## v1.34.1 (2026-04-27)
- Fix: 過去バージョンで保存された URL/Twitter ハンドル混入レコードを自動クリーンアップ
  - 例: `composer="KARUT (Twitter: https://twitter.com/triplebullets)"` → `KARUT`
  - 約368件相当（全クレジット記録の4.6%）が `twitter.com` `https://...` 等を含んだまま保存されていた
  - 次回 Fix Credits 実行開始時にワンタイムで `cleanCreditLine` を全レコードに再適用
  - `chrome.storage.local` のフラグで二重実行防止
- Improve: `cleanCreditLine` を強化
  - 末尾のダッシュ・中黒（`-` `–` `—` `·`）と空白を除去（URL剥離後の残骸対応、例: `Foo -` → `Foo`）
  - スプレッドシートエラーリテラル `#N/A` `#REF!` および単独 `-` は空文字に変換
  - 日本語長音符「ー」や `K-On!` の中間ハイフン、`[Alexandros]` のような角括弧バンド名は保持
- Improve: Topic `·` 区切り行のフィールド分割で、単独 `-` `–` `—` のフィールドを creditsRaw から除外

## v1.34.0 (2026-04-26)
- Feature: Topicチャンネルの `·` 区切りクレジット行を解析（Phase B）
  - 新フィールド `creditsRaw` を追加。`·` 区切りの全名前を重複排除して保存（役割不明）
  - **同名検出**: `·` 区切り全要素が同一人物の場合のみ composer/lyricist/arranger に同名割当（誤割当ゼロ）
    - 例: `Aiobahn · Aiobahn`, `Yoko Shimomura ×3`, `Endorfin. ×4` → 全役割同人物として確定
  - 異なる名前混在の場合は creditsRaw のみ保存（位置ベース分配は配給会社依存で危険なため見送り）
  - 検証20サンプル中、ROLE割当8件・creditsRaw保存7件・情報なし4件
- Improve: `Author` ラベルを lyricist キーワードに追加（Universal Music系列で使われる作詞表記）
- Improve: 既存DB上で「クレジットなし」と判定済みの動画は v1.34.0 以降の Fix Credits（チェック済スキップOFF）で再走査することで新パーサが適用される

## v1.33.0 (2026-04-26)
- Improve: Fix Credits の解析を行ベース＋複合ラベル対応に刷新
  - `Composer, Writer: 麗`（カンマ複合）→ composer/lyricist 両方に割当
  - `Composer Lyricist: Daichi Yoshioka`（スペース複合）→ 両方に
  - `Recording Arranger:`（接頭辞付き）→ arranger に
  - 同役割で複数行ある場合はカンマ区切りで連結
  - 役割キーワード辞書を拡張（songwriter / writer / music composer / 作曲家 等）
  - 既存ラベル形式（`作曲：` `Composer:` `Music:`）は完全互換
  - **既存DB上で「クレジットなし」と判定済みの動画には適用されない**。再走査するには `creditsCheckedAt` をスキップせず Fix Credits を回す必要あり
  - Topicチャンネルの `·` 区切り型は引き続き未対応（Phase B で `creditsRaw` フィールド追加予定）

## v1.32.0 (2026-04-26)
- Feature: Fix Credits の失敗理由を videoId ごとに永続化（取得率改善のためのデータ収集）
  - 新フィールド `creditsFetchFailReason` / `creditsFetchAttemptedAt` を追加
  - 環境系理由（`no-youtube-tab` / `sorry-redirect` / `proxy-failed`）は動画固有の問題ではないため記録対象外
  - 成功時（`updateCredits` / `markCreditsChecked`）は過去の失敗理由をクリア
  - `creditsCheckedAt` は失敗時にスタンプしないため、次回 Fix Credits で再試行される
  - エクスポート/マージインポートのスキーマも追従
  - 後続バージョンで history.html に内訳分析タブを追加予定

## v1.31.4 (2026-04-26)
- Improve: Codexコードレビューの低リスク改修を反映（critical無し）
  - XSS耐性: Analyzer/Popup/Historyの動的レンダリングを `innerHTML` → DOM API + `textContent` に置換
  - 外部検索リンクに `rel="noopener"` 追加
  - 動画リンク生成で `videoId` を `encodeURIComponent`（URL injection防止）
  - `EXPORT_DATA` がエラー時に空配列でなく `{__error, message}` を返すよう統一（背景・history・popup）
  - `mergeImport` が既存レコードに不足する `firstWatchedAt`・credit系フィールドを補完
  - 高評価再同期時に既存 `likedAt` を上書きしない（並び順維持）
  - 高評価同期前に `videoId` 重複排除
  - README/privacy.html を v1.31.x の機能（IndexedDB/日次バックアップ/Fix Credits/高評価同期/contextMenus権限/認証付き同一オリジン通信）に追従

## v1.31.3 (2026-04-26)
- Fix: 高評価プレイリスト（LL）ページングの本格修正
  - 原因1: 認証ヘッダ不足。LL は private playlist のため `Authorization: SAPISIDHASH` が必須
  - 原因2: `X-YouTube-Client-Version` / `X-Origin` / `X-Goog-AuthUser` ヘッダ不足でinnertube APIに拒否される
  - 原因3: 初期HTMLに continuation token が無く、初回 `browse?browseId=VLLL` POSTで取得する設計が必要
  - 原因4: 2024+ で continuation が `commandExecutorCommand.commands[].continuationCommand.token` にラップされる新形式があり、直接 `.continuationCommand.token` 参照だと取りこぼす（yt-dlp PR #12777）
- 修正:
  - `content.js` に `computeSapisidHash()` 追加（SAPISID Cookie + SHA-1 で `SAPISIDHASH timestamp_hash` ヘッダを生成）
  - `FETCH_INNERTUBE_BROWSE` でAuthorization・X-YouTube-Client-Name/Version・X-Origin・X-Goog-AuthUser を送信
  - `syncLikedPlaylist` で初期HTMLに continuation が無い場合 `browseId: VLLL` で初回POSTを実行
  - continuation抽出を再帰的に行い `commandExecutorCommand` 配下も走査
- 参考: yt-dlp `_tab.py` の `generate_api_headers` / Issue #8732 / Issue #25175

## v1.31.2 (2026-04-26)
- Fix: continuation token抽出のフォールバックを追加
  - 標準パスの `continuationItemRenderer` が見つからない場合、`stringify(ytInitialData)` および raw HTML 全体を正規表現でスキャン
  - 既知の構造変化に追従

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
