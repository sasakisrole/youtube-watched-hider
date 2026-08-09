# yt-watched-hider 積み残し詳細

最終更新: 2026-08-09

PENDING.md 本文から移した経緯・実測値を id 単位で置く。PENDING.md 側には「現在地と次の一手」だけを残す。

---

## id:w7gg — クレジット抽出の誤保存を止める

### 現在地

- **コードは完了**。保存前バリデータ `isValidCreditValue()` が取得・保存・Analyzer の三層で共有され、`main` に取り込み済み（版 v1.43.11）。
- **実機スモークも PASS**（2026-08-05）。残っているのは **ストア提出への収載だけ**。
- **ただしストア公開版は v1.42.8 のまま**（2026-08-09 確認）＝この修正はまだ利用者に届いていない。

### 次回やること

- **N1: 次回のストア提出にこの版を載せる**
  - 提出時に「v1.43.11 単独で出す」か「作業ブランチ `claude/watch-later-scan`（v1.43.12・後で見る整理）を統合して出す」かを決める
  - `dist/` は v1.42.14 のまま古いが `python3 scripts/build_dist.py` で作り直せる。v1.43.x の git tag は未作成
  - アップロード自体はけんとの作業（Chrome ウェブストア デベロッパーダッシュボード）

### 何が問題だったか（起票時・2026-07-14 / 指摘元: Codex外部分析）

概要欄からの作曲・作詞・編曲の抽出が、人名でないものを人名として保存していた。当時の実データ 29,578 件のうち composer=URL 75件 / `Copyright Control` 75件 / 別ラベル混入 46件（重複除外 230件）。`updateCredits()` が空欄のみ補完する作りなので、放置すると自己修復されず固定化する。

対策方針は5点:

1. 保存前バリデータ `isValidCreditValue()` で URL・ドメイン・protocol-relative・@handle・placeholder を拒否
2. 1行に複数ラベルがある形（`作詞：A 作曲・編曲：B`）をトークン分割
3. Topic チャンネルの同名→三役自動投入を削除（インスト曲に架空の作詞者が入るため）
4. 日本語の「- トピック」309件を `isTopicChannelName()` で共通判定化
5. 36ケースを回帰テスト化（既存256件を壊さない）

### 経緯

#### 2026-07-15 実装完了

Codex へ委託 → Opus が独立 VERIFY。331 pass（既存256維持＋新規75）・退行0・`node --check` 7/7。上記5点すべてを実コードで確認。

- レビュー: `codex-reports/ad-hoc/yt-watched-hider-w7gg_2026-07-15.md` / `private-audit/REVIEW_CHECKLIST_w7gg.md`
- ⚪ 別途の改善候補として残置: `analyzer.js:123` の検索クエリが英語 Topic 固定

#### 2026-07-28 「管制塔の独立確認＝完了ではない」

実装は完了だが、残作業はけんとによる実機スモークと次回ストア提出への反映。既存汚染230件の修復は別項目（id:iv0b）。

#### 2026-07-29 Codex read-only 実測

コード上は当初の症状が再現しない（PENDING 本文が stale だった）ことを確認。`credit_target.js:31-94` と `db.js:239-260` が共有バリデータで URL・ドメイン・権利表示・別役割ラベルを保存拒否し、`background.js:1646-1687,1707-1755` が複数ラベルを分割して Topic 同名値は三役へ推定せず raw-only にする。限定検証 75 PASS。

#### 2026-07-30 スモーク手順書を現行ビルドへ更新

`private-audit/SMOKE_CHECKLIST_2026-07-17.md`（Git追跡外）。そのまま実行すると詰まる／誤判定する乖離が9箇所あった。重いものから:

1. Step 4-3 の「再 Export して byte 一致」は**構造上必ず失敗する**（Export は毎回 `exportedAt` が変わる・`db.js:687`）→ `exportedAt` を除外した論理比較へ
2. Step 1「ポップアップ→History」→ 実際は `Open Viewer`（`History` は簡易一覧・`popup.js:347,372`）
3. Step 2「そのまま同期」→ 実際は `Analyze` → `高評価` タブ、コピーは別タブ（`history.html:855,978,1076`）
4. Step 4「Clear 3ボタン」→ 実際は `Settings` → `データ削除` 内（`popup.html:45,117`）
5. Step 0「クレジットを手で消す」→ 現行 UI では自動取得値を消せず、しかもその差分は Step 4-1 で消える＝**作る順番自体が誤り** → Enrich Credits の手動確認で空 role へ追加する方式にし、4-1 完了後に作る

他に定数名（`PROXY_FETCH_TIMEOUT_MS`）・§8.1 の追加・Fix Credits の cleanup 射程・close 判定を更新。`zn5r` は4件に含めず別枠（コード判定＋N3公開が残るため）として1節追加。

- **不変**: Step の順序（0→1→2→3→4）と「Step 0 のバックアップを最初に取る」（4-1 の Clear が破壊的なため）

#### 2026-08-03 誤保存3類型を保存前に遮断

独立調査が本番の `parseCreditsFromDescription()` / `isValidCreditValue()` / `updateCredits()` を直接呼んで実測したところ、**4類型のうち対策済みは URL の1類型だけ**だった。以下がすべて `updated=true` で保存されていた:

- `Composer: Song Title` → `composer="Song Title"`
- `Lyrics: Vocal: Alice` → `lyricist="Vocal: Alice"`
- `Lyrics: Mix: Bob` → `lyricist="Mix: Bob"`
- `Composer: BGM` → `composer="BGM"`

修正内容:

- 未認識の単語ラベル `Xxx:` を値の境界として扱う
- 非人物語 `BGM` を完全一致で拒否（**リストは BGM の1語のみ**・`BGM Records` は許可）
- 動画タイトルと同一の値を NFKC・空白正規化後に拒否（watch HTML のタイトルを parser へ渡し、保存時は `updateCredits()` が再検査）

管制塔検収: `verify_credit_validator` 75→90 passed／近接4本すべて 0 failed。感応性は独立変異2件（`NON_PERSON_CREDIT_VALUES` を空 Set へ→2 failed／タイトル同一性を `if (false)` へ→5 failed）・復元後 90 passed。

当時は独立リポジトリの branch `claude/drain35-yt41`（`9694e8d`）で、push はしていない。

**この時点の残**: ①既存データの一括 cleanup は未着手（現行 cleanup は URL 除去中心＝この3類型を除去しない）②タイトル比較を省略する経路（watch HTML と DB の双方にタイトルが無い場合／`setManualCreditRole()` の手動編集）③branch を yt main へ取り込むか（けんと判断）

#### 2026-08-04 main へ統合・v1.43.11

branch を yt main へ fast-forward 統合（main HEAD=`9694e8d`・push なし）。root で読み込み済みの拡張は `chrome://extensions` の「更新」でリロードすれば反映される。統合後 root でクレジット系テスト4本が再 PASS（validator 90 / target 24 / enrich 31 / manual 41・0 failed）＝上記③はけんと承認で解消。

版上げ v1.43.11 をコミット（`042572a`・manifest＋CHANGELOG＋`whatsnew_data.js` 再生成・`build_whatsnew --check` OK・`verify_whatsnew` 10 PASS）。リロード後ポップアップ表示が v1.43.11 なら新コード確定。スモーク手順書も v1.43.11 準拠へ更新（対象ビルド行＋Step 1 に追加3類型チェック3項目）。

スモーク前の基準値を機械計測（2026-08-04 export `D:\Users\sasaki\Downloads\yt-watched-2026-08-04.json`）: 視聴 31,364 / 高評価 4,884。既存汚染の現在値は URL系 243 / 権利表示 2 / @handle 6 / 60字超 101 / ラベル混在 1（残置の修復は id:iv0b）。

#### 2026-08-05 実機スモーク Step 1 PASS（機械diff判定）

v1.43.11 で Fix Credits 実行 → 前後 export（31,364→31,368件）を videoId×役割単位で全件比較。

- 空欄→補完 47役割スロット（新規4動画分を含む）すべて正常な人名（複数名クレジットの分割を含む）
- 新規汚染 0 / 正常値の消失・書換 0 / レコード削除 0 / 高評価 4,884件 不変
- 既存汚染（URL系243等）は不変＝開始時の限定 cleanup は `creditsCleanupV1Done` フラグ消費済みで再走しない仕様どおり（修復は id:iv0b。iv0b 設計時はワンショットフラグの再走条件も論点に含める）

判定詳細はスモーク手順書 Step 1 に記録済み。

#### 2026-08-09 ストア公開版を一次確認

公開中は **v1.42.8**（ストア表示の最終更新 2026-07-13）。ストアページ埋め込みの manifest を直接読んで確認した。つまりこの修正はまだ公開されていない。

リポジトリ実測: `main`=v1.43.11（バリデータ入り）／作業ブランチ `claude/watch-later-scan`=v1.43.12（後で見る整理・未統合）／`dist/` は v1.42.14 のまま古い／v1.43.x の git tag なし。

けんと判断で、この時点では提出用 ZIP を作らず据え置き（PENDING 上の整理を進めて安定してから提出する方針）。

### 参照

- ストア: <https://chromewebstore.google.com/detail/youtube-watched-hider/bfanjfgoedconkhkkjhfclhimlgiamkh>
- 起票時分析: `projects/youtube-watched-hider/private-audit/ANALYSIS_2026-07-14.md`
- スモーク手順: `projects/youtube-watched-hider/private-audit/SMOKE_CHECKLIST_2026-07-17.md`
- レビュー: `codex-reports/ad-hoc/yt-watched-hider-w7gg_2026-07-15.md` / `projects/youtube-watched-hider/private-audit/REVIEW_CHECKLIST_w7gg.md`
- 既存汚染データの修復は別項目 id:iv0b
- 検出KW: parseCreditsFromDescription / isCleanCreditName / isValidCreditValue / protocol-relative / isTopicChannelName / トピック / Copyright Control

---

## id:3hzu — 高評価の複合キー化（複数アカウント運用時に単独リリース）

### 現在地

DB保存の弱点3点のうち Medium2（clear系を `tx.oncomplete`/`onabort` で resolve 統一・削除直後のレース防止）と Medium3（`parseImportData`/`importData`/`mergeImport`/`importLikedData` の tolerant 化＝壊れ1件を落として残りを復元・除外件数を popup トーストに表示）は **v1.42.3 で実装済み**（`DB_VERSION=5` 据え置き＝移行なし・`node --check` PASS・実機スモーク未／ストア未反映）。

残る Medium1（複数アカウントで同じ動画の高評価が上書きされる）は**未実装**。2026-08-01 の独立実測でも再現した（`db.js:6,42-44,1085-1106`・`DB_VERSION` は5で keyPath と `store.get` が videoId 単独、後続 put が既存行の accountId を更新する）。

### 次回やること

- **N1: 複数アカウントで高評価同期を使うようになったら着手**
  - `DB_VERSION` 5→6 のスキーマ移行: `LIKED_STORE` を read → `deleteObjectStore` → `[accountId, videoId]` 複合 keyPath で再作成 → accountId 欠損は空文字へ寄せて再 put
  - `upsertLiked` を `store.get([accountId, videoId])` に改修。`clearLikedByAccount` は accountId index 流用で不変。`getAllLiked`・`getLikedStats` は不変
  - analyzer は複数アカウント時に同一 videoId を各1件計上＝許容
  - HANDOFF §7.2（2026-07-12）で判明した追加要件: 複合キー化に加え「アカウント別の表示・集計・削除・バックアップ」も要る。短期緩和は「旧アカウントを残して追加」機能を弱めるか、混在リスクを明示する

### 見送りの理由

単一アカウント運用では実益ゼロで、移行に失敗すると全 DB open がブリックする（2026-07-02 けんと判断）。Low3点（category 正規化のDB層・host権限・CHANGELOG位置）も同時に見送り。

### 注意

対象の `projects/youtube-watched-hider/` は**独立Gitリポジトリ＋PUBLIC remote**で、ワークスペースの worktree には実体が入らない。委託するなら対象リポジトリ側で worktree を作る別経路が要り、**push は絶対にしない**（commit まで）。

### 参照

- `codex-reports/ad-hoc/wrapup-review_2026-07-02_5.md`
- `projects/youtube-watched-hider/HANDOFF_2026-07-12.md`（§7.2）

---

## id:2gkw — import 堅牢化ポリッシュ＋公開タスク鮮度化

### 現在地

v1.42.3 の tolerant import をさらに親切にする小改良。2026-07-28 の read-only 調査で、以下3つが残っていることを確認済み。

### 次回やること

次に yt-watched-hider の import 経路または公開作業を触るときに着手する。

- **N1: 壊れた高評価データを黙って落とさない**（Medium1）— 非配列 `likedVideos` / 不正 `likedSyncMeta` が無警告で捨てられる。popup に「liked skipped」warning を出す（throw はしない）
- **N2: 部分成功を見せる**（Medium2）— watched の復元が成功した後に liked の復元が失敗した場合を可視化するか、all-or-nothing にする。現状 watched は liked より先に確定してしまう
- **N3: `isValidRecord` を videoId 必須のみに緩める**（Low4）— 任意フィールドは `normalizeRecord` で coerce し、型不一致だけでレコードごと落ちるのを減らす
- **N4: 公開待ちタスクの版ズレ修正**（Medium3）— 旧 PENDING「youtube-watched-hider v1.41.1反映」を次回版へ更新し、確認観点に clear/import/merge の実機スモークと skipped 表示を追加する

N1 と N3 は同じクラスタなので一括で。N4 は次回公開に着手するとき。

### 参照

- `codex-reports/ad-hoc/wrapup-review_2026-07-02_11.md`（指摘元: Codex 2026-07-02 深掘り）

---

## id:zn5r — 高評価同期: 本物リスト判定を構造で固定

### 現在地

どの配列が本物の高評価リストかを構造で選ぶ件。**コード側は決着済み**。残るのは公開（N3）と実機スモーク。

- v1.42.9 で安全な絞り込みを実装。2026-07-11 の実機スモークで実 LL 応答を現物確認し、**別解Bで決着＝コード改修せず**（本体は汎用 envelope 配下でアンカーが不発火だが strict-max で安全・実応答 fixture 追加で 103 tests green・最難の負け筋は現状 YouTube が生成しない遠い仮説で、保守ガードは偽陽性のため見送り）
- 2026-07-29 の Codex read-only 実測でも、`background.js:2058-2221` が固有レンダラを構造アンカーとし、アンカーなしでは最大配列を選び同点は `primaryUncertain` にすること、`:2224-2258` が primary 外の項目・token を拒否することを確認（限定検証 138 PASS）

### 次回やること

- **N1: N3公開**（v1.42.9 / v1.42.10 の選定強化を次回ストア提出に載せる）
- **N2: 現行 YouTube 実応答の再確認**（未実施）

### 経緯

#### 2026-07-30 ブロッカー発見と解消

独立確認で「スモーク前に片付けるべきブロッカー」が出た: primary 候補が**同数で不明**でも最初の候補を採用して DB へ保存していた。`primaryUncertain` は token と partial 表示にしか効いておらず、DB書込みを止めていなかった。既存テストも flag/token 拒否しか見ておらず**DB無書込みを確認していなかった**。

同日中に解消（commit `ea19aac`・独立リポジトリ・push はしていない）。`primaryUncertain` のページを初回・継続ページ共通のガードで拒否し、推測された `items` を DB 保存対象へ渡さないようにした。`primary-uncertain` は既存 `errors` に記録し、全項目が拒否されて `no-items` になっても `partial: true` を返す（黙って成功にしない）。

検収: 管制塔の独立実行で **155 → 159 passed / 0 failed**（追加4件＝DB書込み0件／不完全報告／certain 経路の通常保存が不変／継続ページの推測項目除外）。近接テストも緑（`verify_backup_roundtrip` 43 / `verify_import_modes` 24）。`dist/` 差分0件。感応性は `if (ext.primaryUncertain)` を `if (false && ...)` に潰す変異で **3件 fail**、復元後 159 passed・変異文字列の残存0件。

### 参照

- `projects/youtube-watched-hider/liked-sync-primary-selection-detail.md`
- 指摘元: Codex 2026-07-10 wrapup-review_8 / 2026-07-11 R

---

## id:l1cm — 高評価同期後の遅延応答が画面とコピー用プロンプトに反映されない

### 現在地

**コード完了**。穴A（meta のみ遅着でも警告を再描画）と穴B（同期後 rows/meta の両応答が揃うまでコピーを無効）を実装済み。2026-08-07 に実関数を手動時計で 3001ms 進める Node 検証で 166 passed / 0 failed。

### 次回やること

- **N1: 実応答を遅延させて両挙動を目視**（実機スモーク）
- push するかは別途けんと判断

### 参照

- スモーク手順: `projects/youtube-watched-hider/private-audit/SMOKE_CHECKLIST_2026-07-17.md`
- 検出KW: loadLiked / onLate / renderLikedPanel / 遅延応答 / コピー用プロンプト

---

## id:wryh — クレジット補完を「不足役割」単位に直す

### 現在地

「作曲だけ埋まって編曲が空」を「編曲だけ不足」と見て次の取得元へ流す件。動画まるごとの判定だと一部埋まった時点で補完対象から外れてしまう（HANDOFF §14 で最優先）。

Path A/B（ロール単位ウォーターフォール＋§3.4軽量）は実装済み・テスト50件・v1.42.14。

**§3.4フルは見送り決定（2026-07-17）**。「DB v5→6移行が要る」という前提が誤りだった（index/objectStore の変更なしで `DB_VERSION=5` 据え置き）。実際に残る穴は MusicBrainz 経路のクールダウンが皆無な点のみ→「MB側へ軽量版を横展開」[M] に差し替えた。

2026-07-28 の read-only 調査で確認: 役割単位 waterfall は全件 PASS するが、MB は `stillMissing` 動画を毎回照会し、再利用は reset で消えるセッション内 Map のみ。

### 次回やること

- **N1: MusicBrainz 経路へ結果別クールダウンを横展開**（`status` / `nextEligibleAt` 等で永続化し、期限内の再照会を抑止する）

### 依存

必須依存は **w7gg AND u1ps**。着手トリガーの DSL は単一IDしか書けないため `after_id("w7gg")` にしてあるが、**w7gg が閉じても u1ps が未クローズなら着手しない**。w2mp は残 §8.1 が未実装で閉じないため依存から外す。

### 参照

- 設計: `projects/youtube-watched-hider/DESIGN_official-search-and-credits_2026-07-12.md`（Part B）
- HANDOFF §3/§4/§5/§14 ・ 判断: `projects/youtube-watched-hider/wryh-s34-decision-2026-07-17.md`
- 検出KW: enrich_credits / isUnassignedCreditRecord / addedForChannel / candidateFromRule / creditsCheckedAt / 不足ロール

---

## id:8www — スモーク手順と MB 横展開設計の穴を塞ぐ

### 現在地

yt 実機スモーク手順と MusicBrainz 軽量横展開の設計に、まだ偽 PASS や取りこぼしを生む穴が残っている（指摘元: Codex 2026-07-17 wrapup-review）。2026-07-28 の read-only 調査で、通常操作だけで PASS できてしまうこと・通信失敗が非 stamp の即時再試行になっていること・`mbCheckedAt` 単一案・固定331件ゲート・初回大量処理の上限/再開契約なし、を確認済み。

### 次回やること（wryh 着手後）

- **N1（M5）**: l1cm の3秒超遅延を実際に再現する手段を決める（遅延注入／DevTools 応答停止／テスト用フック）。今の手順は修正前の実装でも PASS しうる
- **N2（M6）**: Step3 は日常導線の確認に限定と明記し、障害注入（DBエラー三値／負キャッシュ／fetch タイムアウト）は自動テスト結果を完了証拠に紐づける
- **N3（M7）**: クレジット汚染確認を実行前後の差分で新規保存分だけに限定し、正常系は役割が空で期待値が既知の2〜3件を事前選定する（今は既存汚染で偽FAIL／偽陰性が起きる）
- **N4（M8）**: 「通信エラー非 stamp は要件を上回る」という評価は誤りなので訂正し、結果種別で分ける（成功なし90日／通信エラーは短い指数バックオフ／明示再試行でバックオフ解除）。即時再試行は上位互換ではなく別のトレードオフ
- **N5（M9）**: `mbCheckedAt` 単一時刻では not-found の定義（結果ゼロ／不一致／必要役割なし／通信失敗）と検索条件の変更・不足役割を表現できない。別解C（`source`/`status`/`checkedAt`/`nextEligibleAt`/`queryFingerprint`/`missingRoles` の軽量オブジェクト・DB構造変更なし）が本命
- **N6（M10）**: 初回横展開の問い合わせ量・1回上限・レート制御・中断再開・進捗表示を受入条件に追加（既存レコードは時刻欠落で一斉対象＝数千規模）
- **N7（L11）**: 回帰ゲートの固定件数（331 vs 394）を「現行全テスト PASS＋件数は実施結果欄に記録」へ
- **N8（L12）**: 将来の DB 更新へ本件を束ねる記述の曖昧さを解消

### 参照

- disposition: `codex-reports/ad-hoc/wrapup-review_2026-07-17_disposition.md`
- 判断: `projects/youtube-watched-hider/wryh-s34-decision-2026-07-17.md`
- 検出KW: mbCheckedAt / nextEligibleAt / queryFingerprint / 遅延注入 / 障害注入 / not-found定義

---

## id:qdo5 — YouTube 検索に「公式優先フィルター」を段階導入

### 現在地（2026-08-05）

YouTube 検索で公式・本人 Topic を見やすくする機能（公式のみ／発掘／全表示の3モード・ホワイトリスト方式）。**コード完了**。

2026-08-05 に `claude/drain35-qdo5`（PR6＝明示操作による未知動画クレジット調査）を yt ローカル main へ統合（`042572ac`→`7977adc`・**push なし**）。統合時の `background.js` 競合1件は管制塔が解決し、既存検証済みの `drain35-combined-check` とバイト一致した。

独立反証: PR6 は可視ボタンからのみ開始・最大20件・中止可・7日キャッシュ・`persistToHistory:false` を background 側でも強制。3モードの中核は PR6 前後で同一。**ロードマップは PR1〜PR6 で、PR7 以降の未実装段階は無い**。

### 次回やること

- **N1: 実機スモークのみ**（実 YouTube 検索 DOM・SPA 遷移・無限スクロール・キャンセル／異常停止）
- push するかは別途けんと判断

### 参照

- 設計: `projects/youtube-watched-hider/DESIGN_official-search-and-credits_2026-07-12.md`（Part A/PR分割）
- HANDOFF §10/§11
- 検出KW: official_search_filter / 公式優先 / 検索フィルター / classifyChannel / discovery mode

---

## id:u1ps — バックアップ整合性を直す（形式統一・Import/Clear の意味明確化）

### 現在地

「復元後にアカウント誤同期防止が効かなくなる／Import が実は追加上書き／Clear All が全消しでない」を直す件。**コードは全て実装済み**。残るのは実機スモークのみ。

### 次回やること

- **N1: 実機スモーク**（Export／Import 各モード／Clear 3種／データ整合をけんとが手動確認）
  - ⚠️ `id:zn5r` の修正完了を待ってから実施する
- Round C（w2mp §8.1 同期アカウント固定）は設計どおり別スコープ

### 設計（2026-07-12 確定）

- §7.1 = リーダー整合＋往復テスト（schemaV3 の全書換はせず。preflight で `sanitizeLikedSyncMeta` が既にフラット↔accounts-map をブリッジ済みと判明）
- §7.3 = **明示3択（置換／安全統合／backup優先統合）＋事前差分**（ユーザー承認）
- §7.4 = Clear 分割＋auto-backup
- 高リスク（データ安全・複数ファイル横断・破壊的置換）のため Codex 独立 VERIFY 必須。実装シーケンスは B1（非破壊）→B2（破壊的）→C（§8.1）

B1（§7.1 フラット往復／§7.4 Clear 3分割／2gkw）＋B2（§7.3 Import 明示3択＋事前差分＋置換前 auto-backup）を実装し、Codex 独立 VERIFY 通過（B1: 4R / B2: 2R）・全394テスト pass（2026-07-15）。

### 経緯

#### 2026-07-30 ブロッカー発見と解消

独立確認で「残りは実機スモークだけ」が**反証された**。識別情報のないバックアップから高評価を復元すると、3つの Import モードすべてで同期メタが null のままになり得て、その後の同期が保存済みデータの持ち主確認を素通りしていた。WIP ブランチ `wip/stored-owner-guard`(`d2d023c`) は穴を認識した成果だが**置換モードしか直しておらず確認文言も未完成・テスト追加なし＝そのまま取り込み不可**だった。

同日中に解消（commit `bb21668`・独立リポジトリ・push はしていない）。3つの Import モードすべてで meta なし高評価の復元時に `ownerUnverified` を保存し、marker のない既存の `meta=null + liked あり` も読み取り専用の件数確認で検知するようにした。確認は既存のアカウント変更確認フローに乗せ、判断できる日本語警告を出す。`accountId` 一致時は追加確認なしで従来どおり同期（**正常系は不変**）。

検収: 管制塔の独立実行で **147 → 155 passed / 0 failed**（必須ケースを含む8件追加）。近接テストも緑（`verify_backup_roundtrip` 43 / `verify_import_modes` 24）。感応性は `storedLikedCount` ガードを無効化する変異で **6件 fail**、復元後 155 passed・残留差分なし。

WIP `wip/stored-owner-guard`(`d2d023c`) は**取り込んでいない**。本実装で置き換わったので破棄してよい。

### 参照

- 設計: `projects/youtube-watched-hider/u1ps-backup-import-design-2026-07-12.md` ・ HANDOFF §7
- スモーク手順: `projects/youtube-watched-hider/private-audit/SMOKE_CHECKLIST_2026-07-17.md`
- 検出KW: likedSyncMeta / sanitizeLikedSyncMetaForExport / Import JSON / Clear All Data / バックアップ整合

---

## id:w2mp — 同期・DOM まわりを堅牢化する（誤登録・誤判定を潰す）

### 現在地

同期中に別タブ／別アカウントを使う・fetch が固まる・DBエラーを未視聴と誤変換・動画切替時の誤登録、を防ぐ件。**コードは全て実装済み・main 統合済み**。残るのは実機スモークのみ。

### 次回やること

- **N1: 実機スモーク**（複数アカウント切替・タブ閉鎖・SPA遷移）
  - 解禁条件は揃っている（`u1ps` `zn5r` のコード修正済み＋手順書が現行ビルド準拠）

### 経緯

#### 2026-07-12 §8.2〜8.5 実装

`content.js`: videoId 束縛／履歴の状態機械化（EXHAUSTED・K=4 有界 prune）／DBエラー三値化（`cacheMode=error` 含む）／fetch AbortController 25s。implementer→reviewer の独立 VERIFY で実害🔴 cache-error バイパスを捕捉して修正・236テスト緑。

#### 2026-07-28 §8.1 同期アカウント固定 実装

高評価同期を開始時の `syncSessionId`/`tabId`/`authUser`/accountKey へ固定し、全 fetch で使い回す。固定タブが失敗・消失しても別タブへフォールバックせず中止。DB書込み直前にセッション一致を再検査し、不一致なら書込みをスキップ。`X-Goog-AuthUser` の `'0'` 固定を廃止。

テスト **257 passed / 0 failed**（liked_sync_robustness 146・backup_roundtrip 43・import_modes 13・watched_tristate 48・reset_snapshot 7）。ただし管制塔の独立変異で、途中 fetch の `authUser` 不一致ガードが**無試験**だと判明（当該条件を `false` に潰しても 146 green のまま）。

#### 2026-07-29 無試験だった穴を解消

`background.js:2494` の中間 HTML authUser 照合に対し、開始・終了コンテキストは同一で **fetch 応答だけ別 authUser** にするケースを追加し、browse 未実行・終了時ガード未到達・DB書込み0 を検証。感応性: 正常 **147 passed** ／ ガードを `if (false)` に変異 **146 passed + 1 failed** ／ 復元後 147 passed。本体は無変更。

#### 2026-07-30 branch 取り込み＝完了（「判断待ち」は stale だった）

取り込みを実行しようとしたところ、**既に main へマージ済み・origin/main へ公開済み**だった。`claude/w2mp-sync-fix`(`59faabd`) と `claude/w2mp-authuser-test`(`8ed1d82`) はどちらも main(`ac8eac7`) の祖先で、マージコミット `386149c` が存在する。`main...origin/main` は 0/0＝差分なし。main 上で `tests/verify_liked_sync_robustness.js` を実行し **147 passed / 0 failed**。

#### 2026-07-30 スモーク手順書を現行ビルドへ更新

内容は id:w7gg の同日エントリと同じ（乖離9箇所の修正）。

### 参照

- HANDOFF §8 ・ スモーク手順: `projects/youtube-watched-hider/private-audit/SMOKE_CHECKLIST_2026-07-17.md`
- 検出KW: X-Goog-AuthUser / AbortController / lookupWatchedForIds / attachVideoEndedListener / 負のキャッシュ / historyScraped

---

## id:zj91 — ポップアップ/履歴/クレジット確認センターの UI 刷新（大型）

### 現在地

🔴 **2026-08-03 けんと決定＝保留**。「これこそ腰を据えて取り組みたいので、他の PENDING をさっさと消化してから取り組む」。大型として据え置き、他項目の消化を優先する（`id:y42p` も同枠）。

2026-07-28 の read-only 調査で範囲が縮小している: 全面新規ではなく、Settings 折り畳み・履歴検索/No Channel・自動候補/役割単位の手動確認は**既に実装済み**。残る差分は**メンテ折り畳み・共通ジョブ画面・永続的な状態別レビュー導線**の3つ。

### 次回やること（着手を決めたとき）

- **N1: popup を日常操作＋「設定・データ管理」折り畳みに分ける**
- **N2: 履歴画面に絞り込みとメンテ折り畳みを入れる**
- **N3: 長時間処理の共通ジョブ画面を作る**
- **N4: クレジット確認センター**（自動確定候補／要確認／競合／未解決／検証済を役割単位で採用）

### 依存

「クレジット補完を不足役割単位に」（id:wryh）の着手後が望ましい。役割単位で採用/要確認/競合を捌く画面なので、ロール単位クレジットが土台になる。

### 参照

- HANDOFF §9
- 検出KW: クレジット確認センター / 共通ジョブ / popup刷新 / 履歴画面

---

## id:yw2g — 配布版の再現性を固める（root/dist/ZIP 不一致・privacy 文書ずれ）

### 現在地

同じ版表記なのに root / dist / 配布ZIP が一致せず、clean tag も無い。他者へ配布中なので配布事故・審査リスクがある。

2026-07-28 の read-only 比較の結果: tree は clean だが HEAD は untagged で13コミット先行・root 対 dist/ZIP は12件不一致かつ公式検索3資産が欠落・dist/ZIP に uta-net 通信が残る・公開用 privacy/Store 文書は MusicBrainz 未開示。

**③（通信先4者整合）は 2026-07-15 に完了**（`history.html` の uta-net 削除＋`docs/privacy.html` に MusicBrainz 通信を日英で開示＝manifest／実装／UI／privacy が YouTube+MusicBrainz で一致）。

### 次回やること（次回ストア提出を実際に切るリリース準備 round で）

- **N1: clean commit / tag を作成し manifest 版と一致させる**
- **N2: dist を削除→再生成し、root / dist / ZIP を byte 一致させる**（SHA照合）
- **N3: リリースゲートを手順化**（tree clean／全テスト／hash 記録）

今 tag や再ビルドをすると未検証コードを配布物に固定してしまうため延期している。バージョンを確定してから実施する。

### 参照

- `projects/youtube-watched-hider/private-audit/ANALYSIS_2026-07-14.md`（指摘元: Codex外部分析 2026-07-14）
- 検出KW: dist / 配布ZIP / SHA-256 / privacy / git describe / リリースゲート

---

## id:9ni6 — クレジット候補生成前に対象件数と所要時間を確認できるようにする

### 現在地

Enrich Credits の「候補生成」を押すと確認なしで数百〜数千件の外部通信が始まり、数十分かかりうる問題。**①〜⑤すべてコード完了**。残るのは実機での目視確認のみ。

### 次回やること

- **N1: 実ブラウザで目視確認**

### 経緯

#### 起票時の根拠（2026-07-21 コード確認）

対象判定 `needsCreditEnrichment`（`enrich_credits.js:49-54`）に件数上限も再取得抑制もなく、1曲あたり最大6リクエスト・1秒間隔の直列化（`background.js:539`）＝500件で20〜50分規模。候補生成前の確認ダイアログは無い（書き戻し前のみ `:755`）。中止は候補生成のみ可で、書き戻しは中止不可。

#### 2026-07-23 ①③⑤ 実装（commit `c8b62e0`）

`getEnrichmentPreCount` で対象動画数・チャンネル数を集計し、「候補生成の確認」ダイアログで開始/キャンセルを提示。書き戻しは別 confirm。

#### 2026-07-29 ④件数上限＋②所要時間の初版（branch `claude/9ni6-enrich-limit` `bdca940`・push なし）

確認ダイアログに推定所要時間を表示し、処理件数の上限（全件／上位N件）を選べるようにした（生成ループがN件で停止）。`verify_manual_credits_ui.js` **61 passed**（58→61）／`verify_liked_sync_robustness.js` 138 passed。感応性: 上限適用行を `allGroups` へ差し替えると B-2 のみ FAIL、復元後 61/61。

#### 2026-07-30 独立確認で②が不十分と判明 → 修正（commit `0ee2017`・push なし）

見積り式が「動画数 × rateLimitMs」＝**1動画=1通信**を前提にしていたが、実処理は strict 検索・fallback 検索・recording 取得・work 取得（最大3件）で**最大6通信**＝**最大で約6倍の過小表示**だった。通信量そのものも表示していなかった。

1動画あたりの通信数を**最小1・最大6**として定数化し、所要時間を `{ minMinutes, maxMinutes }` の**幅**で算出。表示を `処理予定 N件、推定所要時間 約X〜Y分（最大 約Z 回の通信）` へ変更（`enrich_credits.js:103-104`）。**実処理の通信回数・順序・rateLimit は無変更**。

例: 100件・`rateLimitMs=1000` → 約2分 → **約2〜10分・最大 約600回の通信**。

検収: `verify_enrich_credits_roles` **31 passed**／`verify_manual_credits_ui` **61 passed**／`verify_liked_sync_robustness` **164 passed**。追加テスト5件（通信数の上下限固定・最小/最大ケース・0件・件数上限が両端へ効くこと）。`dist/`・`manifest.json`・`background.js` は無変更。

### 参照

- 調査記録: `projects/youtube-watched-hider/INVESTIGATION_credits_ui_2026-07-21.md`
- 夜間証拠: `codex-reports/ad-hoc/evidence_9ni6_2026-07-26.md`
- 検出KW: enrichGenerate / needsCreditEnrichment / ENRICH_RATE_LIMIT_MS / 候補生成 / 対象件数

---

## id:iv0b — 既存クレジットデータの汚染を修復する（データ変換・要独立VERIFY）

### 現在地

w7gg のバリデータ実装後も、**既に保存済みの汚染値は残る**。`updateCredits()` は空欄のみ補完するため、手動で修復しないと永久に固定される。

起票時（2026-07-14）の異常候補は composer URL 76件／別ラベル混入46件／Instrumental 三役同一33件＝重複除外230件。**2026-08-04 の実測値**では URL系243／権利表示2／@handle 6／60字超101／ラベル混在1（`D:\Users\sasaki\Downloads\yt-watched-2026-08-04.json`・視聴31,364件）。件数は変動するので着手時に測り直す。

2026-07-28 の調査で、リポジトリに一括修復の実装も付属 `credit_data_anomalies.csv` も**存在しない**ことを確認済み（CSV はサンドボックス側＝再取得が要る）。

### 次回やること（w7gg のクローズ後）

- **N1: 最新 JSON を別名保存 → 新バリデータで dry-run → 分類 → 修復**
  - 自動隔離群（URL／別ラベル）と要レビュー群（三役同一／Remix arranger）を分離する
  - 元値・除外理由・修復日時をログに残す
  - 空欄化して再取得対象へ復帰させる
  - ⚠️ データ変換なので dry-run＋件数照合＋バックアップ＋独立VERIFY を必須にする
- **N2: ワンショットフラグの再走条件も論点に含める**
  - 2026-08-05 のスモークで確認: 開始時の限定 cleanup は `creditsCleanupV1Done` フラグを消費済みで再走しない仕様。既存汚染はこの経路では直らない

### 参照

- `projects/youtube-watched-hider/private-audit/ANALYSIS_2026-07-14.md`（指摘元: Codex外部分析 2026-07-14）
- 検出KW: credit_data_anomalies / updateCredits / hasMissingCreditRole / データ修復 / 汚染

---

## id:2k2h — 作業リポジトリの版ずれを整理する（性質が「公開判断」へ変わった）

### 現在地（2026-08-03 独立実測・基点 `76aba35b`）

起票時の本文は**数字が全部 stale** だった。実測での訂正:

| 起票時の記述 | 実際 |
|---|---|
| v1.42.2 と 1.42.14 で12版ずれ | root 1.43.10 / dist・配布物 1.42.14 / 最新tag v1.42.2 の**三者不一致** |
| 未コミット15件＋多数の未追跡 | **追跡変更0件・未追跡0件**＝作業ツリーの整理は完了済み |
| 未取り込み branch 2本 | **6本**（重複を除く独立作業セットは5組） |

未コミット差分が解消したのは `recovery/youtube-v1.42.14-uncommitted` が main へ取り込まれたため。GitHub は **public・remote branch は main のみ・先端 `ac8eac7`** を接続データで確認した。

∴ 残っているのは**版の三者不一致の解消**と**branch の統合可否判断**で、「整理」から**「公開判断」へ性質が変わった**。

### 次回やること（順序）

- **N1🔴: 人が決める** — 正本を 1.43.10 とするか 1.42.14 を維持するか／先行コミットを公開対象にするか
- **N2**: remote 情報を更新して競合を再確認
- **N3**: 正本から dist と配布ZIP を再生成して4者の版を揃える
- **N4**: 限定検証後に commit と tag
- **N5🔴**: **PUBLIC remote への push は人が承認・実行**（管制塔は commit までしかしない）

### 公開リスクの実測（2026-08-01）

push すると公開されるのは 12ファイル・+668/-40（`background.js` +114/-17 ／ テスト5本 ／ `CHANGELOG.md` ／ `manifest.json` ／ `whatsnew_data.js` ／ `db.js` ／ `enrich_credits.js` ／ `official_search_filter_core.js`）。

**該当なし**: 高確度のAPIキー・token・秘密鍵形式 0件／認証情報代入形式 0件／メールアドレス形式 0件／電話番号形式 0件。`private-audit/`（14ファイル・`.gitignore` 自身が「実データ・PIIを含む」と明記）・`credits-enrich/`・`recommend_output/`・`.claude/state/`・`store-assets/`・`dist/`・各種ZIP は `git ls-files` 0件＝**追跡外で通常の commit には入らない**（`git add -f` で強制追加しない限り）。

⚠️ `git fetch` を禁止して調査したため、GitHub 上の現在の `origin/main` との差は未確定（ローカル追跡 ref は reflog 上 2026-07-30 01:49 JST の push で更新）。
⚠️ `v1.26.1.zip` は拡張子が zip だが**実体は tar**。

### 未取り込み branch

- `claude/drain24-7jos`（`d4accf9`・固有commit 1件＝`id:7jos` の 2026-07-30 追加実装2点）
- `wip/stored-owner-guard`（`d2d023c`・固有1件＝未完成の u1ps ガード。id:u1ps の本実装で置き換わったので破棄してよい）

### 参照

- 経緯: `projects/codex-claude-split/poc-vcdz-2026-07-20.md`
- 調査ログ: `codex-reports/launch/codex_out_drain27-2k2h.log`
- 検出KW: 入れ子リポジトリ / 版ずれ / 未コミット差分 / youtube-watched-hider リポジトリ整理
