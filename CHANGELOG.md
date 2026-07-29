# Changelog

## v1.43.8 (2026-07-30)
**公式プロファイル候補が「登録済み」を持たない問題をまとめて解消**（実利用フィードバック）。候補一覧が状態を一切持たず、登録しても残り続け、しかも二重登録を止める仕組みが無かった。
- **二重登録の防止（実害）**: `mutateConfirmedRegistration` が毎回 `createProfile` を呼んでいたため、同じ候補を2回登録すると**プロフィールが2つ**できていた（id に `-2` が付く）。既に同じチャンネルが登録されていれば `already-registered` を返して**新しいプロフィールを作らない**ようにした。UI もその旨を出す。
- **登録済みを一覧から外す**: 登録時に候補の出どころ（Analyze の集計チャンネル名）を `sourceChannelName` として保存し、それを主キーに登録済み判定する。プロフィール名を編集して保存しても紐づく。v1.43.7 以前の登録データには無いので、チャンネル表示名・プロフィール表示名でフォールバック照合する。
- **手動で候補から外せるようにした**: 各行に「候補から外す」を追加（複数アーティストが混ざるチャンネルなど）。除外は設定に永続化し、一覧下部に「非表示: 登録済み N件 / 除外 M件（名前）」と**「除外をすべて戻す」**を出す＝誤操作を戻せる。
- **登録・除外の直後に一覧を描き直す**（従来は再読込するまで反映されなかった）。空状態も「候補が無い」ではなく「登録済み N件・除外 M件は非表示」と理由を出す。
- Test: `tests/verify_analyze_official_profiles.js` 21→34。二重登録の拒否・改名しての再登録も拒否・出どころ保存・旧データのフォールバック照合・除外の冪等性と復元・sanitizer 通過・仕分け・除外ボタンの結線・空状態の文言を固定。感応性＝二重登録ガードと `sourceChannelName` を潰すと2件 FAIL・復元後 sha256 一致。全20ハーネス 0 failed。
- ⚠️ 実機スモーク未実施（拡張の再読込が必要）。**確認観点**: ①登録した候補がその場で一覧から消える ②同じチャンネルをもう一度登録しようとすると「登録済みです」と出てプロフィールが増えない ③「候補から外す」で消え、「除外をすべて戻す」で戻る。

## v1.43.7 (2026-07-30)
**「公式プロファイル候補」を専用タブへ分離**（実利用フィードバック＝アーティストタブに常駐していてノイズになる）。
- Analyze 画面のタブに「公式プロファイル」を追加し、候補一覧・確認・登録フォームを `azOfficialPanel` へ移設。アーティストタブは集計テーブルだけに戻した。
- 候補の生成ロジック・登録の確認ゲート・保存内容は**一切変更なし**（表示位置のみ）。
- Test: `tests/verify_analyze_official_profiles.js` 17→21。タブ→パネルの**配線ドリフト検出**を追加（全 `data-aztab` がマップに存在する／全マップ値の id が history.html に実在する／セクションがアーティストタブ側に残っていない／確認UI一式が同じパネル内にある）。感応性＝マップから `official` を外すと2件 FAIL・復元後 sha256 一致。
- ⚠️ 実機スモーク未実施（拡張の再読込が必要）。**確認観点**: ①「公式プロファイル」タブをクリックすると候補一覧が出る ②アーティストタブに候補欄が出ない ③他タブの表示が従来どおり。

## v1.43.6 (2026-07-30)
**「候補チャンネルを開く」がトップページに飛ぶ不具合を修正**（実利用フィードバック / v1.43.5 の 7jos）。候補の多くを占める Topic チャンネルはハンドルを持たないため oEmbed が `/channel/UC...` を返すが、その path を**比較用の正規化関数（小文字化する）**に通してから URL を組み立てていた。YouTube のチャンネルIDは case-sensitive で、小文字化した `/channel/uc...` は **404**（実測）。ハンドル `/@Name` は case-insensitive のため一部だけ動いて見えていた。
- **併発していた実害（同根・こちらの方が重い）**: 保存する `channelId` も同じ小文字 path から切り出していたため、検索結果側が返す実ID（`UC...`・字面保持）と exact 比較で一致せず、**Analyze から登録した公式チャンネルが公式優先フィルターで機能していなかった**。
- Fix: `official_search_filter_core.js` に**字面を保つ** `canonicalChannelPath()` を追加し、`normalizeChannelPath()` はその小文字版として再定義（比較の意味論は不変）。`analyze_official_profiles.channelFromInput()` が遷移URL・保存IDの両方を字面保持側から作るようにした。
- ⚠️ **v1.43.5 で登録済みの公式プロファイルは、チャンネルIDが小文字で保存されている**ため登録し直しが必要（自動移行は入れていない）。
- Test: `tests/verify_analyze_official_profiles.js` 12→17。ID path・ハンドル・保存IDの字面保持、比較正規化が従来どおり畳むこと、字面保持IDで `isSameChannel` が一致することを固定。感応性＝修正を戻すと新規3件が FAIL・復元後 sha256 一致。全20ハーネス 0 failed。

## v1.43.5 (2026-07-29)
**Analyze画面から公式プロファイルを半自動登録できるようにする**（PENDING id:7jos）。公式優先フィルターの初期設定は channelId を手で探して登録する必要があり、コストが高かった。Analyze（分析）画面は既にアーティスト・クレジット・チャンネルを集計しているので、そこから候補を出して確認1回で登録できるようにした。
- `official_profile_store.js` を新設し profile/channel の保存経路を共有化（content script へ追加・**新規権限なし**）。
- Analyze の集計から公式/Topic候補を提示し、**ユーザー確認後に** profile＋channel を保存する。
- 名前一致だけで公式確定はしない原則を維持（未確認時は storage の read/write ゼロ）。
- Test: `tests/verify_analyze_official_profiles.js` 12件。感応性＝confirmed ゲート2箇所を潰すと 3 failed・復元後 12/12。
- ⚠️ 実機スモーク未実施。

## v1.43.4 (2026-07-29)
**クレジット候補生成の事前確認に推定所要時間と件数上限を追加**（PENDING id:9ni6）。v1.42.15 で件数の事前提示は入ったが、「何分かかるか」と「何件で止めるか」は選べなかった。
- 確認ダイアログに、対象件数と `background.js` の実レート制御値から算出した**推定所要時間**を表示。
- 処理件数の上限（全件 / 上位N件）を選べるようにし、生成ループがN件で停止する。
- Test: `tests/verify_manual_credits_ui.js` に3ケース追加（58→61 passed）。感応性＝上限適用行を差し替えると当該1件のみ FAIL・復元後 61/61。
- ⚠️ 実機スモーク未実施。

## v1.43.3 (2026-07-28)
**公式チャンネル候補をクレジットDBから推測して提示する**（PENDING id:7kyr）。公式チャンネル登録が「channelId を自分で探す」手作業でしかできなかったのを減らす。
- 検索結果の videoId 群からクレジットを **DBへ一括取得**（1件ずつ問い合わせない）。
- `creditAliases` を NFKC 正規化して突き合わせ、公式/関連チャンネル候補を生成。
- 候補は**提示のみ**。`userAccepted=true` の明示採用時だけ登録する（名前一致・部分クエリ一致だけでは自動確定しない）。
- `CATEGORY.CREDIT_RELATED` / `hasRelatedCredit` を実配線（従来は false 固定の scaffold）。
- Test: 新規 `tests/verify_official_search_filter_credits.js` 13件・既存全19本 0 failed。感応性＝10変異＋独立変異1件（明示採用チェックを潰すと2件 FAIL・復元後 SHA 一致）。
- ⚠️ 実機スモーク（実YouTube検索DOM・実DB/offscreen lifecycle・SPA遷移）未実施。

## v1.43.2 (2026-07-28)
**高評価同期を開始時のタブ・認証アカウントへ固定する**（HANDOFF §8.1 / PENDING id:w2mp）。同期中に別タブ・別アカウントへ切り替えると、別アカウントの結果を取り込みうる穴があった。
- 同期開始時に syncSessionId / tabId / authUser を固定し、終了時に一致を確認する。
- 途中の fetch 応答が別 authUser だった場合のガードを配線。
- Test: `tests/verify_liked_sync_robustness.js` を 138→147 passed へ。中間HTMLの authUser 照合は**既存テストで無試験だった**（条件を false に潰しても 146 green のまま）ため、開始・終了は同一で fetch 応答だけ別 authUser のケースを追加し、browse未実行・終了時ガード未到達・DB書込み0 を検証。感応性＝正常147 / 変異146+1 failed / 復元147。

## v1.43.1 (2026-07-25)
**不正な likedSyncMeta の import 警告を配線**（PENDING id:2gkw ①）。バックアップ import 時、`likedSyncMeta`（高評価の同期アカウント情報）が存在するのに非plain-object（string/number/boolean/array）だと、従来は**無警告で null 化**され利用者が気づけなかった。既存の `likedStructural`（非配列 likedVideos）と対称に可視化する。**捨てる挙動は不変**（throwしない・meta は従来どおり null 化）＝診断フラグと警告表示の追加のみ。
- `db.js`: `parseImportData` に `likedMetaStructuralError`（present かつ非plain-object限定＝空object・identity欠落の正当metaは誤警告しない）／`diffImport.invalid` へ伝播。
- `offscreen.js`: importPayload・replaceApply 両経路の dropped へ配線。
- `popup.js`: プレビュー / import結果 / sync結果 の3経路に警告表示（droppedNote 配列化で複数理由を併記）。
- Test: `tests/verify_import_modes.js` 13→24。旧コードでは `likedMetaStructuralError=undefined` ＝新テスト FAIL（退行検出力あり）。
- 安全: DB書込 / データ削除 / 外部通信 / manifest権限 / DBスキーマ 変更なし。

## v1.43.0 (2026-07-23)
**YouTube検索に「公式優先フィルター」を導入**（PENDING id:qdo5 / PR1〜PR4＋後続2件）。検索結果でアーティストの公式・本人Topicチャンネルを見やすくする新サブシステム。転載の自動判定はせず、**登録チャンネルのホワイトリスト方式**。
- PR1: 純粋関数 core＋専用テスト（未配線）。
- PR2: 仮UI＋検索結果ページへの安全配線。
- PR3a/3b/3c: 設定保存基盤（`chrome.storage.local`・mode永続化）／プロフィール・投稿元管理／queryBinding・プロフィール別 mode。
- PR4: 発掘モード＋3つのUI契約（公式のみ / 発掘 / すべて表示）。
- 追加: 登録不要のグローバル「その他を隠す」トグル（設定ゼロで使える）／パネルを**既定折りたたみ**の非侵襲UIへ（実利用フィードバック＝常時パネルが YouTube の結果とUIを塞ぐ、への対応）。
- 安全条件: `.ywh-osf-hidden` 限定・`style.display` / watched dataset / 並び順 / 件数に触れない・manifest権限・外部通信の変更なし。
- Test: 全18ハーネス 727 passed / 0 failed。
- ⚠️ 実機スモーク未実施。

## v1.42.15 (2026-07-23)
**クレジットの手動確認とロール別 provenance（サブバッチ1 A/B/C）**。
- A: role別 provenance と manual credit 書込みのデータ層。
- B: 不足クレジットの手動確認UI（MusicBrainz を呼ばない独立view）。
- C: Enrich候補生成の **fetch前ゲート**。対象動画数と対象チャンネル数（distinct）を提示して開始/キャンセルを選べるようにした。キャンセルは fetch・`enrichCreditsMb`・DB書込みを一切出さず状態不変（副作用0）。書き戻し前の既存 confirm は別境界として維持。
- Test: `tests/verify_manual_credits_ui.js` に7チェック追加（独立VERIFYで mutation survival 0/5）。全スイート 535 passed / 0 failed。
- 外部通信先・host_permission の追加なし。

> ⚠️ v1.42.15〜v1.43.5 は、実装時にバージョンを上げそびれたぶんを **2026-07-30 に遡って機能単位で採番**したもの（コードは各コミット時点のまま）。以後は機能ごとにその場で `manifest.json` を上げ、本ファイルへ追記する。

## v1.42.14 (2026-07-12)
**概要欄クレジット補完（Path A）を「動画まるごと」から「不足ロール単位」判定へ**（HANDOFF §3.1 + §3.4 軽量版 / PENDING id:wryh・Path B に続く残り）。「クレジット補完（概要欄）」ボタンの対象選定 `runFixCredits` の targets フィルタが `!(composer || lyricist || arranger || creditsRaw)` ＝**作曲・作詞・編曲のどれか1つでも埋まっていれば永久に除外**していたため、「作曲だけ埋まって編曲が空」の部分クレジット動画が二度と概要欄を再スキャンされなかった（取りこぼし・HANDOFF §14 最優先）。Path B（enrich_credits.js の MusicBrainz/uta-net ウォーターフォール）は v1.42.13 までで role-unit 化済みだが、概要欄バッチ（Path A）は whole-video 判定のまま残っていた。
- **Fix(§3.1・ロール単位判定)**: 対象選定を新モジュール `credit_target.js` の `isFixCreditsTarget()` に集約。composer/lyricist/arranger の**どれかが空なら対象**に含める（既存値は上書きしない＝background の `UPDATE_CREDITS` が `!existing[k]` で空欄のみ埋める挙動は不変）。判定を enrich_credits.js から独立させ Path A を自己完結に保つ（Path B は据え置き・単一ソース原則）。
- **Fix(§3.4 軽量・再取得クールダウン)**: 概要欄は**単一ソース**なので、内容が変わらない動画を即再取得しても同じ結果しか返らず、無制限に再fetchすると YouTube の bot チャレンジを踏む。取得元別 `attempts` スキーマ（§3.4 フル・DB v6 マイグレーション）は**別PRに据え置き**、既存の `creditsCheckedAt`（この経路では＝YouTube取得時刻）を **30日リトライ窓**として流用。「チェック済みスキップ」ON 時は**直近30日以内にチェック済みの動画だけ**を除外し、それより前にチェックした動画（パーサ改善・概要欄編集で拾える可能性）は再取得の対象に戻す。取得失敗（`creditsCheckedAt` 未スタンプ）は従来どおり即再試行可。「スキップ」OFF は不足ロールのある動画を窓に関係なく強制再取得。
- **UI**: 「チェック済みスキップ」チェックボックスの説明を新挙動（最近チェック済み=30日以内を除外／それ以前は再取得対象）に更新。DB スキーマ・background の書き込み経路は不変。
- **Test**: `tests/verify_credit_target.js`（node・**24件**）。§3.1 回帰（旧 whole-video ゲートが部分クレジット動画を EXCLUDE ／新ゲートが INCLUDE を両方 assert・退行検出力を実測）＋ role-unit（部分/全埋め/未取得 Topic）＋ クールダウン（直近スキップ/40日で復活/30日境界/skip OFF 強制/取得失敗は即対象/既定値 true）＋定数 sanity。Path B の `verify_enrich_credits_roles.js`（26件）も回帰 green。**24 + 26 passed**。
- **既知の割り切り（軽量版の範囲）**: 単一 `creditsCheckedAt` を全取得元共通のクールダウンに流用するため、YouTube と MusicBrainz を独立に再試行日管理する用途では不足（＝§3.4 フルの per-source `attempts` は別PR）。概要欄が実際には変わっていない動画も30日窓の満了ごとに再fetch対象になりうる（パーサ改善時に拾える利点とのトレードオフ・件数は実行前の confirm ダイアログで可視）。初回実行時に「30日以上前にチェック済み＋不足ロールあり」の動画がまとまって対象化しうるが、レート制限・中止可能・confirm で件数提示のため暴走はしない。
- ⚠️ **実機スモーク未実施**（拡張再読込が必要）。`history.js` / `history.html` 変更＋新規 `credit_target.js` のみ・DBスキーマ据え置き＝移行なし。**確認観点**: ①「クレジット補完（概要欄）」を開くと、作曲だけ埋まって編曲が空の Topic 動画が**対象件数に含まれる**（旧版では除外されていた）②「チェック済みスキップ」ON で直近チェック済みが除外され、30日以上前は含まれる ③通常の全埋め動画は対象にならない ④confirm ダイアログの件数が想定より極端に多くないか（多ければ中止できる）。

## v1.42.13 (2026-07-12)
**高評価同期: unknown保存の確認が account-change 確認まで同時承認してしまう穴を塞ぐ**（Codex 2026-07-11 wrapup-review_9 M1 / PENDING id:ivhb）。`account-unknown` の初回確認後、analyzer の同期ボタンハンドラが2回目の `SYNC_LIKED` に `confirmUnknownAccount:true` と `confirmAccountChange:true` を**同時に**渡していた。background は unknown ガード（L2466）→ account-change ガード（L2481）の二段構えだが、UI が両フラグを一度に渡すため、**既存 `likedSyncMeta` が既知アカウントでも「未識別のまま保存しますか？」の1確認だけで known→unknown の account-change まで承認扱い**になっていた。実害: owner 抽出が一時的に失敗しただけの同期で、既存の既知アカウントとは別の未識別アカウントの高評価が同じデータセットに混入し、推薦材料・集計・エクスポートが汚染される。
- **Fix(M1・ガードごとに個別確認)**: 確認エスカレーションを純関数 `resolveLikedSync({ doSync, confirm })` に切り出し（DOM 非依存＝ユニットテスト可）、**フラグを個別に累積**するよう変更。`account-unknown` 承認後の再実行は `confirmUnknownAccount` のみを運び、既存メタが既知なら background が `account-changed` を返す → 既存の account-changed ハンドラが「旧: 既知 / 新: unknown」を表示して**第2確認**に進む → 承認で両フラグを付けて保存。ボタンハンドラは `confirm(kind, resp)` コールバックでダイアログ文言を組むだけに縮退。first-sync unknown（メタなし）と unknown→unknown は従来どおり1確認で保存（誤った第2確認は出さない）。
- **Test**: 純関数 `resolveLikedSync` を analyzer.js から brace 抽出し、**フラグ依存の忠実な background モック**（L2466/L2481 のガードを再現）で駆動する escalation テスト11件＋drift guard 3件。known→unknown で①両ガードが順に発火・確認される②再実行が3回（初回＋2再実行）③unknown 再実行は `confirmUnknownAccount` のみ（`confirmAccountChange` を含まない）④最終再実行で両フラグ⑤change を decline すれば保存されず cancel、を検証。**旧ハンドラ（両フラグ同時）では account-changed が発火せず known→unknown が単一確認で保存される＝RED を実測確認**（feedback_regression_test_must_fail_on_old）。**123 passed → 137 passed**。
- **別解は見送り**（Codex disposition どおり）: 別解1（dry-run/commit 分離）・別解3（unknown を別 namespace に隔離）は現行の二段確認で実害を塞げるため過剰。identity 強度モデル（別解2）は v1.42.11/12 の name-only で既に部分導入済み。
- ⚠️ **実機スモーク未実施**（拡張再読込が必要）。`analyzer.js` のみ変更・background/DBスキーマ据え置き＝移行なし。**確認観点**: ①既知アカウントで同期後、owner 抽出が失敗する状況（未ログイン等）で再同期 → 「未識別のまま保存しますか？」を承認 → **続けて「アカウントが変更されています 旧:既知 / 新:(unknown)」の第2確認が出る**こと ②その第2確認を拒否すると保存されないこと ③通常の識別済み同期では確認ダイアログが一切出ないこと。

## v1.42.12 (2026-07-11)
**name-only 弱識別の2つの穴を塞ぐ（強い識別への格上げ＋コピー用プロンプトへの警告伝播）**（Codex 2026-07-11 wrapup-review_10 M1/M2 / PENDING id:eekv）。v1.42.11 で name-only を可視化したが、①格上げ経路と②警告の伝播が弱かった。
- **Fix(M1・強度ランクで格上げ)**: `syncLikedPlaylist` の browse owner 復元条件が `!ownerChannelId && !ownerHandle && !ownerName`（＝**HTML が完全に空のときだけ**）だったため、HTML から**表示名だけ**取れた name-only 状態では、初回 VLLL browse 応答に channelId/handle があっても `extractOwnerIdentity(initResp.data)` を試さず、弱い表示名のまま `accountId` に保存していた（v1.42.11 の「表示名は弱い」という主旨と不整合・同名混入と account-change ノイズが残存）。識別を**強度ランク（channelId/handle=2 > 表示名=1 > なし=0）**で扱い、browse がより強ければ**厳密増加で上書き**するよう変更。VLLL browse は本人の高評価プレイリストに対して authoritative なので identity を丸ごと採用して安全（表示名が食い違えば既存の account-change ガードが発火）。`identitySource` を `html`/`browse` から **`html-strong`/`html-name-only`/`browse-upgraded`** に細分（診断可読性向上・強識別で browse 復元は従来どおり `identityConfidence='browse-recovered'`）。
- **Fix(M2・コピー用プロンプトにも弱識別警告)**: analyzer のメタ行では `name-only`/`unknown-confirmed` を赤表示していたが、`renderPrompt` の高評価 Top30 セクションは `partial` だけ注記し `identityConfidence` を見ていなかった。**Top30 はまさに外部の推薦AIへ持ち出すデータ**なので、コピー後に弱識別警告が落ちると混入リスクのある高評価データが完全なデータとして扱われる。純関数 `likedPromptNotes(meta)` を新設し、`partial`（部分同期）／`unknown-confirmed`（アカウント未識別）／`name-only`（表示名のみ弱識別）の注記をプロンプト本文に出力（DOM 非依存なのでユニットテスト可）。
- **Test**: E2E **Scenario K**（HTML=表示名のみ・browse header に channelId/handle → `accountId` が **channelId に格上げ**・`identityConfidence='browse-recovered'`・`identitySource='browse-upgraded'`）＋ M1 drift guard（強度ランク上書きが body に残ること）＋ M2 `likedPromptNotes` ユニット7件（name-only/unknown-confirmed で警告・強識別で無警告・partial 独立・両立・meta なしで空）＋ renderPrompt drift（`likedPromptNotes(likedMeta)` を実際に消費すること）。**Scenario K/M1 drift は旧コードで RED（4件）・M2 drift も RED＝退行検出力を実測確認**。**110 passed → 123 passed**。
- **別解 L1/L2 は見送り**（Codex disposition どおり）: L1（name-only を保存単位でも隔離 namespace に分離）は現状でも可視化されるため Low・次回 identity 改修で合わせて検討。L2（CHANGELOG 未検証事項をテスト側 pending fixture 化）も任意ドキュメント改善のため見送り。
- ⚠️ **実機スモーク未実施**（拡張再読込が必要）。`background.js` / `analyzer.js` のみ変更・DBスキーマ据え置き＝移行なし。**確認観点**: ①通常時（channelId/handle 取得）はメタ行・プロンプトともに弱識別注記が出ないこと ②HTML が表示名だけ・browse に channelId/handle があるケースで `accountId` が channelId に格上げされ、メタ行が `ℹ️ アカウントはブラウズ応答から復元` になること ③name-only のまま確定するケースでコピーしたプロンプト先頭の高評価セクションに `表示名のみ（弱識別）` 注記が入ること。

## v1.42.11 (2026-07-11)
**高評価同期で「表示名だけの識別」を強い識別扱いしない（`identityConfidence` に `name-only` を追加）**（Codex 2026-07-11 wrapup-review_9 M2 / PENDING id:2oc3）。`extractOwnerIdentity` は `ownerText.runs[0].text` を `ownerName` に入れるが、`navigationEndpoint.browseEndpoint` が無いと channelId/handle を得られない。にもかかわらず `accountId = ownerChannelId || ownerHandle || ownerName || 'unknown'` により**表示名だけを accountId として採用**しており、①`'unknown'` ではないので account-unknown ガードを通らず ②`identityConfidence` も `html` / `browse-recovered` になり**通常の完全識別成功と見分けが付かなかった**。channelId/handle は強い識別だが、表示名だけは**同名の別チャンネル・表示名変更に弱い**——channelId/handle を失った応答で表示名だけが一致すると、別アカウントの高評価が同じデータセットに静かに混入し、account-change 検出も同名同士を区別できない。
- Fix(M2・弱識別マーカー): `strongIdentity = !!(ownerChannelId || ownerHandle)` を判定し、accountId が表示名のみ（強い識別が無い）のときは `identityConfidence = 'name-only'` を記録。強度優先順位は **`unknown-confirmed` > `name-only` > `browse-recovered` / `html`**（browse から復元しても強い識別が無ければ `name-only`）。
- Fix(M2・メタ行で可視化): analyzer のアカウント行に `⚠️ 表示名のみで識別（同名の別アカウント混入に注意・再同期で強い識別が付けば解消）` を赤表示（`liked-partial` クラス付与）。次回開いても「通常の完全成功」と同じ見た目にならない。
- **ブロッキング確認は追加しない（設計判断）**: name-only は `unknown` より強い識別で、v1.42.10 M1 は「browse 復元で不要なプロンプトを減らす」方向だった。name-only ごとに確認を挟むとその設計に逆行しノイズになる。文字列が変わる劣化（強識別 `UCabc` → 表示名 `Ken`）は既存の account-changed ガードが既に発火する。残る静かな穴は「同名の別アカウントで文字列一致」のみで、これは確認ダイアログでも判別不能なため、**可視化が最も正直で過剰でない対処**と判断（Codex 別解2「弱い方向への遷移は警告」を可視化で実装・保存保留は見送り）。
- Test: 単体（`extractOwnerIdentity` が `ownerText.text` のみ・`browseEndpoint` 無しで name 取得・channelId/handle 空）＋ drift guard（body に `'name-only'` 分岐と `ownerChannelId || ownerHandle` 強識別判定が残ること）＋ E2E Scenario J（HTML degraded・browse header が表示名のみ → **confirmUnknownAccount なしで成功**・`accountId='Ken'`・`identityConfidence='name-only'`（`browse-recovered` より優先）・meta 永続）。**Scenario J は旧コードで RED**（name-only を `browse-recovered` と記録＝退行検出力あり）。**100 passed → 110 passed**。
- ⚠️ **実機スモーク未実施**（拡張再読込が必要）。`background.js` / `analyzer.js` のみ変更・DBスキーマ据え置き＝移行なし。**確認観点**: ①通常時（channelId/handle が取れる）はメタ行に `name-only` 注記が出ないこと ②実LL応答で `ownerText` に browseEndpoint が付かないケースが実在すると `⚠️ 表示名のみで識別` が出る（＝弱識別の可視化が意図どおり効く）。

## v1.42.10 (2026-07-11)
**高評価同期の degraded mode でアカウント識別を諦めるのが早すぎる問題を塞ぐ**（Codex 2026-07-10 wrapup-review_8 M1 / PENDING id:fc16）。v1.42.8 の degraded mode（`ytInitialData` parse 失敗でも同期を止めない）は正しかったが、`parseLikedPlaylistHtml` の owner 抽出が **`ytInitialData = {...};</script>` の end-anchored 正規表現1本**に依存しており、YouTube が代入形式・script の包み方を変えただけで、HTML内に owner 情報が残っていても `no-ytInitialData` → owner unknown → `account-unknown` 確認ダイアログへ流れていた。結果「別アカウント混入を人間の確認に依存する時間」が増える。M1 の3改善を実装:
- Fix(M1①・balanced 抽出): `ytInitialData` を `extractInnertubeContext` と同じ **ブレースバランス抽出**（新規共有ヘルパ `matchBalancedJsonObject`）で取得する `extractYtInitialData` を新設。`window["ytInitialData"]=` / `window.ytInitialData=` / `var ytInitialData=` / 素の `ytInitialData=` / `;</script>` アンカー無し・minify・後続 script 混在の各フォームで owner を失わない。全マーカー出現を試し最初に parse 成功したものを採用。返り値 `{data, matched}` で **「マーカーはあったが壊れている＝parse-failed」と「そもそも無い＝no-ytInitialData」を分離**（degraded 診断の粒度を維持）。owner 抽出ロジックは `extractOwnerIdentity(data)` に切り出し（HTMLとbrowse応答の両方に適用可能に）。
- Fix(M1②・browse からの owner 復元): degraded で HTML から owner が取れなくても、権威ある `browseId:'VLLL'` 初回応答の `header`（`playlistHeaderRenderer` / `pageHeaderRenderer`）から owner/channel identity を `extractOwnerIdentity` で復元し `accountId` に反映。復元できれば `account-unknown` プロンプトに落ちない（＝別アカ混入を人手確認に頼る時間が消える）。復元は **追加的**（取れなければ従来どおり unknown ガードに委譲・ガードは一切緩めない）。
- Fix(M1③・identity confidence の可視化): `likedSyncMeta` に `identityConfidence`（`html` / `browse-recovered` / `unknown-confirmed`）＋ `unknownConfirmedAt` を記録。`confirmUnknownAccount` で unknown のまま保存した場合は **次回開いても「通常の完全成功」と同じ見た目にならない**よう、analyzer のメタ行に `⚠️ アカウント未識別のまま保存（確認済・別アカウント混入に注意）` を赤表示。browse 復元時は `ℹ️ アカウントはブラウズ応答から復元` の情報注記。`unknown-confirmed` は unknown ガードが明示 opt-in を強制した後にしか保存されない。
- Test: 単体（`extractYtInitialData` の4代入フォーム＋decoy＋corrupt/absent の matched 分岐・`extractOwnerIdentity` の playlistHeader/pageHeader/空応答）＋ E2E Scenario H（HTML degraded だが browse header で owner 復元 → **confirmUnknownAccount なしで成功**・`identityConfidence=browse-recovered`・meta 永続）・Scenario I（browse も header 無し → unknown ガード発火・confirm 後保存で `unknown-confirmed`＋`unknownConfirmedAt` 記録）。**旧 end-anchored 正規表現は window-bracket/window-dot/no-anchor の3フォームを取りこぼす**ことを別途確認（退行検出力あり）。**75 passed → 100 passed**。
- ⚠️ **実機スモーク未実施**（拡張再読込が必要）。`background.js` / `analyzer.js` のみ変更・DBスキーマ据え置き＝移行なし。**確認観点**: ①通常時は従来どおり「同期完了・警告0件」でメタ行に confidence 注記が出ないこと ②実LL応答の `browseId:'VLLL'` 初回応答が `header.playlistHeaderRenderer` / `pageHeaderRenderer` で owner を実際に carry するか（carry しなければ②は無害に空振りするだけで unknown ガードに委譲）。**残る M1 の別解（unknown は dry-run confirmation で2回目に保存）は未採用**（現行の確認ダイアログ＋confidence 可視化で心理的ハードルは担保できると判断）。

## v1.42.9 (2026-07-11)
**高評価同期の primary container 選定を「件数ヒューリスティック」から「構造アンカー」へ寄せる（部分対応）**（Codex 2026-07-10 wrapup-review_8 H1・M2 / PENDING id:zn5r ①②③④）。v1.42.7 は「コンテナ名は証明でなく tie-breaker」に降格したつもりだったが、`LL_ITEM_CONTAINERS` に **汎用 continuation envelope**（`appendContinuationItemsAction` / `reloadContinuationItemsCommand`）が入ったまま `named` を子孫に伝播していた。そのため兄弟の推薦シェルフが同じ汎用 envelope 配下に入り、本体より多くの lockup を持つと **兄弟が primary に誤選定**され、別セクションの動画が `scoped` として高評価DB・推薦材料・エクスポートを汚染し、token も誤選定側から採るため pagination も逸れうる残存穴があった。
- Fix(H1・構造アンカー化): `LL_ITEM_CONTAINERS` を2つに分割。**`LL_PRIMARY_RENDERERS`**（`playlistVideoListRenderer` / `richGridRenderer`＝プレイリスト固有レンダラ・LL由来の実証拠）だけが `named` を伝播し、primary 選定で **件数に関わらず勝つ**（＝構造アンカー）。**`LL_CONTINUATION_ENVELOPES`**（汎用 envelope）は優先材料から外し、選定にバイアスを与えない（token は元々 primary 部分木からしか採らないので、envelope の名前照合は不要）。素の**件数比較は最後の fallback** に降格。
- Fix(H1・不確実なら partial): アンカーが無く件数 fallback が **同点**（複数の無名配列が最多件数で並ぶ＝どれが本体か証明不能）のとき `primaryUncertain` を立て、**token を信頼せず**（`continuationScoped=false`）、caller が `init-browse: primary-uncertain` / `page-N: primary-uncertain` を積んで **partial** にする（コインフリップの当て推量を「完了」と偽らない）。本体が唯一の最多配列＝strict max のときは従来どおり確定（＝通常応答に誤発火しない）。
- Fix(H1・named の深いネストへのフラッド遮断／Codex 2026-07-11 独立レビュー R 指摘): `named` を **固有レンダラの直下アイテム配列だけ**に限定し、ネストしたオブジェクトへは流さない。配列は `named` を継承する（`renderer.contents` は named 維持）が、ネスト**オブジェクト**へ降りると継承 named を落とし、そのキー自身が固有レンダラのときだけ再付与する。これがないと `richGridRenderer.header.shelfRenderer.contents` のような**固有レンダラ配下の深いネスト棚**が named を継承し、本体より多い lockup を持つと primary を内側から奪う＝H1が子孫経由で再侵入する穴が残っていた（分割前は汎用 envelope、分割後も flood 伝播でこの子孫経路が残存）。
- Test(M2・負け筋を固定): ①`playlistVideoListRenderer` 配下の本体2件 vs 汎用 envelope 配下の兄弟**3件**でアンカー勝ち ②無名2配列の同点で `primaryUncertain`＋token拒否 ③Scenario G で end-to-end に「大きい兄弟の token を **fetch しない**・DBに入れない」 ④`richGridRenderer.header.shelfRenderer` 配下の**深いネスト棚3件**が本体2件を奪わない（named フラッド遮断）。**旧実装／flood版でこれら該当アサーションが RED**（大きい兄弟/ネスト棚を primary に選び token 追従＝退行検出力あり・別スクリプトで確認）。既存の H1 mixed fixture も汎用 envelope → `playlistVideoListRenderer` に更新。**61 passed → 75 passed**。
- ⚠️ **実機スモーク未実施・H1完全クローズは未確定**。今回は「新しいアンカーパスの当て推量を焼き込まない」安全な絞り込み（既知の固有レンダラ名への限定＋不確実時 partial）に留める。**残る観点＝「初回 `browseId:'VLLL'` 応答で高評価本体が実際に `playlistVideoListRenderer` / `richGridRenderer` 配下に来るか」の現物確認**（拡張再読込＋実LL応答の構造確認）。ここを確認するまで「本体も兄弟も汎用 envelope・兄弟の方が多い」最難負け筋は未カバー（当て推量アンカーは v1.42.6 の scope-fallback 偽陽性の轍のため意図的に見送り）。`background.js` のみ変更・DBスキーマ据え置き＝移行なし。

## v1.42.8 (2026-07-10)
**高評価同期を degraded mode 化：`ytInitialData` の parse 失敗で全面停止しない**（Codex 2026-07-10 wrapup-review M3・別解 / PENDING id:2x0d ③）。
- 背景: v1.42.7 で静的HTML由来の continuation フォールバックを撤去し、items も token も **権威ある `browseId:'VLLL'` browse が供給** するようになった。にもかかわらず `parseLikedPlaylistHtml` が `no-ytInitialData` / `parse-failed` を返すと即 return しており、**YouTube が初期データの代入形式を変えただけで高評価同期が丸ごと死ぬ**脆さが残っていた。いまや静的HTMLは前座で、parse 失敗で失うのは **owner identity だけ**。それは `account-unknown` の明示確認ガードが既にカバーしている。
- Fix(M3): parse 失敗時も **owner unknown の skeleton のまま browse へ進む**。parse error は `errors` に `html: <reason>` として積み、`degraded` フラグ（＋ `diagnostics.degraded` / `likedSyncMeta.degraded`）に残す。items が取れて account が unknown なら、従来どおり **既存の明示確認ガード**（analyzer の confirm ダイアログ）に委ねる。
  - **partial にはしない**: items は権威ある browse から取得しページングも完走しているので完全。parse 失敗を「部分同期」と表示すると v1.42.6 の `scope-fallback` と同じ**偽陽性警告**を再生産する。警告としては `警告1件` に出る。
  - **degraded の床（安全弁）**: `INNERTUBE_API_KEY` も InnerTube context も取れないHTMLは、そもそも使えるYouTubeページではない（同意ウォール・エラーページ）。browse が撃てないので **従来どおり元の reason で hard fail** し、無意味な「アカウント不明のまま保存しますか？」を出さない。
  - degraded 時もアカウントガードは一切緩めない（**委譲するだけ**）。
- Test: Scenario E（M3 直接回帰テスト）— parse 失敗でも ①同期が成功し ②browse の items が保存され ③`html: no-ytInitialData` が **停止でなく警告**として出て ④`degraded` が露出し ⑤partial にならず ⑥**未確認時は `account-unknown` ガードが依然発火する**ことを検証。Scenario F は degraded の床（apiKey/context 皆無 → hard fail・browse 未発射・DB未書込）。**旧実装ではE系7件が全FAIL**（＝退行検出力あり）。**52 passed → 61 passed**。
- ⚠️ 実機スモーク未実施（拡張再読込が必要）。`background.js` のみ変更・DBスキーマ据え置き＝移行なし。**確認観点**: 通常時は従来どおり「同期完了・警告0件」（degraded 経路に入らないこと）。

## v1.42.7 (2026-07-10)
**高評価同期の「出どころ証明」を完成させる**（Codex 2026-07-10 wrapup-review H1 / PENDING id:2x0d ①②）。v1.42.6 の scoping は **コンテナ「名前」** を信頼していたが、`appendContinuationItemsAction` / `reloadContinuationItemsCommand` は **LL固有ではなく継続応答の汎用 envelope**。よって逸れた token の応答が同じ envelope で新規 lockup を返すと `scoped` 判定で保存され、`no-scoped-items` にも落ちなかった（v1.42.6 の残存穴）。
- Fix(H1・出どころ証明の完成): **コンテナ名の allowlist を「証明」から降格し、構造的な primary container 選択に置換**。`extractItemsAndContinuation` は ①アイテムが実際に入っている配列（既知LL名を優先、無ければ最多アイテム数の配列）を **primary container** として特定 ②primary 内の item のみ `scoped`（他配列＝推薦シェルフ等は `loose`）③**continuation token は primary container の内側からしか採らない**（兄弟の `continuationItemRenderer`、無ければ **primary の部分木に限定した**正規表現）。
  - **これが H1 を本当に塞ぐ理由**: 旧コードは `JSON.stringify(応答全体)` の最初の `continuationCommand` を拾うフォールバックを持ち、これが**唯一の逸れの入口**だった。いったん別セクションの token を fetch すると、その応答は本物のLLページと構造的に区別できない（同じ汎用 envelope）ため、下流のどんな検査でも検出不能。**アイテムを採った配列の外から token を絶対に採らない**ことで、権威ある `browseId:'VLLL'` 応答を起点に LL 由来が **帰納的に** 保証される。
  - `parseLikedPlaylistHtml` の「Fallback 1: stringify(data) 正規表現」「Fallback 2: 生HTML 正規表現」を **撤去**（現代のLLページでは推薦シェルフの token を掴む常習犯）。静的HTMLに token が無くても、権威ある VLLL browse が本物を供給する。
  - **未証明 token は使わない＋partial で警告**: `continuationScoped` が偽の token はページングに使わず、`rejectedTokenCount`（primary 外に token があった件数）を返す。拒否したら `unproven-continuation` を errors に積み **partial** にする（＝正当な token を拒否してしまった場合でも「同期完了」と偽らない）。
- Fix(M1・Codex 2026-07-10): init-browse の loose フォールバックが loose を全件無条件採用する問題は、**設計ごと消滅**。`allowFallback` / `scopeFallbacks` の救済機構は「コンテナ名で scoped を決めていたから、名前が未知だと scoped が0件になる」ことへの対症療法だった。primary container は構造的に選ばれるので、**アイテムがある応答は必ず scoped を1件以上持つ**（zero-scoped-with-items は起こり得ない）。v1.42.6 の偽陽性 partial（`init-browse: scope-fallback`）も同時に消える。
- Test: Scenario C を **H1 の直接回帰テスト**に置換 — primary container の外（推薦シェルフ）にある token を **一度も fetch しないこと**・そのページの動画がDBに入らないこと・拒否時に partial になり理由が `unproven-continuation` であることを検証。旧実装なら全体正規表現で当該 token を拾って fetch するため **必ず落ちる**（退行検出力あり）。Scenario B は「名前未知のコンテナを構造的に受理し非partial」に更新。**46 passed → 52 passed**。
- ⚠️ 実機スモーク未実施（拡張再読込が必要）。`background.js` のみ変更・DBスキーマ据え置き＝移行なし。**確認観点**: 同期完了・件数が従来どおり（〜4,618件・47ページ）・警告0件。もし「部分同期 [init-browse: unproven-continuation]」が出たら、実LL応答で token がアイテム配列の外に置かれている＝primary container の判定を実応答に合わせて調整する必要がある（**その場合もデータ汚染は起きず、警告として可視化される**）。

## v1.42.6 (2026-07-09)
高評価同期の**完全性の深堀り**（Codex wrapup-review_2026-07-05 / PENDING id:k25d）。v1.42.5 は「異常を検出して止める」前進だったが、根本の「どの item/token が高評価プレイリスト由来か」を証明できていなかった。出所証明・partial永続表示・読み込み世代管理の3点で埋める。
- Fix(H1・出所証明): `extractItemsAndContinuation` を**スコープ認識化**。既知のLLアイテムコンテナ（`playlistVideoListRenderer`/`richGridRenderer`/`appendContinuationItemsAction`/`reloadContinuationItemsCommand`）配下で見つかった item を `source:'scoped'`、圏外を `'loose'` とタグ付け（`continuationScoped` も同様）。`syncLikedPlaylist` は **scoped のみ保存し loose（他セクションの推薦シェルフ等が同一応答に混在した動画）を除外**（`droppedLoose` で診断計上）。従来は応答全体を再帰走査して別セクションの `lockupViewModel` も高評価データとして保存し、推薦プロンプト・集計・エクスポートを静かに汚染しうる余地があった（v1.42.5 の `newOnPage>0` ガードは別セクション由来の**新規**videoIdを返す逸れを止められない）。
  - **scoping の本質は「継続トークンの逸れ検出」**（Codex の懸念＝逸れた token が推薦シェルフを拾う）。初回フェーズ（静的HTML・VLLL init browse）は**その高評価プレイリスト自体のクエリ結果**なので、アンカー未収録コンテナに入っていても中身は正当＝**「未知コンテナだが完全」であって partial ではない**。YouTube は LL のコンテナ構造をリクエストごとに変える（後述スモークで実測）ため、初回応答の scoped 0 を partial 扱いすると偽陽性になる。
  - **フェーズ別の扱い**: ①`init-browse`（VLLL・権威）= フォールバック許可・zero-scoped は loose を採用するが **`scopeFallbacks` 診断に記録するだけ（errorに積まない＝partialにしない）** ②静的HTML = フォールバック禁止（browse が必ず backfill する前座なので loose は捨てる＝推薦のみの静的ページが混入を撒くのを防ぐ） ③継続ページ = フォールバック禁止・zero-scoped は token 逸れ（`no-scoped-items`＝真のerror→partial）とみなし停止し loose を保存しない。
  - 永続化前に一時タグ `source` を除去（DBの高評価レコードには残さない）。
  - ⚠️ **残存リスク（本版時点・→ v1.42.7 で解消済み）**: `appendContinuationItemsAction`/`reloadContinuationItemsCommand` は **LL固有のコンテナではなく continuation 応答の汎用 envelope**。よって「逸れた token の応答が同じ標準 envelope で新規 lockup を返す」ケースでは、その item も `scoped` と判定され保存されうる（`no-scoped-items` に落ちない）。本版の scoping が証明しているのは「継続 envelope の内側にいる」ことであって「LLプレイリスト由来」ではない。→ **v1.42.7 で primary container 方式＋token provenance に置換し解消**。
  - **実機スモーク（2026-07-09・2回）**: (1回目) 前版コードで `取得4617件/47ページ/完了`・`droppedLoose:0`・`accountId`実チャンネルID取得（H1が正当itemを誤除外していない／unknown-guardクリア）を確認。唯一 `html: scope-fallback` ノイズを検出→html を `allowFallback=false` 化。(2回目) 最新コードで **`init-browse: scope-fallback` が「部分同期」として誤警告**されるのを発見（データは4618件全取得できているのに「部分同期・再同期推奨」＝**偽陽性**。YouTube が init 応答のコンテナを間欠的に変えるため）。これは初回フェーズを partial 扱いした設計ミス→上記のとおり **scope-fallback を非partialな `scopeFallbacks` 診断に格下げ**して修正。**この2回目のスモークで M1 の部分同期メタ行赤字表示が実機動作することも確認できた**（`[init-browse: scope-fallback]` が再読込後もメタ行に赤字表示された）。DBスキーマ据え置き＝移行なし。
- Fix(M1・partial永続表示): `renderLikedPanel()` のアカウントメタ行に partial/lastError を**恒久表示**（部分同期時は「⚠️ 部分同期（全件取得できていません・再同期推奨）」＋危険色）。`renderPrompt()` の高評価セクションにも部分同期注記を追加。v1.42.5 は partial を `likedSyncMeta` に保存していたが同期直後の一時トーストにしか出しておらず、**再読込で警告が消え**、不完全な高評価データを完全同期済みと誤認して推薦プロンプトを使える silent partial だった。
- Fix(M2b・Codex 2026-07-10 指摘の実バグ): **推薦プロンプトへの部分同期注記が実際には出ていなかった**のを修正。`renderLikedPanel()` が `GET_LIKED_META` を非同期に投げる一方 `renderPrompt()` は直後に同期実行されるため、`renderPrompt()` は更新前の `likedMeta`（初回は `null`）を読み、上記 M1 の「プロンプトへの partial 注記」が事実上デッドパスだった。meta 取得を `loadLikedMeta()` として Promise 化（`loadLikedSeq` と同型の世代ガード付き）し、`renderLikedPanel()` はキャッシュ済み `likedMeta` を同期読みするだけに変更。全呼出側（`runAnalysis` 初回・同期完了後）で `await` してから描画する。
- Fix(L1・Codex 2026-07-10): meta が無い（未同期）ときに `liked-partial` の危険色クラスが解除されず、「未同期」が赤字のまま残る問題を修正。
- Fix(L2・Codex 2026-07-10): テスト Scenario B のコメントが `fallback + partial` のままで実 assertion（`partial === false`）と矛盾していたのを訂正（将来 v1.42.6 の意図と逆に「直される」のを防ぐ）。
- Fix(M2・読み込み世代管理): `loadLiked()` に単調増加 `loadLikedSeq` を導入し、**最新以外の応答は `likedRecords`/UI を更新しない**。従来は初回表示時の3秒タイムアウト後に遅れて戻った `GET_LIKED` が、同期完了後の `await loadLiked()` で取得した新しい `likedRecords` を古い/空データで上書きしうるレースがあった。
- Test(L1): 合成検証を mirror predicate 依存から脱却。`sendToYouTubeTab`/`sendToOffscreenDb`/`chrome`/`parse+ytcfg` をモック注入し **`syncLikedPlaylist` 本体を実行**して検証（出所不明lockup混在の除外・init-browse フォールバックが**非partial**であること・静的HTML loose の drop+browse backfill・継続ページ逸れ時の停止=partial）。加えて H1 スコープタグ付けの単体検証と M2 世代ガードのシミュレーションを追加。**22 passed → 46 passed（`node tests/verify_liked_sync_robustness.js`）**。
- 実機スモーク（2026-07-09・2回）: **H1・M1 は実機確認済み**（上記 H1 bullet 参照＝正常同期・件数一致・`droppedLoose:0`・unknown-guardクリア／2回目で M1 部分同期メタ行の赤字表示が再読込後も残ることを確認・偽陽性partialは修正済）。**M2（遅延応答の世代破棄）は未発火**＝高評価件数が多く `loadLiked` が3秒超になったときに初めて観測できるため次の機会に持ち越し（合成検証で担保済み）。`background.js`/`analyzer.js`/`history.html`（`.liked-partial` CSS）/`manifest.json` のみ変更・DBスキーマ据え置き＝移行なし。

## v1.42.5 (2026-07-05)
高評価同期（Liked動画取得）の完全性・堅牢性強化。v1.41.1 で「取得できるように」はしたが、部分データを成功扱いする設計・アカウント同一性チェックの弱さを Codex が指摘（wrapup-review_2026-06-28_13 / PENDING id:ywh2）。CWS 公開（id:yt41）前に H1/M1 を中心に対応。
- Fix(H1・実害級): `accountId === 'unknown'` のまま同期成功させない（`background.js` `syncLikedPlaylist`）。従来は静的HTML header から owner を取れないと `accountId='unknown'` で黙って保存でき、初回 unknown や「保存済みも unknown」のとき **別アカウントの高評価が混入してもアカウント変更検知を通過**した（account-change 検知は unknown 同士を区別できない）。`account-unknown` 理由で停止し、Analyzer 側で明示確認（`confirmUnknownAccount`）を取ってからのみ保存。推薦プロンプト・集計・エクスポートの汚染を防ぐ。
- Fix(M1): ページング途中失敗を「同期完了」表示しない。continuation が残ったまま cap 到達／page 失敗／empty-page／init-browse 失敗で打ち切ると、従来は取得済み分を UPSERT して `success:true`＝「同期完了」表示だった。`partial`/`hasMore`/`lastError` を戻り値と `likedSyncMeta` に持たせ、Analyzer は「⚠️ 部分同期（全件取得できていません・再同期してください）」と表示。古い高評価欠落状態を「完了」と誤認させない。
- Fix(M2・完全性ガード): continuation token が逸れる／ループする事故を検知。各ページで**新規 videoId が 0 件**なら（mis-scoped な正規表現 fallback token 等でページングが別セクションへ逸れた兆候）`all-duplicate` として停止し partial 扱い。正規表現 fallback は lockupViewModel 応答で必要なため残置（token 出所は `continuationSource` で判別可能に）。
- Fix(L1): `lockupViewModel` の channel fallback が非チャンネル文字列（再生数・投稿日等）を拾う可能性を排除。browseEndpoint(UC) linked な metadata part が無いときは channel を**空**にする（Analyzer は「チャンネル不明」として扱う）。高評価アーティスト集計の汚染防止。
- Fix(L2): `loadLiked()` の3秒タイムアウト後に `GET_LIKED` 応答が遅延到着したら再描画（`renderLikedPanel`/`renderPrompt`）。高評価件数が多く読み込みが3秒を超えた場合に、古い/空の高評価データで推薦プロンプトが生成される問題を解消。
- CHANGELOG 表現も M1 に合わせ「成功時は最大5000件・50ページ／途中失敗時は部分取得（警告表示）」の実態に整合。
- ⚠️ 実機スモーク（拡張リロード後の同期 UI・unknown 確認ダイアログ・部分同期表示・遅延再描画）は未実施。`background.js`/`analyzer.js`/`manifest.json` のみ変更・DB スキーマ据え置き＝移行なし。合成検証は下記。

## v1.42.4 (2026-07-03)
- Fix(H1 sibling・実害級): `getCurrentVideoDurationSec()` に **videoId 照合** を追加（PENDING id:8v48）。v1.42.1 で category 経路にのみ videoId 照合を入れ duration は「proven path 未変更」として残していたが、`getInitialPlayerResponseDurationSec()` も同じく `document.scripts` を走査するため **同一の盲点**があった。SPA遷移後に前ページの `ytInitialPlayerResponse` script が残っていると現在動画に**前動画の長さ**を保存しうる（長さ分布・長さ別嗜好が静かに汚染）。`getInitialPlayerResponseDurationSec(expectedVideoId)` へ拡張し、`videoDetails.videoId` が一致する player response のみ採用（不一致・videoId 欠落は stale 扱いでスキップ）。`recordCurrentVideo` の watch ページ経路（`domAgrees` 時）から現在 `videoId` を渡す。category の `getCurrentVideoCategory` と同じ `accept` 構造でミラー。
- meta[itemprop="duration"] / `<video>.duration` / `.ytp-time-duration` の fallback は **未ガードのまま維持**（これらは live DOM/player を読むうえ、呼び出しは `watchMetadataMatches(videoId)` が真＝現在動画で DOM が確定した後に限定されるため）。ライブ動画の `-1` セマンティクスも保持。seekbar カード経路（`getDurationFromCard`）はカードスコープで staleness 無縁のため未変更。
- 退行検出付き合成検証: content.js から実関数を抽出し 8 ケース PASS（win/script の match・mismatch・videoId欠落・no-gate後方互換・live・win mismatch→script fallback）。旧実装は mismatch ケースで前動画長を返し FAIL する＝退行検出力あり。
- ⚠️ 実機スモーク（実 watch ページで SPA 遷移後に前動画の長さが混入しないか・正常動画で長さが従来どおり保存されるか）は拡張再読込が必要なため当初未実施だった。**2026-07-03 追記: 自動スモークハーネス `tests/smoke_duration_videoid_gate.py`（Playwright で実拡張をロード→stale 罠を注入→`ended` dispatch→拡張DB照合）で検証済み・PASS**（distinct 罠 id≠B→実長で罠を skip / match 罠 id=B→罠 9999 を観測、で teeth 両立）。content.js のみ変更・DB スキーマ据え置き＝移行なし。

## v1.42.3 (2026-07-02)
- Fix(M2・レース防止): `clearAll()` / `clearLikedByAccount('')` が `request.onsuccess`（transaction コミット前に発火）で resolve していたのを **`tx.oncomplete` で resolve に統一**（PENDING L299 / Codex wrapup-review_5）。await 直後に件数表示・エクスポート・キャッシュ無効化を行うと DB コミット前状態を観測しうる／request success 後に transaction abort しても成功扱いで返るレースを解消。両関数に `tx.onabort` の reject も追加。`clearLikedByAccount` の clear-all 分岐を早期 return から通常フローへ統一。
- Fix(M3・バックアップ復旧の実害軽減): import / merge を **tolerant mode 化**。従来は `validateWatchedRecords()` / `validateLikedRecords()` の事前検証で **1件でも型不一致があると全件拒否**だった（後段の `filter(isValidRecord)` は到達不能な dead code だった）。`parseImportData` / `importData` / `mergeImport` / `importLikedData` を「配列でない＝構造破壊時のみ throw、個別の壊れレコードは落として残りを復元」に変更。除外件数は `parseImportData` が `droppedWatched` / `droppedLiked` として返し、offscreen → background → popup に伝播して import/merge 完了トーストに「N skipped」を表示。壊れた1件でバックアップ全体が復元不能になる事故を防止。
- Chore: 上記で参照されなくなった `validateWatchedRecords` / `validateLikedRecords`（内部・非export）を削除。
- ⚠️ 実機スモーク（拡張リロード後の clear/import/merge 動作・壊れレコード混入バックアップの部分復元・トーストの skipped 表示）は未実施。db.js / offscreen.js / popup.js / manifest.json のみ変更・DB スキーマ（DB_VERSION=5）据え置き＝移行なし。
- 見送り（別PENDING）: M1（高評価の `[accountId, videoId]` 複合キー化）は単一アカウント運用では実益ゼロ・スキーマ移行のブリックリスクと実機検証必須のため今回は見送り。M1 の移行設計は複数アカウント運用が必要になった時に単独リリースする。Low3点（category 正規化の DB 層化 / host 権限分離 / CHANGELOG Unreleased 位置）も見送り。

## v1.42.2 (2026-07-02)
- Fix(M1): `addWatched()` が seekbar 由来レコード（`playCount:0`）を self 再生したとき、再生回数が `0→2` に跳ねる既存バグを修正（PENDING L99）。原因は `(existing.playCount || 1) + 1` の `||` が実数 0 を 1 に coerce していたこと。`??`（nullish）に変更し、真の 0 は保持して `0→1`（初回 self 再生）、`1→2`（2回目）と正しく数える。保持側（seekbar 再検出）も同根で `0→1` に化けていたのを `0→0` へ修正。playCount 過大計上による関与度（artist/channel ランキング）の過大評価を解消。
- category とは無関係の既存挙動・低影響（db.js のみ変更）。null/undefined フォールバックは 0（移行済みレコードは v2 migration で playCount≥1・normalizeRecord も 0 既定のため実挙動は不変）。
- Chore: アイコン刷新（icon16/48/128.png）。旧アイコンは `icons/_old_redcircle/`（gitignore）に退避。
- 注記: 本リリースは未タグだった v1.42.0（category 前進キャプチャ）・v1.42.1（category ハードニング・実機スモークPASS済）を含めて v1.42.2 として一括公開。

## v1.42.1 (2026-06-29)
- Fix(H1・実害級): `getCurrentVideoCategory()` に **videoId 照合** を追加（PENDING L98 / Codex wrapup-review_4）。SPA遷移後に前ページの `ytInitialPlayerResponse` script が `document.scripts` に残っていると、現在動画に**前動画の category** を付けてしまい（音楽タイトル動画が誤って非音楽 veto される）盲点があった。`recordCurrentVideo` から現在 `videoId` を渡し、`videoDetails.videoId` が一致する player response のみ採用（不一致・videoId 欠落は stale 扱いでスキップ＝誤attach するくらいなら空で返す）。duration の proven path は未変更（category 経路のみに限定）。
- Fix(L1・locale堅牢化): category の veto を **既知の非音楽カテゴリ集合**一致時のみに限定（`analyze_video_taste.py`）。従来は `category != 'Music'` の完全一致依存で、JP locale の localized 値（「音楽」等）・空白・大小文字差が来ると全動画が非Music扱いになり音楽タイトルを全 veto する恐れがあった。保存時 `trim()`＋分析時 `strip().casefold()`＋既知集合照合に変更。未知値（localized/将来/typo）は **veto に使わず** §0.6b 監査枠に surface（`category_unknown_values` metric）。
- Fix(M3): `mergeImport()` の既存レコード補完に `category` を追加（db.js）。category 入りバックアップを merge してもローカル既存レコードが欠損のままだった漏れを修正（durationSec backfill と同パターン・前進のみ補完）。
- 退行ゼロ: 実データ 28,039 件で music 17,080 / 非音楽 10,959・§0.5 残存 1 が v1.42.0 baseline と一致（category 空のため pre-fix と同一挙動）。H1（videoId 照合 6 ケース）・L1（locale/strip/casefold/L97保持/強ch優先 9 ケース）は合成データで検証済。
- ⚠️ 実機スモーク（実 watch ページで category が DB 保存され export に乗るか・保存値が en か localized か）は拡張再読込が必要なため未実施。

## v1.42.0 (2026-06-29)
- Feature: 視聴記録に YouTube の microformat `category`（"Music" / "Gaming" / "Education" / "Comedy" …）を**前進キャプチャ**で保存（PENDING L98）
  - `/watch` ページの `ytInitialPlayerResponse.microformat.playerMicroformatRenderer.category` を duration と同じ経路で抽出し、`recordCurrentVideo`（source=self）で取得。seekbar カード経路は microformat を持たないため未取得（`category: ''`）
  - DB（`addWatched` / `normalizeRecord` / `isValidRecord`）に `category` 文字列フィールドを追加。新規ストア・index は増やさないため IndexedDB のバージョン bump は不要（既存レコードはキー不在＝分析側で空文字フォールバック）。エクスポートは生レコードを直列化するため自動で `category` が乗る
  - 履歴の一括 harvest（background.js のクレジット取得経路）は今回触らない＝過去レコードには付かない前進キャプチャのみ。費用対効果が低い「おまけ」のため evidence 扱い限定（`projects/video-taste/music-tagging-detail.md` の 2026-06-29 GO/NO-GO 判定に準拠）
  - 分析側 `analyze_video_taste.py` は `category` を **負の証拠**として使用: `category != "Music"`（Gaming/Comedy/Education…）は最弱の title 正規表現ヒットを veto して非音楽確定。`category == "Music"` は確定証拠にしない（教則/機材/替え歌が全て Music を返すため・2026-06-29 probe）＝既存 is_music へフォールバック。category 欠損時は pre-L98 と完全に同一挙動（実データ 28,039 件で music 17,080 / 非音楽 10,959・§0.5 残存 1 件が baseline と一致を確認）
  - 非音楽側のジャンル粒度（おまけ）として §0.6「非音楽ジャンル内訳」を追加（前進キャプチャ分が蓄積するまでは静かにスキップ）
  - content.js / db.js / offscreen.js のみ変更。background.js / analyzer.js / popup.js は変更なし

## v1.41.1 (2026-06-28)
- Fix: 高評価同期が `no-items` で失敗する問題を修正（YouTube側の構造変更への追従）
  - YouTubeが高評価プレイリストの動画項目を旧 `playlistVideoRenderer` から新 `lockupViewModel` 構造へ移行したため、`extractItemsAndContinuation` が項目を抽出できず0件になっていた。`lockupViewModel`（`contentId`=videoId / `lockupMetadataViewModel.title.content`=タイトル / `metadataRows` のチャンネルリンク=チャンネル名）に対応
  - 静的HTMLに項目が無くても早期returnせず認証browse（VLLL）フォールバックへ流すよう変更（`!continuation || !allItems.length` で発火）。最終的に0件のときだけ `no-items` を返す末尾ガードを追加
  - continuation応答から次ページトークンを取りこぼし2ページ（200件）で止まる問題も修正（stringify+正規表現フォールバックを追加）。これで最大5000件・50ページまで遡れる
  - 同期失敗時に画面メッセージとconsoleへエラー内訳（`errors` 配列・例: `init-browse: http-401`）を表示
  - 旧 `playlistVideoRenderer` 経路・ログイン状態・アカウント検出・アカウント変更検知のロジックは変更なし

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
