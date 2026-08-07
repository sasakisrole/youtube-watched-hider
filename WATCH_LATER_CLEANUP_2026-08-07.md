# 後で見る（Watch Later）一括整理 — Round A/B 実装メモ

- 起点: ChatGPT引き継ぎ `claude-code-handoff-20260807-230154-youtube-watch-later-cleanup.md`（I-001〜I-102）
- 実装日: 2026-08-07
- 状態: **非破壊スキャンまで完了。削除は未実装**（Round C以降）

## これは何をするものか

「後で見る」に溜まった動画のうち、Watched Hider が視聴済みとして持っている動画を
まとめて消すための機能。今回はその**前半だけ**を作った。

いま押せる `照合` ボタンがやること:

1. 後で見るを全ページ取得する
2. 視聴済みデータベースと videoId で突き合わせる
3. 「後で見る N件 / 視聴済み一致 N件 / 未視聴 N件」と件数を出す

**この段階では1件も削除しない。** 後で見るにも視聴済みDBにも一切書き込まない。

## 引き継ぎ時点の前提のうち、実測して違っていたもの

| 項目 | 引き継ぎMD | 実測(2026-08-07) |
|---|---|---|
| manifest版 | v1.42.14 (I-017) | v1.43.11 |
| ブランチ/HEAD | `recovery/...` `ffec313` (I-018) | `main` / `6a63017` / 差分なし |
| `w2mp §8.1` アカウント固定 (I-095) | 未実装か要確認 | **実装済み**（高評価同期で稼働中） |

I-032（`X-Goog-AuthUser` 決め打ちを避け `SESSION_INDEX` を基準にする）も既存実装が
すでにその設計。今回はそれを流用しただけで、新規に作っていない。

## 追加・変更したファイル

| ファイル | 変更 |
|---|---|
| `watch_later_core.js` | **新規**。削除可否の判断だけを持つ純粋ロジック（chrome API・通信・DBに触れない） |
| `background.js` | `importScripts` 追加／共有抽出器が `setVideoId` も拾うように／`scanWatchLater()` と `SCAN_WATCH_LATER` メッセージを追加 |
| `history.html` / `history.js` | メンテナンス行に `後で見る > 照合` ボタンと結果表示 |
| `tests/verify_watch_later_core.js` | **新規**。43チェック |
| `tests/fixtures/watch_later_browse.json` | **新規**。合成VLWLレスポンス |
| `tests/verify_liked_sync_robustness.js` | 抽出器のスライス位置に新関数が挟まったため追随 |
| `scripts/build_dist.py` | `importScripts()` の参照を辿るように（後述） |

## 埋め込んだ安全ルール（テストで固定済み）

- **削除の宛先は `videoId` ではなく `setVideoId`**（その動画の「その行」のID）。同じ動画を
  2回入れていれば行は2つあり、`videoId` で潰すと片方だけ消えて両方消えたように見える。
- **DBが答えられなかった動画は候補に入れない**。`true`/`false`/`undefined` の三値で扱い、
  DBエラーを「未視聴」に変換しない（既存 §8.3 の方針を踏襲）。DB照合そのものが失敗したら
  件数を出さずに中止する（「一致0件」と「DBが読めなかった」を混同させない）。
- **おすすめ棚を混ぜない**。同じレスポンスに同居する推薦動画は `loose` として捨て、
  ページ送りのトークンも後で見る本体のコンテナ由来のものしか辿らない（既存の高評価同期と同じ防御）。
- **アカウント固定**。開始時のタブID・`SESSION_INDEX`・アカウントIDを固定し、取得後にもう一度
  照合する。途中で変わっていたら結果ごと破棄する。
- **`setVideoId` が取れなかった行は候補外**。宛先が作れない行を videoId で推測しない。
- **再特定は一意のときだけ**（`findUniqueRowByVideoId`）。同じ videoId の行が複数あるときは
  `ambiguous` を返して呼び出し側に判断させる（Round Dで使う）。

## build_dist.py を直した理由（release-blocker だった）

`watch_later_core.js` は background.js の `importScripts()` からしか読まれない。
dist のホワイトリストは manifest とHTMLの参照しか辿っていなかったため、**このファイルが
zipから落ちて、パッケージ版だけ service worker が起動時に丸ごと落ちる**状態だった
（開発版=フォルダ読み込みでは再現しない）。`importScripts()` を辿るようにして解消。
dry-run のホワイトリストは 28件 → 29件。

## 実機スモーク結果（2026-08-08・非破壊）

`照合` ボタンの実行結果（けんとさんの実アカウントで実施・削除なし）:

```text
後で見る 582件 / 視聴済み一致 45件 / 未視聴 537件
```

読み方（`history.js` は 0件のカウンタを表示しない＝出ていない項目は 0 を意味する）:

| 観測 | 導かれること |
|---|---|
| 45 + 537 = 582 | 内訳が閉じている |
| `削除ID未取得` の表示なし → `counts.noSetVideoId === 0` | **582行すべてで `setVideoId` を抽出できた**＝実 `VLWL` レスポンスに対して抽出器が通用している |
| `判定不能` の表示なし → `counts.indeterminate === 0` | 582件すべてに視聴済みDBが三値で答えた（DBエラーの「未視聴」化なし） |
| `※全件を取得しきれていません` の表示なし → `partial === false` | `hasMore` が偽、かつ `html` / `init-browse` / `page-N` 系のエラーがゼロ＝全ページ取得しきった |

これで「まだ確定していないこと」1（fixtureが合成で実レスポンスとの整合が未確認）は、
**削除に必要な範囲では解消**した。fixture 差し替え自体は未実施だが、実レスポンス側で
`setVideoId` と継続トークンが期待どおり取れることは実測で確認済み。

⚠️ 未確認のまま残る点: YouTube の画面が表示する本数と 582 が一致するかの目視突合。

## Round C 実装（2026-08-08）— 1件だけ削除

### 実通信の観測結果（I-094 解消）

DevTools で YouTube 自身のUIから1本削除したときの通信（けんとさん実測）:

```text
POST https://www.youtube.com/youtubei/v1/browse/edit_playlist?prettyPrint=false
{ context: {...}, playlistId: "WL", params: "CAFAAQ%3D%3D",
  actions: [{ setVideoId: "…", action: "ACTION_REMOVE_VIDEO" }] }
→ { "status": "STATUS_SUCCEEDED", … }
```

⚠️ **`params` は設計時の想定に無かった**。決め打ちで書いていれば抜け落ちていたフィールドで、
「外部スクリプトの決め打ちを採用しない」という当初方針がそのまま効いた箇所。
YouTube は `params` を **JSONボディの中でパーセントエンコード済みの文字列として**送るので、
`watch_later_core.js` はその形のまま保持する（デコード・再エンコードしない）。

### 埋め込んだ安全ルール（テストで固定済み）

- **削除できるのは「直前の照合で候補の先頭にある行」だけ**。UI は setVideoId を一切持たず、
  利用者が確認した `videoId` を service worker へ送り返すだけ。worker 側が「先頭候補が本当に
  その動画か」を照合して、違えば何もしない（`confirmation-mismatch`）。
- **照合から10分を超えたら拒否**。setVideoId は他端末での編集で振り直されるため、古い照合の
  IDは別の行を指しうる。
- **削除直前にアカウントを取り直して再照合**。照合時にも確認しているが、照合→削除の間の
  アカウント切替が「別のリストを消す」唯一の経路なので二重に払う。
- **成功は YouTube が明言したときだけ**。`status === 'STATUS_SUCCEEDED'` 以外（200でstatus無し・
  未知のstatus）はすべて「消えたか分からない」として扱う。消えていないのに消えたと報告する方が
  害が大きいため（利用者は再照合で真偽を確認できるが、誤って消したと報告された行は戻せない）。
- **1回成功したら照合結果ごと破棄**。残りの setVideoId も振り直されうるので、次を消すには
  必ず再照合が要る。これが「Round C＝厳密に1件」の実体。
- **通信口は1箇所・パス固定**。`content.js` の `FETCH_INNERTUBE_EDIT_PLAYLIST` だけが
  edit_playlist を叩ける。ボディも再検証し、`playlistId === 'WL'` かつ
  単一の `ACTION_REMOVE_VIDEO` 以外は `refused-unexpected-edit` で拒否する。呼び出し側の
  バグで一括削除・別プレイリストへ広がらないようにするため。

### 変更したファイル

| ファイル | 変更 |
|---|---|
| `watch_later_core.js` | `buildRemoveOneBody` / `isEditPlaylistSuccess` / `selectConfirmedCandidate` を追加 |
| `content.js` | `FETCH_INNERTUBE_EDIT_PLAYLIST`（パス固定・ボディ再検証つきプロキシ） |
| `background.js` | `removeOneWatchLaterRow()` と `REMOVE_ONE_WATCH_LATER`／照合時に Innertube context を保持 |
| `history.html` / `history.js` | 「1件だけ削除」ボタン（既定は無効・照合成功で有効化・動画名を出して確認） |
| `tests/verify_watch_later_core.js` | 43 → **75 チェック**（Round B の「削除は一切しない」ピンを Round C 用に差し替え） |
| `tests/verify_watched_tristate.js` | プロキシ本数のドリフト検査を 3 → 4 に更新 |

テストは `tests/verify_*.js` **全25本 PASS**。dist ホワイトリストは 29件で変化なし。

## まだ確定していないこと

1. ~~fixtureは合成~~ → 実機スモークで実レスポンス整合を確認（2026-08-08）。fixture ファイル自体の
   実データ差し替えは未実施だが、実データをそのまま置くと視聴履歴が混入するため、置くなら
   題名・チャンネル名・サムネイルを落としてからにする。
2. ~~`edit_playlist` の実ヘッダ・payload 未確認~~ → 上記のとおり観測して確定（2026-08-08）。
3. **実機での1件削除は未実施**。コードは書けているが、実際に消して `STATUS_SUCCEEDED` を
   受け取り、再照合で件数が1減ることまでは確認していない。
4. **UIの置き場**。いまは history.html のメンテナンス行に最小構成で置いた。削除対象一覧を
   出す画面（I-044）は未着手。

## 次の手順

1. ~~**実機スモーク（非破壊）**~~ → 2026-08-08 実施・通過（上記「実機スモーク結果」）。
   残: 582 と YouTube 画面表示の本数の目視突合。
2. ~~Round C: 1件削除の実装~~ → 2026-08-08 実装・テスト完了（上記「Round C 実装」）。
   残: **実機で実際に1件消す確認**。手順は 拡張を更新 → YouTubeタブを開く → 履歴ページで
   `照合` → `1件だけ削除` → 確認ダイアログの動画名を見て OK。削除の承認は、この
   ダイアログでけんとさん本人が名前を見て押す形にしてある。
3. Round D: 削除直前の再照合・古い `setVideoId` の再取得・曖昧時停止。
4. Round E/F: 中止・通信失敗・他端末変更、実機スモークとprivacy説明の更新。

## テスト

```bash
node projects/youtube-watched-hider/tests/verify_watch_later_core.js
```

2026-08-07時点で `tests/verify_*.js` 全24本 PASS（新規43チェックを含む）。
